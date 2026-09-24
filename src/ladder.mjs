// Quoting for strategy.mode "fair" (pure): a resting ladder around fair value.
//
// The "join" strategy (src/strategy.mjs) joins the best bid/ask and cancels
// and re-joins whenever the best price moves. That leaves it permanently at
// the BACK of the queue, and in a one-tick book the back of the queue only
// fills when the whole level is being cleared - which is exactly when the
// price is about to move through it. This module does what profitable makers
// do instead:
//
//   1. Price from fair value (src/fairvalue.mjs), never from the local best.
//      Level i rests at fair -/+ (edgeBps + i * levelStepBps), and never at
//      or through the opposite best (post-only).
//   2. Keep queue priority. An order that is still safe and still useful is
//      NEVER cancelled or re-priced, however the best price moves. It waits
//      for the market to come to it, and by then it is at the front.
//   3. Cancel only when an order becomes unsafe: fair value has come within
//      cancelEdgeBps of it (or through it). engine.mjs also runs this check
//      on every reference tick (unsafeOrders), not just every loop.
//   4. Inventory shifts fair value (see fairvalue.mjs) instead of switching
//      a side off. The only hard limit is the cap: the position after every
//      resting order on one side filled must stay within
//      inventory.maxNotionalUsd.
//
// With no usable fair value (reference down, stale or warming), or once the
// cost budget is spent, it only works an existing position off: one
// reduce-only-sized order on the reducing side, priced off the microprice.
//
// decideLadder(p) -> { actions: [{ type: "cancel"|"place", side, ... }], fair }

import { microprice } from "./fairvalue.mjs";
import { qtyForNotional, roundPrice, roundQty, tickAt } from "./precision.mjs";
import { SIDES, bookIsUsable } from "./strategy.mjs";

const EPS = 1e-9;
const bpsOf = (price, bps) => (price * bps) / 1e4;
const notOver = (o) => o.status !== "done";

/** Still safe to leave resting: fair value is not within cancelEdgeBps of it. */
export function orderIsSafe(side, price, fair, cfg) {
  const guard = bpsOf(fair, cfg.fair.cancelEdgeBps);
  return side === "buy" ? price <= fair - guard + EPS : price >= fair + guard - EPS;
}

/** Still worth keeping: not so far from fair value that it will never fill. */
export function orderIsUseful(side, price, fair, cfg) {
  const far = bpsOf(fair, cfg.fair.maxDistanceBps);
  return side === "buy" ? price >= fair - far - EPS : price <= fair + far + EPS;
}

/**
 * Live orders that fair value now threatens. Used on every reference tick,
 * so it looks only at orders the exchange has acknowledged: a pending order
 * is left to the loop (cancelling an unacknowledged order can be rejected).
 */
export function unsafeOrders({ fair, orders, cfg }) {
  const out = [];
  if (!(fair > 0)) return out;
  for (const side of SIDES) {
    for (const o of orders?.[side] ?? []) {
      if (o.status === "live" && !orderIsSafe(side, o.price, fair, cfg)) out.push({ side, coid: o.coid, price: o.price });
    }
  }
  return out;
}

/**
 * How much may rest on `side` in total, and in what unit.
 *   normal       USD notional, enough that the position after all of it
 *                fills stays within the cap
 *   reduce-only  base quantity, at most the position itself, so nothing can
 *                flip it (measured in quantity so an exit priced above the
 *                mid still covers the whole position, leaving no dust)
 * `of(order-like)` measures an order in the same unit.
 */
export function sideCapacity(side, position, cap, reduceOnly) {
  if (reduceOnly) {
    const reduces = side === "buy" ? position.size < 0 : position.size > 0;
    return { limit: reduces ? Math.abs(position.size) : 0, of: (qty) => qty };
  }
  const n = position.notional;
  return { limit: side === "buy" ? Math.max(0, cap - n) : Math.max(0, cap + n), of: (qty, price) => qty * price };
}

/** Target prices for each ladder level on one side, best level first. */
export function targetPrices({ side, anchor, book, inst, cfg, levels }) {
  const f = cfg.fair;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < levels; i++) {
    const dist = bpsOf(anchor, f.edgeBps + i * f.levelStepBps);
    let raw = side === "buy" ? anchor - dist : anchor + dist;
    // Post-only: never at or through the opposite best. In a wide book this
    // is what lets the ladder step inside the spread when fair value allows.
    raw = side === "buy" ? Math.min(raw, book.ask - tickAt(book.ask, inst.priceDecimals)) : Math.max(raw, book.bid + tickAt(book.bid, inst.priceDecimals));
    const price = roundPrice(raw, inst.priceDecimals, side); // bids down, asks up: never more aggressive
    if (!(price > 0) || seen.has(price)) continue;
    seen.add(price);
    out.push({ price, level: i });
  }
  return out;
}

