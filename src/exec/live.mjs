// Live executor: real post-only GTC quotes, cancel/replace, reduce-only IOC.
// The exchange is the source of truth: startup and every reconcile pull open
// orders, fills and portfolio from REST; the WebSocket `fills`/`orders`
// channels give low-latency updates in between.
//
// Emits the same events as sim.mjs: "fill", "orderDone", "funding", plus
// "reconciled"(snapshot) and "apiError"(ApiError).

import { EventEmitter } from "node:events";
import { itemError } from "../api.mjs";
import { toDecimalString } from "../precision.mjs";

const TERMINAL_CANCEL = /order_already_terminal|order_not_found|order_not_in_orderbook|order_unknown/i;

export function createLiveExec({ api, insts, log, marketdata }) {
  const ev = new EventEmitter();
  const byCoid = new Map(); // coid -> { coid, oid, iid, side, qty, filled, tif, done }
  const byOid = new Map(); // oid -> coid
  const seenTrades = new Set();
  let lastFillTs = Date.now(); // only fills from this session onward; earlier ones are history

  function track(o) {
    byCoid.set(o.coid, o);
    if (o.oid !== undefined) byOid.set(o.oid, o.coid);
  }

  function done(coid, reason) {
    const o = byCoid.get(coid);
    if (!o || o.done) return;
    o.done = true;
    ev.emit("orderDone", { coid, reason });
  }

  // A fill can arrive on the WS and again from REST. Dedupe by trade id, and
  // also by (order id, price, qty, time) in case the two ids ever differ.
  const recent = []; // { oid, price, qty, ts, matched }
  function isDuplicate(f) {
    if (f.tradeId !== undefined && seenTrades.has(String(f.tradeId))) return true;
    const ts = Number(f.ts) || Date.now();
    const twin = recent.find((r) => !r.matched && r.source !== f.source && r.oid === f.oid && r.price === f.price && r.qty === f.qty && Math.abs(r.ts - ts) < 10_000);
    if (twin) {
      twin.matched = true;
      if (f.tradeId !== undefined) seenTrades.add(String(f.tradeId));
      return true;
    }
    return false;
  }

  function emitFill(f) {
    if (isDuplicate(f)) return;
    if (f.tradeId !== undefined) seenTrades.add(String(f.tradeId));
    recent.push({ oid: f.oid, price: f.price, qty: f.qty, ts: Number(f.ts) || Date.now(), source: f.source, matched: false });
    if (recent.length > 500) recent.splice(0, recent.length - 500);
    const coid = f.coid ?? byOid.get(f.oid);
    const o = coid ? byCoid.get(coid) : null;
    const taker = f.taker ?? (o ? o.tif === "ioc" : undefined);
    lastFillTs = Math.max(lastFillTs, Number(f.ts) || 0);
    ev.emit("fill", { ...f, coid, taker: Boolean(taker), foreign: !o });
    if (o) {
      o.filled += f.qty;
      if (o.filled >= o.qty - 1e-12) done(o.coid, "filled");
    }
  }

  marketdata.on("fill", (f) => emitFill(f));
  marketdata.on("order", (u) => {
    const coid = u.coid ?? byOid.get(u.oid);
    if (!coid) return;
    const o = byCoid.get(coid);
    if (o && u.oid !== undefined && o.oid === undefined) track({ ...o, oid: u.oid });
    if (Number.isFinite(u.resting) && u.resting <= 0) done(coid, `exchange status ${u.status}`);
  });

  function orderPayload(order) {
    return {
      iid: order.iid,
      buy: order.side === "buy",
      price: toDecimalString(order.price),
      qty: toDecimalString(order.qty),
      tif: order.tif,
      postOnly: order.postOnly,
      reduceOnly: order.reduceOnly,
      coid: order.coid,
    };
  }

  async function findOnExchange(coid, iid) {
    const open = await api.openOrders(iid);
    return (open ?? []).find((x) => x.client_order_id === coid) ?? null;
  }

  return Object.assign(ev, {
    mode: "live",

    async place(order) {
      track({ coid: order.coid, iid: order.iid, side: order.side, qty: order.qty, filled: 0, tif: order.tif, done: false, placedAt: Date.now() });
      try {
        const { data } = await api.createOrders([orderPayload(order)]);
        const item = Array.isArray(data) ? data[0] : data;
        const err = itemError(item);
        if (err) {
          done(order.coid, `rejected: ${err.code}`);
          return { status: "rejected", error: err };
        }
        track({ ...byCoid.get(order.coid), oid: item.oid });
        if (order.tif === "ioc") setTimeout(() => done(order.coid, "ioc complete"), 3000);
        return { status: "ok", oid: item.oid };
      } catch (e) {
        if (e.indeterminate) {
          // Might have been applied. Look it up by coid before deciding anything.
          log.warn("order placement indeterminate; reconciling by coid", { coid: order.coid, error: e.code });
          try {
            const found = await findOnExchange(order.coid, order.iid);
            if (found) {
              track({ ...byCoid.get(order.coid), oid: found.order_id });
              return { status: "ok", oid: found.order_id, recovered: true };
            }
          } catch (e2) {
            log.warn("coid lookup failed", { coid: order.coid, error: e2.message });
          }
          return { status: "unknown", error: e };
        }
        done(order.coid, `error: ${e.code ?? e.message}`);
        return { status: "rejected", error: e };
      }
    },

    async cancel(coid) {
      try {
        const { data } = await api.cancelOrdersCOID([coid]);
        const item = Array.isArray(data) ? data[0] : data;
        const err = itemError(item);
        if (err && TERMINAL_CANCEL.test(err.code)) {
          done(coid, "already terminal");
          return { status: "ok", note: err.code };
        }
        if (err) return { status: "rejected", error: err };
        done(coid, "cancelled");
        return { status: "ok" };
      } catch (e) {
        return { status: "rejected", error: e };
      }
    },

    async cancelInstrument(iid) {
      try {
        await api.cancelAll(iid);
        for (const o of byCoid.values()) if (o.iid === iid) done(o.coid, "cancel all");
        return { status: "ok" };
      } catch (e) {
        return { status: "rejected", error: e };
      }
    },

    tick() {},

    // Pull exchange truth. Returns { positions, openOrders, marginUsed, foreign }.
    async reconcile({ iids, sinceTs }) {
      // When the portfolio request left. A fill that lands after this moment is
      // not reflected in the response, so the caller must not adopt it blindly.
      const requestedAt = Date.now();
      const [portfolio, fills, ...open] = await Promise.all([
        api.portfolio(),
        api.fills({ start: Math.max(0, (lastFillTs || sinceTs) - 60_000) }),
        ...iids.map((iid) => api.openOrders(iid)),
      ]);

      for (const f of fills ?? []) {
        if (!iids.includes(f.instrument_id)) continue;
        emitFill({
          tradeId: f.trade_id,
          oid: f.order_id,
          iid: f.instrument_id,
          buy: f.side === "long" || f.side === "buy",
          price: Number(f.price),
          qty: Number(f.quantity),
          fee: Number(f.fee),
          taker: Boolean(f.taker),
          ts: f.timestamp,
          source: "rest",
        });
      }

      const openList = open.flat().filter(Boolean);
      const openCoids = new Set(openList.map((o) => o.client_order_id));
      for (const o of byCoid.values()) {
        // Grace period: a just-acknowledged order may not be listed yet.
        // Orders with an unknown outcome (no oid) get a longer window.
        const age = Date.now() - o.placedAt;
        const grace = o.oid !== undefined ? 5000 : 15000;
        if (!o.done && !openCoids.has(o.coid) && o.tif !== "ioc" && age > grace) done(o.coid, "not open on exchange");
      }
      const foreign = openList.filter((o) => !byCoid.has(o.client_order_id));

      const positions = {};
      for (const p of portfolio?.positions ?? []) {
        if (!iids.includes(p.instrument_id)) continue;
        positions[p.instrument_id] = {
          size: Number(p.size),
          entryPrice: Number(p.entry_price),
          liqPrice: Number(p.liquidation_price),
          leverage: p.leverage,
          cross: p.cross,
          cumulativeFunding: Number(p.cumulative_funding),
        };
      }
      const snapshot = {
        requestedAt,
        positions,
        openOrders: openList,
        foreign,
        marginUsed: Number(portfolio?.margin?.total_initial_margin ?? NaN),
        equity: Number(portfolio?.margin?.total_account_value ?? NaN),
        feeTier: portfolio?.fee_tier,
        inLiquidation: Boolean(portfolio?.in_liquidation),
      };
      ev.emit("reconciled", snapshot);
      return snapshot;
    },

    // Funding payments since `start`; cost > 0 means we paid.
    async pollFunding({ start, seen }) {
      const rows = await api.funding({ start });
      for (const r of rows) {
        const id = String(r.id);
        if (seen.has(id) || !insts.has(r.instrument_id)) continue;
        seen.add(id);
        const size = Number(r.size);
        const rate = Number(r.funding_rate);
        const amount = Math.abs(Number(r.funding));
        // Longs pay when the rate is positive; derive the sign from the payment itself.
        const cost = Math.sign(size * rate) * amount;
        ev.emit("funding", { iid: r.instrument_id, cost, rate, size, id, ts: r.timestamp });
      }
    },

    forget(coid) {
      const o = byCoid.get(coid);
      if (o?.oid !== undefined) byOid.delete(o.oid);
      byCoid.delete(coid);
    },
  });
}
