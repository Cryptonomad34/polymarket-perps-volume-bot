// Quoting logic (pure). Joins the best bid and best ask with post-only orders,
// never crosses, debounces sub-tick noise, respects inventory caps and the
// daily cost budget, and hands the instrument to flatten.mjs while it works.
//
// Inventory skew: holding a position is not a problem to be dumped. Above
// inventory.skewAtUsd the opening side stops quoting and the reducing side is
// sized to the whole position, so the exit is a maker fill that earns the
// rebate instead of a taker fill that pays the spread plus the taker fee.
// flatten.mjs is then only a backstop (cap, age, liquidation distance).
//
// Reference gate: when an external price feed says Polymarket has lagged and
// is about to move, the side that would be picked off stops quoting until it
// catches up (see src/reference.mjs). It applies ONLY to the side that would
// grow the position. Gating the reducing side would strand inventory until
// flatten.mjs forced a taker exit, which costs the 2 bps taker fee plus the
// spread - far more than the adverse selection it would avoid.
//
// decideQuotes(input) -> { actions: [{ type: "cancel"|"place", side, ... }] }

import { qtyForNotional, roundPrice, roundQty, tickAt } from "./precision.mjs";
import { warnedSide } from "./reference.mjs";

export const SIDES = ["buy", "sell"];

// A side "opens" when a fill there would grow |position|.
export function isOpeningSide(side, positionSize) {
  return side === "buy" ? positionSize >= 0 : positionSize <= 0;
}

export function bookIsUsable(book) {
  return Number.isFinite(book?.bid) && Number.isFinite(book?.ask) && book.bid > 0 && book.ask > book.bid;
}

/**
 * @param {object} p
 * @param {{iid:number, priceDecimals:number, quantityDecimals:number, minNotional:number}} p.inst
 * @param {{bid:number, ask:number}} p.book
 * @param {{size:number, notional:number}} p.position  notional is signed (size * mid)
 * @param {{buy:object|null, sell:object|null}} p.quotes  our quote orders: {coid, price, qty, status}
 * @param {{buy:number, sell:number}} p.bestSince  when the current best price on each side first appeared
 * @param {{buy:number, sell:number}} p.lastReplaceAt
 * @param {boolean} p.canOpen      false once the cost budget is spent or trading is halted
 * @param {boolean} p.flattening   flatten.mjs owns the instrument
 * @param {boolean} p.blocked      e.g. stale data or foreign orders on this instrument
 * @param {number} p.now
 * @param {{ok:boolean, acting?:boolean, edgeBps:number}|null} p.ref  external reference signal, if any
 * @param {object} p.cfg           full config (uses quote.*, inventory.*, reference.*)
 */
