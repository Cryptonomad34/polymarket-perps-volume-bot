// Dry-run executor: simulates fills against real market data. Signs nothing,
// sends nothing.
//
// Fill model
//  - Orders become live after `latencyMs` (so does a cancel; a fill can still
//    happen while a cancel is in flight, as on the real exchange).
//  - Post-only orders that would cross at arrival are rejected.
//  - Resting order: a public trade THROUGH our price fills us fully; a trade AT
//    our price fills us only after the queue ahead is consumed. Queue ahead =
//    book quantity at our price when we joined, shrunk by trades at that price
//    and by the level shrinking (cancels ahead of us).
//  - If the opposite best moves through our price, we're filled at our price.
//  - IOC walks the live book up to its limit; unfilled remainder is dropped.
//  - Reduce-only orders are clamped to the current position.
// Fees use the instrument's maker/taker rates. Funding is charged when each
// instrument's `next_funding` time passes: cost = size * mark * rate.

import { EventEmitter } from "node:events";

export function createSimExec({ insts, books, cfg, log, getPosition, now = () => Date.now() }) {
  const ev = new EventEmitter();
  const orders = new Map(); // coid -> sim order
  const funding = new Map(); // iid -> { rate, mark, next }
  const charged = new Map(); // iid -> funding time already charged
  const latency = cfg.sim.latencyMs;
  const timers = []; // { at, fn }

  const later = (fn) => timers.push({ at: now() + latency, fn });
  // Own clock, independent of the engine loop (which may be awaiting a sim
  // cancel/place when a timer is due).
  const clock = setInterval(() => ev.tick(), 10);
  clock.unref?.();

  function levelQty(levels, price) {
    const l = levels.find(([p]) => p === price);
    return l ? l[1] : 0;
  }

  function fill(o, price, qty, taker) {
    if (qty <= 0) return;
    const inst = insts.get(o.iid);
    o.filled = Math.min(o.qty, o.filled + qty);
    const fee = price * qty * (taker ? inst.takerFee : inst.makerFee);
    ev.emit("fill", { coid: o.coid, iid: o.iid, buy: o.side === "buy", price, qty, fee, taker, tradeId: `sim-${o.coid}-${o.fills++}`, ts: now() });
    if (o.filled >= o.qty - 1e-12) finish(o, "filled");
  }

  function finish(o, reason) {
    if (o.done) return;
    o.done = true;
    orders.delete(o.coid);
    ev.emit("orderDone", { coid: o.coid, reason });
  }

  function clampReduceOnly(o) {
    if (!o.reduceOnly) return o.qty;
    const pos = getPosition(o.iid).size;
    const reduces = o.side === "buy" ? pos < 0 : pos > 0;
    return reduces ? Math.min(o.qty, Math.abs(pos)) : 0;
  }

  function activate(o, resolve) {
    const book = books.get(o.iid);
    const opp = o.side === "buy" ? book.ask : book.bid;
    if (o.tif === "ioc") {
      const want = clampReduceOnly(o);
      if (want <= 0) return resolve({ status: "rejected", error: { kind: "Fatal", code: "reduce only order would increase position" } });
      resolve({ status: "ok" });
      let left = want;
      const levels = o.side === "buy" ? book.asks : book.bids;
      for (const [p, q] of levels) {
        if (left <= 0) break;
        if (o.side === "buy" ? p > o.price : p < o.price) break;
        const take = Math.min(left, q);
        fill(o, p, take, true);
        left -= take;
      }
      finish(o, left > 0 ? "ioc remainder cancelled" : "filled");
      return;
    }
    if (o.postOnly && Number.isFinite(opp) && (o.side === "buy" ? o.price >= opp : o.price <= opp)) {
      return resolve({ status: "rejected", error: { kind: "PostOnlyReject", code: "post only order would cross" } });
    }
    if (o.reduceOnly) o.qty = clampReduceOnly(o) || o.qty;
    const own = o.side === "buy" ? book.bids : book.asks;
    const best = o.side === "buy" ? book.bid : book.ask;
    const better = o.side === "buy" ? o.price > best : o.price < best;
    o.queueAhead = better ? 0 : levelQty(own, o.price);
    o.live = true;
    orders.set(o.coid, o);
    resolve({ status: "ok" });
  }

  return Object.assign(ev, {
    mode: "dry",

    place(order) {
      return new Promise((resolve) => {
        const o = { ...order, filled: 0, fills: 0, live: false, done: false, queueAhead: 0 };
        later(() => activate(o, resolve));
      });
    },

    cancel(coid) {
      return new Promise((resolve) => {
        later(() => {
          const o = orders.get(coid);
          if (!o) return resolve({ status: "ok", note: "already terminal" });
          finish(o, "cancelled");
          resolve({ status: "ok" });
        });
      });
    },

    async cancelInstrument(iid) {
      const coids = [...orders.values()].filter((o) => o.iid === iid).map((o) => o.coid);
      await Promise.all(coids.map((c) => this.cancel(c)));
      return { status: "ok", cancelled: coids.length };
    },

    onTrade(t) {
      for (const o of [...orders.values()]) {
        if (o.iid !== t.iid || !o.live || o.tif === "ioc") continue;
        // A taker buy lifts asks; a taker sell hits bids.
        if (o.side === "sell" && !t.takerBuy) continue;
        if (o.side === "buy" && t.takerBuy) continue;
        const through = o.side === "buy" ? t.price < o.price : t.price > o.price;
        const at = t.price === o.price;
        if (through) fill(o, o.price, o.qty - o.filled, false);
        else if (at) {
          const beyondQueue = t.qty - o.queueAhead;
          o.queueAhead = Math.max(0, o.queueAhead - t.qty);
          if (beyondQueue > 0) fill(o, o.price, Math.min(beyondQueue, o.qty - o.filled), false);
        }
      }
    },

    onBook(iid) {
      const book = books.get(iid);
      for (const o of [...orders.values()]) {
        if (o.iid !== iid || !o.live || o.tif === "ioc") continue;
        const crossed = o.side === "buy" ? book.ask <= o.price : book.bid >= o.price;
        if (crossed) {
          fill(o, o.price, o.qty - o.filled, false);
          continue;
        }
        const own = o.side === "buy" ? book.bids : book.asks;
        o.queueAhead = Math.min(o.queueAhead, levelQty(own, o.price));
      }
    },

    stop() {
      clearInterval(clock);
    },

    tick() {
      // Run due events in scheduling order, so a cancel lands before the
      // replacement order that was queued after it.
      const t = now();
      const due = [];
      for (let i = 0; i < timers.length; ) {
        if (timers[i].at <= t) due.push(timers.splice(i, 1)[0]);
        else i++;
      }
      for (const { fn } of due) fn();
    },

    // Called with /v1/info/tickers rows; charges funding when next_funding passes.
    fundingTick(tickers) {
      const t = now();
      for (const row of tickers) {
        const iid = row.instrument_id;
        if (!insts.has(iid)) continue;
        const prev = funding.get(iid);
        if (prev && t >= prev.next && charged.get(iid) !== prev.next) {
          charged.set(iid, prev.next);
          const pos = getPosition(iid);
          if (pos.size) {
            const cost = pos.size * prev.mark * prev.rate; // positive = we pay
            ev.emit("funding", { iid, cost, rate: prev.rate, size: pos.size, id: `sim-${iid}-${prev.next}`, ts: prev.next });
          }
        }
        funding.set(iid, { rate: Number(row.funding_rate), mark: Number(row.mark_price), next: Number(row.next_funding) });
      }
    },

    openOrders: () => [...orders.values()].map((o) => ({ coid: o.coid, iid: o.iid, side: o.side, price: o.price, qty: o.qty, filled: o.filled })),
    log,
  });
}
