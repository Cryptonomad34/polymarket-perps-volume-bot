// The trading loop. Wires market data -> strategy/flatten -> executor (sim or
// live), and keeps the accounting, risk checks, state file and reports.
//
// The bot is always in one of two conditions, and the log says which:
//   trading   quoting/flattening normally
//   stopped   a risk limit tripped: orders cancelled, position flattened,
//             nothing new until 00:00 UTC (reason logged and persisted)

import { makeCoid } from "./coid.mjs";
import { decideFlatten, IDLE, liquidationDistancePct } from "./flatten.mjs";
import { mid as bookMid } from "./marketdata.mjs";
import { autoCancelHeadroomLow, evaluate, netPnl } from "./risk.mjs";
import { computeSummary, formatSummary } from "./report.mjs";
import { emptyDaily, utcDay } from "./state.mjs";
import { SIDES, bookIsUsable, decideQuotes, fastPullSides } from "./strategy.mjs";

const LOOP_MS = 200;
const RECONCILE_MS = 10_000;
const FUNDING_POLL_MS = 60_000;
const MAINTENANCE_PAUSE_MS = 5_000;
// How long to hold off on flatten orders after a stale reduce-only reject,
// so the forced reconcile can land first.
const STALE_RESYNC_PAUSE_MS = 3_000;

// True when an exchange position snapshot is new enough to trust. A snapshot
// requested before our last fill cannot know about that fill, so adopting it
// would resurrect a position we have already closed (and send reduce-only
// orders the exchange rejects as `reduce_only_invalid`).
export function snapshotIsFresh(requestedAt, positionChangedAt) {
  return !(positionChangedAt > (requestedAt ?? 0));
}