export function decideQuotes(p) {
  const { inst, book, position, quotes, bestSince, lastReplaceAt, canOpen, flattening, blocked, now, cfg, ref = null } = p;
  const actions = [];
  const cancel = (side, reason) => {
    const q = quotes[side];
    if (q && (q.status === "live" || q.status === "pending")) actions.push({ type: "cancel", side, coid: q.coid, reason });
  };

  if (flattening) {
    for (const side of SIDES) cancel(side, "flatten owns instrument");
    return { actions };
  }
  if (blocked) {
    for (const side of SIDES) cancel(side, blocked);
    return { actions };
  }
  if (!bookIsUsable(book)) {
    for (const side of SIDES) cancel(side, "book unusable (empty, locked or crossed)");
    return { actions };
  }

  const cap = cfg.inventory.maxNotionalUsd;
  const quoteNotional = cfg.quote.notionalUsd;
  const skewAt = cfg.inventory.skewAtUsd ?? cap;
  const signals = adverseSignals(p);
  const adverse = {};
  for (const side of SIDES) {
    // Hysteresis: once a side backs off it stays backed off for holdMs.
    adverse[side] = signals[side] ?? (now < (p.adverseUntil?.[side] ?? 0) ? "holding back-off" : null);
  }

  for (const side of SIDES) {
    const best = side === "buy" ? book.bid : book.ask;
    const tick = tickAt(best, inst.priceDecimals);
    const back = adverse[side] ? cfg.quote.adverse.backoffTicks * tick : 0;
    const price = roundPrice(side === "buy" ? best - back : best + back, inst.priceDecimals, side);
    const existing = quotes[side];
    const opening = isOpeningSide(side, position.size);
    const signed = side === "buy" ? quoteNotional : -quoteNotional;

    let want = true;
    let why = "";
    if (opening && !canOpen) {
      want = false;
      why = "cost budget spent or trading halted";
    } else if (opening && Math.abs(position.notional) >= skewAt) {
      // Skewed: only the reducing side quotes until the position is worked off.
      want = false;
      why = `inventory skew $${skewAt}`;
    } else if (opening && Math.abs(position.notional + signed) > cap) {
      want = false;
      why = `inventory cap $${cap}`;
    } else if (opening && refWarns(ref, side, cfg)) {
      want = false;
      why = `reference: ${ref.edgeBps > 0 ? "about to rise" : "about to fall"} ${ref.edgeBps.toFixed(2)} bps`;
    }

    // Self-trade guard: our bid must stay strictly below our own ask, including
    // an opposite quote that is still being cancelled (it can still fill).
    const other = quotes[side === "buy" ? "sell" : "buy"];
    if (want && other && other.status !== "done") {
      const crosses = side === "buy" ? price >= other.price : price <= other.price;
      if (crosses) {
        want = false;
        why = "would cross our own opposite quote";
      }
    }

    if (!want) {
      cancel(side, why);
      continue;
    }

    // On the reducing side, quote the whole position so one fill leaves us
    // flat and no dust is left behind for the taker backstop to clean up.
    const exitQty = opening ? 0 : roundQty(Math.abs(position.size), inst.quantityDecimals);
    const qty = exitQty && exitQty * price >= inst.minNotional ? exitQty : qtyForNotional(quoteNotional, price, inst.quantityDecimals, inst.minNotional);
    const placeReason = adverse[side] ? `back off: ${adverse[side]}` : opening ? "join best" : "reduce at best";
    if (!existing || existing.status === "done") {
      actions.push({ type: "place", side, price, qty, intent: side === "buy" ? "quote-bid" : "quote-ask", reason: placeReason });
      continue;
    }
    if (existing.status !== "live") continue; // pending or cancelling: wait for it to settle
    // The position changed under a resting reduce quote: resize it.
    const resting = existing.remaining ?? existing.qty;
    if (existing.price === price && Math.abs(resting - qty) > 1e-12 && !opening) {
      actions.push({ type: "cancel", side, coid: existing.coid, reason: `resize ${resting} -> ${qty}` });
      actions.push({ type: "place", side, price, qty, intent: side === "buy" ? "quote-bid" : "quote-ask", reason: "resize to position", replaces: existing.coid });
      continue;
    }
    if (existing.price === price) continue; // still at the best level

    // Best moved. Only chase once the new level has persisted and we're not
    // replacing faster than minReplaceMs, so sub-tick flicker costs nothing.
    const settled = now - (bestSince?.[side] ?? 0) >= cfg.quote.debounceMs;
    const paced = now - (lastReplaceAt?.[side] ?? 0) >= cfg.quote.minReplaceMs;
    if (settled && paced) {
      actions.push({ type: "cancel", side, coid: existing.coid, reason: `target moved ${existing.price} -> ${price}` });
      actions.push({ type: "place", side, price, qty, intent: side === "buy" ? "quote-bid" : "quote-ask", reason: adverse[side] ? placeReason : "rejoin best", replaces: existing.coid });
    }
  }
  return { actions, adverse: signals };
}

/**
 * True when the external reference warns that a fill on `side` is about to be
 * run over. Requires a usable signal AND `acting`, so "observe" mode measures
 * the signal without ever changing a decision.
 */
export function refWarns(ref, side, cfg) {
  if (!ref?.ok || !ref.acting) return false;
  return warnedSide(ref.edgeBps, cfg.reference.gateBps) === side;
}

/**
 * Adverse-selection signals (pure). A side is "adverse" when a fill there is
 * likely to be followed by the price moving through us; that side then quotes
 * `backoffTicks` behind the best instead of joining it.
 *   thin queue   our side's best level is small in USD -> about to be swept
 *   imbalance    our side holds < (1 - imbalance) of the top-of-book size
 *   flow         recent taker flow is one-sided against our side
 *   inventory    we already hold a position: don't add at the touch
 * In live mode the public book includes our own order; it is subtracted.
 */
export function adverseSignals({ book, position, quotes, flow, cfg, bookIncludesOwn = false }) {
  const a = cfg.quote.adverse;
  const out = { buy: null, sell: null };
  if (!a?.enabled) return out;

  const own = (side) => {
    const q = quotes?.[side];
    const best = side === "buy" ? book.bid : book.ask;
    return bookIncludesOwn && q && q.status === "live" && q.price === best ? q.qty : 0;
  };
  const bidQty = Math.max(0, (book.bidQty ?? 0) - own("buy"));
  const askQty = Math.max(0, (book.askQty ?? 0) - own("sell"));
  const flag = (side, why) => {
    out[side] ??= why;
  };

  if (bidQty * book.bid < a.minQueueUsd) flag("buy", "thin bid queue");
  if (askQty * book.ask < a.minQueueUsd) flag("sell", "thin ask queue");

  const total = bidQty + askQty;
  if (total > 0) {
    const bidShare = bidQty / total;
    if (bidShare < 1 - a.imbalance) flag("buy", "book leaning down");
    if (bidShare > a.imbalance) flag("sell", "book leaning up");
  }

  const flowTotal = (flow?.buyUsd ?? 0) + (flow?.sellUsd ?? 0);
  if (flowTotal >= a.minFlowUsd) {
    const buyShare = flow.buyUsd / flowTotal;
    if (buyShare > a.flowRatio) flag("sell", "aggressive buying");
    if (buyShare < 1 - a.flowRatio) flag("buy", "aggressive selling");
  }

  if (a.inventoryBackoff && Math.abs(position.notional) >= cfg.quote.notionalUsd / 2) {
    flag(position.size > 0 ? "buy" : "sell", "holding inventory");
  }
  return out;
}
