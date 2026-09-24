// Cost-aware flattening (pure). The main cost lever of the bot.
//
//   1. passive   reduce-only post-only at the best exit price for passiveSec
//                (re-pegged when the best moves) -> exits at maker fee
//   2. extended  if still open and the mid moved in our favour since the
//                decision, extend ONCE for extendSec
//   3. taker     reduce-only IOC, limit = best exit price +/- iocSlippageBps,
//                repeated every iocRetryMs until flat
// Total hold from position open is capped at maxHoldSec; liquidation distance
// below liqDistancePct skips straight to taker. Once started, a flatten runs
// until the position is flat, even if the trigger condition goes away.

import { roundPrice, roundQty, tickAt } from "./precision.mjs";

export const IDLE = Object.freeze({ phase: "idle" });

export function liquidationDistancePct(position, mid) {
  if (!Number.isFinite(position.liqPrice) || !(position.liqPrice > 0) || !(mid > 0)) return Infinity;
  return (Math.abs(mid - position.liqPrice) / mid) * 100;
}

export function flattenTrigger({ position, mid, now, cfg }) {
  if (!position.size) return null;
  if (liquidationDistancePct(position, mid) < cfg.flatten.liqDistancePct) return "liquidation distance";
  if (Math.abs(position.notional) > cfg.inventory.maxNotionalUsd) return "inventory cap";
  if (now - position.openedAt > cfg.flatten.maxPositionAgeSec * 1000) return "position age";
  return null;
}

function exitSide(size) {
  return size > 0 ? "sell" : "buy";
}

/**
 * @param {object} p
 * @param {{iid, priceDecimals, quantityDecimals, minNotional}} p.inst
 * @param {{size:number, notional:number, entryPrice:number, openedAt:number, liqPrice?:number}} p.position
 * @param {{bid:number, ask:number}} p.book
 * @param {object} p.fstate   previous state from this function (IDLE initially)
 * @param {boolean} p.force   start immediately in taker phase (risk stop)
 * @returns {{ fstate, standing: object|null, ioc: object|null, reason: string }}
 *   standing: desired resting reduce-only post-only order (engine keeps one)
 *   ioc:      reduce-only IOC to send now
 */
export function decideFlatten({ inst, position, book, fstate = IDLE, now, cfg, force = false }) {
  const f = cfg.flatten;
  const size = position.size;
  const mid = (book.bid + book.ask) / 2;
  const bookOk = Number.isFinite(mid) && book.ask > book.bid;

  if (!size) return { fstate: IDLE, standing: null, ioc: null, reason: "flat" };

  // Dust that can't be expressed as a valid order: leave it, don't loop.
  const qty = roundQty(Math.abs(size), inst.quantityDecimals);
  if (qty === 0) return { fstate: { phase: "dust", size }, standing: null, ioc: null, reason: "dust below order precision" };
  if (fstate.phase === "dust" && fstate.size === size) return { fstate, standing: null, ioc: null, reason: "dust" };

  let s = fstate.phase === "dust" ? IDLE : fstate;
  const side = exitSide(size);
  const heldMs = now - position.openedAt;
  const liqClose = liquidationDistancePct(position, mid) < f.liqDistancePct;

  if (s.phase === "idle") {
    const trigger = force ? "forced" : flattenTrigger({ position, mid, now, cfg });
    if (!trigger) return { fstate: IDLE, standing: null, ioc: null, reason: "no trigger" };
    const taker = force || liqClose || heldMs >= f.maxHoldSec * 1000;
    s = { phase: taker ? "taker" : "passive", startedAt: now, decisionMid: mid, extended: false, trigger, lastIocAt: 0 };
  }

  if (!bookOk) return { fstate: s, standing: null, ioc: null, reason: "waiting for a usable book" };

  // Hard caps that escalate straight to taker.
  if (s.phase !== "taker" && (liqClose || heldMs >= f.maxHoldSec * 1000)) {
    s = { ...s, phase: "taker", escalated: liqClose ? "liquidation distance" : "max hold" };
  }

  if (s.phase === "passive") {
    if (now - s.startedAt < f.passiveSec * 1000) return { fstate: s, standing: passiveOrder(inst, side, book, qty), ioc: null, reason: "passive exit" };
    if (!s.extended && f.extendSec > 0 && favourable(position, s.decisionMid, mid, inst)) {
      s = { ...s, phase: "extended", extended: true, extendedAt: now };
    } else {
      s = { ...s, phase: "taker", escalated: "passive window elapsed" };
    }
  }

  if (s.phase === "extended") {
    if (now - s.extendedAt < f.extendSec * 1000) return { fstate: s, standing: passiveOrder(inst, side, book, qty), ioc: null, reason: "extended passive exit" };
    s = { ...s, phase: "taker", escalated: "extension elapsed" };
  }

  // taker
  if (now - (s.lastIocAt ?? 0) < f.iocRetryMs) return { fstate: s, standing: null, ioc: null, reason: "waiting before next IOC" };
  const capFrac = f.iocSlippageBps / 10_000;
  const limit = side === "sell" ? roundPrice(book.bid * (1 - capFrac), inst.priceDecimals, "sell") : roundPrice(book.ask * (1 + capFrac), inst.priceDecimals, "buy");
  return {
    fstate: { ...s, lastIocAt: now },
    standing: null,
    ioc: { side, price: limit, qty, tif: "ioc", postOnly: false, reduceOnly: true, intent: "flatten-ioc", decisionMid: mid },
    reason: s.escalated ? `taker exit (${s.escalated})` : "taker exit",
  };
}

function passiveOrder(inst, side, book, qty) {
  const best = side === "sell" ? book.ask : book.bid;
  return { side, price: roundPrice(best, inst.priceDecimals, side), qty, tif: "gtc", postOnly: true, reduceOnly: true, intent: "flatten-post" };
}

// Favourable: price moved our way by at least one tick since the decision,
// and the position is not under water.
function favourable(position, decisionMid, mid, inst) {
  const tick = tickAt(mid, inst.priceDecimals);
  const long = position.size > 0;
  const moved = long ? mid - decisionMid >= tick : decisionMid - mid >= tick;
  const unrealized = (mid - position.entryPrice) * position.size;
  return moved && unrealized >= 0;
}