/**
 * @param {object} p
 * @param {{priceDecimals:number, quantityDecimals:number, minNotional:number}} p.inst
 * @param {{bid:number, ask:number, bidQty?:number, askQty?:number}} p.book
 * @param {{size:number, notional:number}} p.position   notional signed (size * mid)
 * @param {{buy:object[], sell:object[]}} p.orders       our ladder orders: {coid, price, qty, remaining, status, level}
 * @param {{ok:boolean, fair?:number, reason?:string}|null} p.fairView  from fairValue()
 * @param {boolean} p.canOpen     false once the cost budget is spent or trading is halted
 * @param {boolean} p.flattening  flatten.mjs owns the instrument
 * @param {string|null} p.blocked e.g. stale data or foreign orders
 * @param {object} p.cfg
 */
export function decideLadder(p) {
  const { inst, book, position, orders, fairView, canOpen, flattening, blocked, cfg } = p;
  const actions = [];
  const cancel = (side, o, reason) => {
    if (o.status === "live" || o.status === "pending") actions.push({ type: "cancel", side, coid: o.coid, reason });
  };
  const cancelAll = (reason) => {
    for (const side of SIDES) for (const o of orders?.[side] ?? []) cancel(side, o, reason);
    return { actions, fair: null };
  };

  if (flattening) return cancelAll("flatten owns instrument");
  if (blocked) return cancelAll(blocked);
  if (!bookIsUsable(book)) return cancelAll("book unusable (empty, locked or crossed)");

  const haveFair = Boolean(fairView?.ok && fairView.fair > 0);
  const reduceOnly = !canOpen || !haveFair;
  const anchor = haveFair ? fairView.fair : microprice(book);
  const whyReduceOnly = !canOpen ? "cost budget spent or trading halted" : `no fair value (${fairView?.reason ?? "no reference"})`;
  const cap = cfg.inventory.maxNotionalUsd;
  const levels = reduceOnly ? 1 : cfg.fair.levels;

  for (const side of SIDES) {
    const mine = (orders?.[side] ?? []).filter(notOver);
    const opposite = (orders?.[side === "buy" ? "sell" : "buy"] ?? []).filter(notOver);
    const capacity = sideCapacity(side, position, cap, reduceOnly);

    // Keep or cancel what is resting, most aggressive first, so that when the
    // cap forces a cut it is the deepest orders that go.
    const byAggression = [...mine].sort((a, b) => (side === "buy" ? b.price - a.price : a.price - b.price));
    let used = 0;
    const kept = [];
    for (const o of byAggression) {
      const exposure = capacity.of(o.remaining ?? o.qty, o.price);
      if (o.status === "cancelling") {
        // Can still fill until the cancel lands: it counts, but is not ours to act on.
        used += exposure;
        kept.push(o);
        continue;
      }
      let why = null;
      if (!orderIsSafe(side, o.price, anchor, cfg)) why = haveFair ? `unsafe: fair ${anchor.toFixed(inst.priceDecimals)}` : "unsafe vs microprice (no fair value)";
      else if (!orderIsUseful(side, o.price, anchor, cfg)) why = `more than ${cfg.fair.maxDistanceBps} bps from fair`;
      else if (used + exposure > capacity.limit + EPS) why = reduceOnly ? `reduce only: ${whyReduceOnly}` : `inventory cap $${cap}`;
      if (why) cancel(side, o, why);
      else {
        used += exposure;
        kept.push(o);
      }
    }

    // Fill empty slots. A kept order stays where it is - that is its queue.
    let slots = levels - kept.length;
    if (slots <= 0) continue;
    const oppositeBest = opposite.length ? (side === "buy" ? Math.min(...opposite.map((o) => o.price)) : Math.max(...opposite.map((o) => o.price))) : NaN;
    for (const t of targetPrices({ side, anchor, book, inst, cfg, levels })) {
      if (slots <= 0) break;
      if (kept.some((k) => k.price === t.price)) continue;
      // Self-trade guard: never at or through one of our own opposite orders,
      // including one still being cancelled (it can still fill).
      if (Number.isFinite(oppositeBest) && (side === "buy" ? t.price >= oppositeBest : t.price <= oppositeBest)) continue;

      // Reduce-only works off the whole position in one order, so no dust is
      // left for the taker backstop; otherwise every level is one quote size.
      const qty = reduceOnly ? roundQty(capacity.limit - used, inst.quantityDecimals) : qtyForNotional(cfg.quote.notionalUsd, t.price, inst.quantityDecimals, inst.minNotional);
      if (!(qty > 0) || qty * t.price < inst.minNotional - EPS) break;
      if (used + capacity.of(qty, t.price) > capacity.limit + EPS) break;
      used += capacity.of(qty, t.price);
      slots--;
      actions.push({
        type: "place",
        side,
        price: t.price,
        qty,
        level: t.level,
        fair: anchor,
        intent: side === "buy" ? "quote-bid" : "quote-ask",
        reason: reduceOnly ? `reduce: ${whyReduceOnly}` : `ladder L${t.level} @ fair ${side === "buy" ? "-" : "+"}${(cfg.fair.edgeBps + t.level * cfg.fair.levelStepBps).toFixed(2)} bps`,
      });
    }
  }
  return { actions, fair: haveFair ? anchor : null };
}