export function createEngine({ cfg, mode, insts, api, md, exec, store, state, reporter, log, creds = null, reference = null }) {
  const iids = [...insts.keys()];
  const orders = new Map(); // coid -> order record
  const per = new Map(
    iids.map((iid) => [
      iid,
      {
        quotes: { buy: null, sell: null }, // coid
        flattenCoid: null,
        fstate: IDLE,
        bestSince: { buy: 0, sell: 0 },
        lastBest: { buy: NaN, sell: NaN },
        lastReplaceAt: { buy: 0, sell: 0 },
        staleSince: null,
        foreignOrders: 0,
        liqPrice: NaN,
        flow: [], // recent public trades: { ts, takerBuy, usd }
        adverseUntil: { buy: 0, sell: 0 },
        positionChangedAt: 0, // last local position change from a fill
        flattenPausedUntil: 0, // set when the exchange rejects a stale reduce-only
      },
    ]),
  );

  for (const iid of iids) state.positions[iid] ??= { size: 0, entryPrice: 0, openedAt: 0 };

  const feed = { connected: false, downSince: null };
  let consecutiveFatal = 0;
  let placePausedUntil = 0;
  let marginUsed = NaN;
  let equity = NaN;
  const autoCancel = { enabled: mode === "live" && cfg.autoCancel.enabled, triggered: NaN, dailyLimit: NaN, fatalError: null };
  const tokens = { n: cfg.quote.maxPlacesPerMinute, at: Date.now() };
  const seenFunding = new Set(state.seenFundingIds);
  const seenTrades = new Set(state.seenTradeIds);
  const timers = [];
  let busy = false;
  let running = false;
  let saveDirty = false;

  const position = (iid) => state.positions[iid];
  const book = (iid) => md.books.get(iid);
  const sym = (iid) => insts.get(iid).symbol;

  function markDirty() {
    saveDirty = true;
  }
  function flushState() {
    if (!saveDirty) return;
    state.openOrders = [...orders.values()].filter((o) => o.status !== "done").map(({ coid, iid, side, price, qty, filled, intent, status }) => ({ coid, iid, side, price, qty, filled, intent, status }));
    state.seenTradeIds = [...seenTrades].slice(-2000);
    state.seenFundingIds = [...seenFunding].slice(-500);
    store.save(state);
    saveDirty = false;
  }

  // ---------------- accounting ----------------

  function unrealizedTotal() {
    let u = 0;
    for (const iid of iids) {
      const p = position(iid);
      const m = bookMid(book(iid));
      if (p.size && Number.isFinite(m)) u += (m - p.entryPrice) * p.size;
    }
    return u;
  }

  function refreshPnl() {
    const d = state.daily;
    const u = unrealizedTotal();
    if (d.unrealizedAtDayStart === null) d.unrealizedAtDayStart = u;
    d.unrealized = u - d.unrealizedAtDayStart;
    const pnl = netPnl(d);
    d.peakPnl = Math.max(d.peakPnl, pnl);
    d.maxDrawdown = Math.max(d.maxDrawdown, d.peakPnl - pnl);
    if (mode === "dry") {
      marginUsed = iids.reduce((a, iid) => a + Math.abs(position(iid).size * (bookMid(book(iid)) || 0)) / cfg.leverage.value, 0);
    }
  }

  function simLiqPrice(iid) {
    // Isolated-margin estimate for dry run: maintenance ~ half the initial
    // margin at the instrument's max leverage.
    const p = position(iid);
    if (!p.size) return NaN;
    const im = 1 / cfg.leverage.value;
    const mm = 1 / (2 * insts.get(iid).maxLeverage);
    return p.size > 0 ? p.entryPrice * (1 - im + mm) : p.entryPrice * (1 + im - mm);
  }

  function liqPrice(iid) {
    return mode === "live" ? per.get(iid).liqPrice : simLiqPrice(iid);
  }

  function applyPositionFill(p, buy, price, qty, now) {
    const signed = buy ? qty : -qty;
    const prev = p.size;
    let realized = 0;
    if (prev === 0 || Math.sign(prev) === Math.sign(signed)) {
      const next = prev + signed;
      p.entryPrice = (prev * p.entryPrice + signed * price) / next;
      if (prev === 0) p.openedAt = now;
      p.size = next;
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(prev));
      realized = closing * (price - p.entryPrice) * Math.sign(prev);
      const next = prev + signed;
      if (Math.abs(next) < 1e-12) {
        p.size = 0;
        p.entryPrice = 0;
        p.openedAt = 0;
      } else if (Math.sign(next) !== Math.sign(prev)) {
        p.size = next;
        p.entryPrice = price;
        p.openedAt = now;
      } else {
        p.size = next;
      }
    }
    p.size = Number(p.size.toFixed(12));
    return realized;
  }

  function onFill(f) {
    if (f.tradeId !== undefined) {
      const key = String(f.tradeId);
      if (seenTrades.has(key)) return;
      seenTrades.add(key);
    }
    const now = Date.now();
    const o = f.coid ? orders.get(f.coid) : null;
    if (f.foreign || !insts.has(f.iid)) {
      log.warn("fill on a bot instrument that the bot did not place; position will be adopted from the exchange", { iid: f.iid, price: f.price, qty: f.qty });
      return;
    }
    const d = state.daily;
    const notional = f.price * f.qty;
    const inst = insts.get(f.iid);
    const fee = Number.isFinite(f.fee) ? f.fee : notional * (f.taker ? inst.takerFee : inst.makerFee);
    d.fills++;
    d.grossVolume += notional;
    if (f.taker) {
      d.takerVolume += notional;
      d.takerFees += fee;
    } else {
      d.makerVolume += notional;
      d.makerFees += fee;
    }
    d.firstActivityAt ??= now;

    const decisionMid = o?.decisionMid;
    const slip = Number.isFinite(decisionMid) ? (f.buy ? f.price - decisionMid : decisionMid - f.price) * f.qty : 0;
    const slipBps = Number.isFinite(decisionMid) && decisionMid > 0 ? (slip / notional) * 1e4 : null;
    d.slippage += slip;
    if (o?.intent?.startsWith("flatten") && slipBps !== null) {
      d.flattenSlipBpsSum += slipBps;
      d.flattenSlipCount++;
    }

    const p = position(f.iid);
    const realized = applyPositionFill(p, f.buy, f.price, f.qty, now);
    per.get(f.iid).positionChangedAt = now;
    d.realized += realized;
    if (o) o.filled += f.qty;

    reporter.fill({
      symbol: sym(f.iid),
      iid: f.iid,
      side: f.buy ? "buy" : "sell",
      price: f.price,
      qty: f.qty,
      notional,
      liquidity: f.taker ? "taker" : "maker",
      fee,
      intent: o?.intent ?? "",
      decision_mid: decisionMid,
      slippage_usd: slip,
      slippage_bps: slipBps,
      position_after: p.size,
      realized_pnl: realized,
      trade_id: f.tradeId,
      coid: f.coid ?? "",
    });
    log.info(`fill ${sym(f.iid)} ${f.buy ? "BUY" : "SELL"} ${f.qty} @ ${f.price} (${f.taker ? "taker" : "maker"})`, {
      intent: o?.intent,
      fee: round6(fee),
      slipBps: slipBps === null ? null : round2(slipBps),
      position: p.size,
    });
    refreshPnl();
    markDirty();
  }

  function onFunding(x) {
    if (seenFunding.has(x.id)) return;
    seenFunding.add(x.id);
    state.daily.funding += x.cost;
    log.info(`funding ${sym(x.iid)} ${x.cost >= 0 ? "paid" : "received"} $${Math.abs(x.cost).toFixed(6)}`, { rate: x.rate, size: x.size });
    markDirty();
  }

  function onOrderDone({ coid, reason }) {
    const o = orders.get(coid);
    if (!o || o.status === "done") return;
    o.status = "done";
    o.doneReason = reason;
    const s = per.get(o.iid);
    for (const side of SIDES) if (s.quotes[side] === coid) s.quotes[side] = null;
    if (s.flattenCoid === coid) s.flattenCoid = null;
    markDirty();
  }

  exec.on("fill", onFill);
  exec.on("funding", onFunding);
  exec.on("orderDone", onOrderDone);

  // ---------------- order actions ----------------

  function takeToken() {
    const now = Date.now();
    const perMs = cfg.quote.maxPlacesPerMinute / 60_000;
    tokens.n = Math.min(cfg.quote.maxPlacesPerMinute, tokens.n + (now - tokens.at) * perMs);
    tokens.at = now;
    if (tokens.n < 1) return false;
    tokens.n -= 1;
    return true;
  }

  function onApiError(err, context) {
    const kind = err?.kind ?? "Fatal";
    if (kind === "Fatal") {
      consecutiveFatal++;
      log.error(`API error (${consecutiveFatal}/${cfg.risk.maxConsecutiveErrors} in a row)`, { context, code: err?.code ?? err?.message });
    } else if (kind === "Maintenance") {
      placePausedUntil = Date.now() + MAINTENANCE_PAUSE_MS;
      log.warn("exchange maintenance / in-flight; pausing new orders briefly", { context, code: err?.code });
    } else if (kind === "RateLimited") {
      placePausedUntil = Date.now() + (err.retryAfterMs ?? 2000);
      log.warn("rate limited; backing off", { context, code: err?.code });
    } else if (kind === "PostOnlyReject") {
      log.debug("post-only order would have crossed; will re-quote", { context });
    } else if (kind === "StaleState") {
      log.warn("exchange rejected a reduce-only order: the position is already gone; resyncing", { context, code: err?.code });
    } else {
      log.warn("indeterminate API result", { context, code: err?.code });
    }
  }

  async function place(iid, spec) {
    if (state.stop && !spec.intent.startsWith("flatten")) return null;
    if (Date.now() < placePausedUntil) return null;
    if (!takeToken()) return null;
    const coid = makeCoid({ sessionId: state.sessionId, iid, intent: spec.intent, nonce: ++state.coidNonce });
    const b = book(iid);
    const o = {
      coid,
      iid,
      side: spec.side,
      price: spec.price,
      qty: spec.qty,
      tif: spec.tif ?? "gtc",
      postOnly: spec.postOnly ?? true,
      reduceOnly: spec.reduceOnly ?? false,
      intent: spec.intent,
      decisionMid: spec.decisionMid ?? bookMid(b),
      filled: 0,
      status: "pending",
      placedAt: Date.now(),
    };
    orders.set(coid, o);
    const s = per.get(iid);
    if (spec.intent === "quote-bid") s.quotes.buy = coid;
    if (spec.intent === "quote-ask") s.quotes.sell = coid;
    if (spec.intent === "flatten-post") s.flattenCoid = coid;
    markDirty();
    flushState(); // persist the nonce before the request leaves

    reporter.quote({ symbol: sym(iid), iid, action: "place", side: o.side, price: o.price, qty: o.qty, intent: o.intent, reason: spec.reason ?? "", coid });
    const res = await exec.place(o);
    if (res.status === "ok") {
      consecutiveFatal = 0;
      if (o.status === "pending") o.status = "live";
      if (o.tif === "ioc") o.status = o.status === "done" ? "done" : "live";
    } else if (res.status === "unknown") {
      o.status = "live"; // treat as resting until reconcile proves otherwise
      onApiError(res.error, `place ${o.intent}`);
    } else {
      onOrderDone({ coid, reason: `rejected: ${res.error?.code ?? "unknown"}` });
      reporter.quote({ symbol: sym(iid), iid, action: "reject", side: o.side, price: o.price, qty: o.qty, intent: o.intent, reason: res.error?.code ?? "", coid });
      // A reduce-only reject means our position view is stale: stop hammering
      // the same order once a second and pull the truth from the exchange.
      if (res.error?.kind === "StaleState" && o.intent.startsWith("flatten")) {
        s.flattenPausedUntil = Date.now() + STALE_RESYNC_PAUSE_MS;
        if (mode === "live") resyncNow();
      }
      onApiError(res.error, `place ${o.intent}`);
    }
    return o;
  }

  async function cancel(coid, reason) {
    const o = orders.get(coid);
    if (!o || o.status === "done" || o.status === "cancelling") return;
    const prev = o.status;
    o.status = "cancelling";
    reporter.quote({ symbol: sym(o.iid), iid: o.iid, action: "cancel", side: o.side, price: o.price, qty: o.qty, intent: o.intent, reason, coid });
    const res = await exec.cancel(coid);
    if (res.status === "ok") {
      consecutiveFatal = 0;
      onOrderDone({ coid, reason: `cancelled: ${reason}` });
    } else {
      o.status = prev; // still resting; retry on a later tick
      onApiError(res.error, "cancel");
    }
  }

  async function cancelInstrument(iid, reason) {
    const live = [...orders.values()].filter((o) => o.iid === iid && o.status !== "done");
    if (!live.length) return;
    log.warn(`cancelling ${live.length} order(s) on ${sym(iid)}: ${reason}`);
    const res = await exec.cancelInstrument(iid);
    if (res.status === "ok") for (const o of live) onOrderDone({ coid: o.coid, reason: `cancel all: ${reason}` });
    else onApiError(res.error, "cancelAll");
  }

  const cancelEverything = (reason) => Promise.all(iids.map((iid) => cancelInstrument(iid, reason)));

  // ---------------- per-instrument step ----------------

  function quoteView(iid) {
    const s = per.get(iid);
    const view = {};
    for (const side of SIDES) {
      const o = s.quotes[side] ? orders.get(s.quotes[side]) : null;
      // `remaining` is what is still resting: a partially filled reduce quote
      // already matches the smaller position, so it must not be re-posted.
      view[side] = o && o.status !== "done" ? { coid: o.coid, price: o.price, qty: o.qty, remaining: o.qty - (o.filled ?? 0), status: o.status } : null;
    }
    return view;
  }

  function flowTotals(iid, now) {
    const s = per.get(iid);
    const cutoff = now - cfg.quote.adverse.flowWindowMs;
    while (s.flow.length && s.flow[0].ts < cutoff) s.flow.shift();
    let buyUsd = 0;
    let sellUsd = 0;
    for (const t of s.flow) t.takerBuy ? (buyUsd += t.usd) : (sellUsd += t.usd);
    return { buyUsd, sellUsd };
  }

  function trackBest(iid, now) {
    const s = per.get(iid);
    const b = book(iid);
    for (const side of SIDES) {
      const px = side === "buy" ? b.bid : b.ask;
      if (px !== s.lastBest[side]) {
        s.lastBest[side] = px;
        s.bestSince[side] = now;
      }
    }
  }

  async function stepInstrument(iid, now, { canOpen, blocked, force }) {
    const s = per.get(iid);
    const inst = insts.get(iid);
    const b = book(iid);
    const p = position(iid);
    const m = bookMid(b);
    const posView = { size: p.size, notional: p.size * (m || 0), entryPrice: p.entryPrice, openedAt: p.openedAt, liqPrice: liqPrice(iid) };

    // --- flatten ---
    const wasIdle = s.fstate.phase === "idle" || s.fstate.phase === "dust";
    const f = decideFlatten({ inst, position: posView, book: b, fstate: s.fstate, now, cfg, force });
    if (wasIdle && f.fstate.phase !== "idle" && f.fstate.phase !== "dust") {
      state.daily.flattens++;
      log.info(`flatten start ${sym(iid)}: ${f.fstate.trigger}`, { size: p.size, phase: f.fstate.phase, decisionMid: f.fstate.decisionMid });
      markDirty();
    }
    if (f.fstate.phase !== s.fstate.phase && !wasIdle) log.info(`flatten ${sym(iid)} -> ${f.fstate.phase}`, { reason: f.reason, size: p.size });
    s.fstate = f.fstate;
    const flattening = s.fstate.phase !== "idle" && s.fstate.phase !== "dust";

    // Quotes first: while flattening they are all cancelled (self-trade guard:
    // nothing of ours rests opposite a flatten order).
    // Keep the reference basis EMA on the engine clock (one sample per
    // instrument per loop) rather than on book churn, so its half-life means
    // the same thing regardless of how busy the book is.
    reference?.observe(iid, m, now);

    const q = decideQuotes({
      inst,
      book: b,
      position: posView,
      ref: reference ? reference.view(iid, m, now) : null,
      quotes: quoteView(iid),
      bestSince: s.bestSince,
      lastReplaceAt: s.lastReplaceAt,
      canOpen,
      flattening,
      blocked,
      now,
      cfg,
      flow: flowTotals(iid, now),
      adverseUntil: s.adverseUntil,
      bookIncludesOwn: mode === "live",
    });
    for (const side of SIDES) if (q.adverse?.[side]) s.adverseUntil[side] = now + cfg.quote.adverse.holdMs;
    for (const a of q.actions) {
      if (a.type === "cancel") await cancel(a.coid, a.reason);
    }
    const quotesClear = !flattening || SIDES.every((side) => !quoteView(iid)[side]);
    for (const a of q.actions) {
      if (a.type !== "place") continue;
      if (a.replaces) s.lastReplaceAt[a.side] = now;
      await place(iid, { side: a.side, price: a.price, qty: a.qty, intent: a.intent, reason: a.reason });
    }

    if (!flattening) {
      if (s.flattenCoid) await cancel(s.flattenCoid, "flatten finished");
      return;
    }
    if (!quotesClear) return; // wait until our quotes are confirmed gone
    if (now < s.flattenPausedUntil) return; // waiting for a forced position resync

    const standing = s.flattenCoid ? orders.get(s.flattenCoid) : null;
    if (f.standing) {
      const same = standing && standing.status !== "done" && standing.price === f.standing.price && Math.abs(standing.qty - f.standing.qty) < 1e-12;
      if (!same) {
        if (standing && standing.status !== "done") {
          await cancel(standing.coid, "re-peg flatten");
          return;
        }
        await place(iid, { ...f.standing, reason: f.reason, decisionMid: s.fstate.decisionMid });
      }
    } else if (standing && standing.status !== "done") {
      await cancel(standing.coid, "flatten escalating to taker");
      return;
    }
    if (f.ioc) {
      log.info(`flatten IOC ${sym(iid)} ${f.ioc.side} ${f.ioc.qty} limit ${f.ioc.price}`, { reason: f.reason });
      await place(iid, { ...f.ioc, reason: f.reason, decisionMid: f.ioc.decisionMid });
    }
  }

  // ---------------- risk, stop, day rollover ----------------

  function haltForDay(stop) {
    if (state.stop) return;
    state.stop = { ...stop, at: new Date().toISOString(), day: state.daily.day };
    log.error(`STOPPED for the rest of the UTC day: ${stop.reason}`, stop);
    log.error("Cancelling orders and flattening. Trading resumes automatically at 00:00 UTC, or restart after fixing the cause.");
    markDirty();
    flushState();
    cancelEverything(`stop: ${stop.reason}`).catch((e) => log.error("cancel on stop failed", { error: e.message }));
    writeSummary("stop");
  }

  function rollover(now) {
    const today = utcDay(now);
    if (state.daily.day === today) return;
    writeSummary("end of day");
    log.info(`new UTC day ${today}: daily counters reset`, { previousStop: state.stop?.reason ?? null });
    state.daily = emptyDaily(today);
    state.daily.unrealizedAtDayStart = unrealizedTotal();
    state.disconnectsToday = 0;
    consecutiveFatal = 0;
    if (state.stop) {
      log.info("previous stop cleared for the new day; trading resumes");
      state.stop = null;
    }
    markDirty();
  }

  function staleMap(now) {
    const out = {};
    for (const iid of iids) {
      const ms = md.staleness(iid, now);
      const s = per.get(iid);
      if (ms > cfg.risk.staleMs) s.staleSince ??= now;
      else s.staleSince = null;
      out[iid] = { staleMs: ms, staleSince: s.staleSince };
    }
    return out;
  }

  // ---------------- main loop ----------------

  async function loop() {
    if (busy || !running) return;
    busy = true;
    try {
      const now = Date.now();
      rollover(now);
      exec.tick(now);
      for (const iid of iids) trackBest(iid, now);
      refreshPnl();

      const risk = evaluate({
        now,
        cfg,
        daily: state.daily,
        consecutiveFatal,
        feed: { connected: feed.connected, downSince: feed.downSince, disconnectsToday: state.disconnectsToday },
        stale: staleMap(now),
        autoCancel,
        live: mode === "live",
      });
      if (risk.stop) haltForDay(risk.stop);

      if (state.stop) {
        // Stopped: only flatten (taker) with a usable book, nothing else.
        for (const iid of iids) {
          if (!position(iid).size) continue;
          const usable = feed.connected && md.staleness(iid, now) <= cfg.risk.staleMs;
          if (usable) await stepInstrument(iid, now, { canOpen: false, blocked: "stopped", force: true });
        }
      } else {
        const cancelSet = risk.cancelIids === "all" ? iids : risk.cancelIids;
        for (const iid of iids) {
          const s = per.get(iid);
          if (cancelSet.includes(iid)) {
            await cancelInstrument(iid, feed.connected ? "stale market data" : "WebSocket down");
            continue;
          }
          const blocked = s.foreignOrders ? `${s.foreignOrders} order(s) on ${sym(iid)} not placed by this bot` : null;
          await stepInstrument(iid, now, { canOpen: risk.canOpen, blocked, force: false });
        }
      }
      flushState();
    } catch (e) {
      log.error("loop error", { error: e.message, stack: e.stack?.split("\n").slice(0, 4).join(" | ") });
      onApiError(e, "loop");
    } finally {
      busy = false;
    }
  }

  function minLiqDistance() {
    let min = Infinity;
    for (const iid of iids) {
      const p = position(iid);
      if (!p.size) continue;
      min = Math.min(min, liquidationDistancePct({ liqPrice: liqPrice(iid) }, bookMid(book(iid))));
    }
    return min;
  }

  function summaryRow(now = Date.now()) {
    refreshPnl();
    return computeSummary(state.daily, {
      now,
      mode,
      marginUsed,
      minLiqDistancePct: minLiqDistance(),
      budgetLimit: cfg.budget.dailyCostUsd,
      stopReason: state.stop?.reason,
    });
  }

  function writeSummary(why) {
    const row = summaryRow();
    reporter.summary(row);
    log.info(`summary (${why})\n${formatSummary(row)}`);
    const rh = reference?.health();
    if (rh?.enabled) {
      log.info(`reference ${rh.mode}: ${rh.connected ? "connected" : "DISCONNECTED"}${rh.warm ? "" : ", warming up"}`, {
        staleMs: Number.isFinite(rh.staleMs) ? rh.staleMs : null,
        updates: rh.messages,
      });
    }
    for (const iid of iids) {
      const p = position(iid);
      if (p.size) log.info(`position ${sym(iid)} ${p.size} @ ${round2(p.entryPrice)}; liq ${round2(liqPrice(iid))} (${round2(liquidationDistancePct({ liqPrice: liqPrice(iid) }, bookMid(book(iid))))}% away)`);
    }
  }

  // ---------------- live-only background jobs ----------------

  // Force an out-of-band reconcile when the exchange tells us our position view
  // is stale. Never awaited from the trading path, never more than one at a time.
  let resyncInFlight = false;
  function resyncNow() {
    if (resyncInFlight || !running) return;
    resyncInFlight = true;
    reconcileLive().finally(() => {
      resyncInFlight = false;
    });
  }

  async function reconcileLive() {
    try {
      const snap = await exec.reconcile({ iids, sinceTs: Date.parse(`${state.daily.day}T00:00:00Z`) });
      marginUsed = snap.marginUsed;
      equity = snap.equity;
      if (Number.isFinite(equity) && state.daily.equityAtDayStart == null) {
        state.daily.equityAtDayStart = equity;
        state.daily.equityBaselineAt = Date.now();
        markDirty();
      }
      for (const iid of iids) {
        const s = per.get(iid);
        const ex = snap.positions[iid] ?? { size: 0, entryPrice: 0, liqPrice: NaN };
        const p = position(iid);
        s.liqPrice = ex.liqPrice;
        if (Math.abs(ex.size - p.size) > 1e-9) {
          // A fill that landed after the request left is not in this response.
          // Adopting it would resurrect a position we already closed.
          if (!snapshotIsFresh(snap.requestedAt, s.positionChangedAt)) {
            log.debug(`position snapshot for ${sym(iid)} predates our last fill; keeping ${p.size}`, { exchange: ex.size });
            continue;
          }
          log.warn(`position mismatch on ${sym(iid)}: bot ${p.size}, exchange ${ex.size}; adopting exchange`, {});
          if (p.size === 0 || Math.sign(p.size) !== Math.sign(ex.size)) p.openedAt = ex.size ? Date.now() - cfg.flatten.maxPositionAgeSec * 1000 : 0;
          p.size = ex.size;
          p.entryPrice = ex.size ? ex.entryPrice : 0;
          markDirty();
        } else if (ex.size) {
          p.entryPrice = ex.entryPrice;
        }
        s.foreignOrders = snap.foreign.filter((o) => o.instrument_id === iid).length;
      }
      if (snap.inLiquidation) haltForDay({ reason: "account is in liquidation" });
      if (snap.foreign.length) log.warn("orders on bot instruments that this bot did not place; quoting paused on those instruments", { count: snap.foreign.length });
    } catch (e) {
      onApiError(e, "reconcile");
    }
  }

  async function armAutoCancel() {
    if (!autoCancel.enabled || !running) return;
    try {
      await api.autoCancel(api.now() + cfg.autoCancel.aheadSec * 1000);
    } catch (e) {
      if (/auto_cancel_in_flight/.test(e.code)) return; // transient
      if (e.kind === "RateLimited" || e.kind === "Indeterminate" || e.kind === "Maintenance") return onApiError(e, "autoCancel");
      autoCancel.fatalError = e.code ?? e.message;
      onApiError(e, "autoCancel");
    }
  }

  async function pollAutoCancel() {
    if (!autoCancel.enabled) return;
    try {
      const st = await api.autoCancelStatus();
      autoCancel.triggered = Number(st.triggered);
      autoCancel.dailyLimit = Number(st.daily_limit);
      const level = autoCancelHeadroomLow(autoCancel) ? "warn" : "debug";
      log[level]("auto-cancel status", { triggered: autoCancel.triggered, dailyLimit: autoCancel.dailyLimit, deadline: st.deadline });
    } catch (e) {
      onApiError(e, "autoCancelStatus");
    }
  }

  async function pollFunding() {
    try {
      if (mode === "live") await exec.pollFunding({ start: Date.parse(`${state.daily.day}T00:00:00Z`), seen: seenFunding });
      else exec.fundingTick(await api.tickers());
    } catch (e) {
      log.warn("funding poll failed", { error: e.message });
    }
  }

  // ---------------- reference fast pull ----------------

  // The loop runs every LOOP_MS and awaits its REST calls one after another,
  // so a gate warning waits on average over 100 ms before the loop acts on it.
  // Binance leads Polymarket by about 100 ms, which means the arbitrageur has
  // usually taken the stale quote by then. This applies the same gate on the
  // Binance tick itself and cancels at once, outside the loop. cancel() marks
  // the order "cancelling" before its request leaves, so the loop leaves it
  // alone and re-quotes that side once the warning clears.
  function fastPull(iid) {
    if (!running || state.stop) return;
    const b = book(iid);
    if (!bookIsUsable(b)) return;
    const quotes = quoteView(iid);
    const ref = reference.view(iid, bookMid(b));
    for (const side of fastPullSides({ ref, position: position(iid), quotes, cfg })) {
      const o = orders.get(quotes[side].coid);
      // One attempt per order. A failed cancel is retried by the loop at its
      // own pace, never once per Binance tick.
      if (o.fastPullTried) continue;
      o.fastPullTried = true;
      cancel(o.coid, `reference fast pull: edge ${ref.edgeBps.toFixed(2)} bps`).catch((e) => log.warn("fast pull cancel failed", { error: e.message }));
    }
  }

  // ---------------- lifecycle ----------------

  reference?.on?.("tick", fastPull);

  md.on("book", (iid) => exec.onBook?.(iid));
  md.on("trade", (t) => {
    per.get(t.iid)?.flow.push({ ts: Date.now(), takerBuy: t.takerBuy, usd: t.price * t.qty });
    exec.onTrade?.(t);
  });
  md.on("disconnected", (why) => {
    feed.connected = false;
    feed.downSince = Date.now();
    state.disconnectsToday++;
    markDirty();
    log.warn(`WebSocket disconnected (${state.disconnectsToday} today, limit ${cfg.risk.maxDisconnectsPerDay}); cancelling all orders`, { why });
    cancelEverything("WebSocket down").catch(() => {});
  });
  md.on("restored", () => {
    const wasDown = feed.downSince !== null;
    feed.connected = true;
    feed.downSince = null;
    if (wasDown) log.info("WebSocket restored");
  });

  return {
    get state() {
      return state;
    },
    get equity() {
      return equity;
    },

    async start() {
      running = true;
      if (state.stop) log.error(`bot is stopped for today (${state.stop.reason}); it will not trade until 00:00 UTC`, state.stop);
      if (mode === "live") {
        await reconcileLive();
        await pollAutoCancel();
        timers.push(setInterval(reconcileLive, RECONCILE_MS));
        timers.push(setInterval(pollAutoCancel, cfg.autoCancel.pollSec * 1000));
        if (autoCancel.enabled) {
          await armAutoCancel();
          timers.push(setInterval(armAutoCancel, cfg.autoCancel.rearmSec * 1000));
        }
      }
      reference?.start();
      await pollFunding();
      timers.push(setInterval(pollFunding, FUNDING_POLL_MS));
      timers.push(setInterval(loop, LOOP_MS));
      timers.push(setInterval(() => writeSummary("periodic"), cfg.report.summaryEveryMin * 60_000));
      log.info(state.stop ? "engine running (STOPPED for today)" : "engine running (TRADING)", { mode, markets: iids.map(sym) });
    },

    async shutdown(reason) {
      if (!running) return;
      log.warn(`shutting down: ${reason}`);
      running = false;
      reference?.stop();
      for (const t of timers) clearInterval(t);
      while (busy) await new Promise((r) => setTimeout(r, 20));
      await cancelEverything(`shutdown: ${reason}`);
      if (mode === "live" && autoCancel.enabled) {
        try {
          await api.autoCancel(0); // disarm; clearing never counts as a fire
        } catch (e) {
          log.warn("could not disarm auto-cancel (it will fire harmlessly on an empty book)", { error: e.code ?? e.message });
        }
      }
      markDirty();
      flushState();
      writeSummary(`exit: ${reason}`);
    },

    // exposed for tests / diagnostics
    _internals: { orders, per, feed, autoCancel, loop, summaryRow },
  };
}

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const round6 = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x);
