// External reference price, used to tell when our quote is about to be picked
// off.
//
// The problem it solves: every maker fill markets out at about -2.14 bps,
// roughly two standard deviations of a 5-second move, symmetric across sides
// and flat across every feature of Polymarket's own book. Fills that bad are
// not bad luck and the information is not in the book - it arrives from
// outside. Polymarket Perps BTC is a derivative of the real BTC market, so
// whoever sees Binance first knows our quote is stale before we do, and takes
// it. This module gives the bot the same view.
//
// Binance USD-M futures is the deepest and fastest BTC/ETH price available,
// and its public book feed needs no account and no key. From the Tokyo VPS its
// updates land about 3 ms after Binance stamps them, against 2.5 s for
// Polymarket's own index price - which is why the index cannot do this job.
//
// The signal is NOT the raw gap. Polymarket sits at a persistent offset to
// Binance (different index composition, funding, venue basis), and that offset
// is worth nothing. What is tradeable is the wobble around it:
//
//     basis  = (pmMid - binMid) / binMid        in bps, right now
//     ema    = slow EMA of basis                the normal offset
//     edge   = ema - basis                      how far Polymarket has lagged
//
// edge > 0 means Polymarket is low relative to where Binance says it should
// be, so its mid is about to rise: our ASK is the stale side about to be hit.
// edge < 0 warns the bid. Symmetric by construction, which matters because the
// measured markout is symmetric too.
//
// Three modes, set by config.reference.mode:
//   off      not started; the bot behaves exactly as it did before
//   observe  connected and recording, but no decision changes. This is how we
//            measure the signal against real fills before trusting it.
//   gate     observe, plus the warned side stops quoting
//
// Failure is always silent and safe: a disconnected, stale or still-warming
// feed reports ok:false, and every caller then behaves exactly as in "off".
// A reference outage must never be able to change trading in a surprising way.

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export const BINANCE_WS = "wss://fstream.binance.com/stream";

// Polymarket instrument -> Binance USD-M futures symbol. An instrument with no
// entry here simply gets no reference signal; it is never an error, and that
// instrument then quotes exactly as it would with the reference off.
export const BINANCE_SYMBOL = {
  "BTC-USD": "btcusdt",
  "ETH-USD": "ethusdt",
  "BNB-USD": "bnbusdt",
};

export const REF_COLUMNS = ["ts", "iid", "symbol", "binBid", "binAsk", "pmMid", "basisBps", "emaBps", "edgeBps"];

/**
 * Pure: how far Polymarket has lagged its usual relationship to the reference.
 * Positive means Polymarket is cheap and should rise (the ask is in danger).
 * Returns NaN when either price is unusable, so callers fail closed to "no signal".
 */
export function edgeBps(pmMid, binMid, emaBasisBps) {
  if (!(pmMid > 0) || !(binMid > 0) || !Number.isFinite(emaBasisBps)) return NaN;
  const basis = ((pmMid - binMid) / binMid) * 1e4;
  return emaBasisBps - basis;
}

/**
 * Pure: which side, if any, the signal warns about at this threshold.
 * "sell" means our ask is the side about to be picked off.
 */
export function warnedSide(edge, gateBps) {
  if (!Number.isFinite(edge) || !(gateBps > 0)) return null;
  if (edge >= gateBps) return "sell"; // Polymarket about to rise: the ask is stale-cheap
  if (edge <= -gateBps) return "buy"; // about to fall: the bid is stale-expensive
  return null;
}

/**
 * Time-decayed EMA step. dtMs-aware so the loop rate cannot change the
 * half-life: a 200 ms loop and a 1 s loop converge to the same number.
 */
export function emaStep(prev, value, dtMs, halfLifeSec) {
  if (!Number.isFinite(prev)) return value;
  if (!(halfLifeSec > 0) || !(dtMs > 0)) return prev;
  const alpha = 1 - Math.exp((-Math.LN2 * dtMs) / (halfLifeSec * 1000));
  return prev + alpha * (value - prev);
}

export function createReference({ cfg, markets, log, reporter = null, WebSocketImpl = WebSocket, url = BINANCE_WS, clock = Date.now }) {
  const ev = new EventEmitter();
  const refCfg = cfg.reference;
  const enabled = refCfg.mode !== "off";

  // iid -> live state
  const per = new Map();
  for (const { iid, symbol } of markets) {
    const binance = BINANCE_SYMBOL[symbol];
    if (!binance) continue;
    per.set(iid, {
      symbol,
      binance,
      bid: NaN,
      ask: NaN,
      updatedAt: 0,
      exchTs: 0,
      emaBps: NaN,
      lastEmaAt: 0,
      firstSampleAt: 0,
      lastLogAt: 0,
    });
  }
  const byBinance = new Map([...per.entries()].map(([iid, s]) => [s.binance, iid]));

  let ws = null;
  let closing = false;
  let connected = false;
  let reconnectDelay = 1000;
  let messages = 0;

  function onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const d = m?.data;
    if (!d?.s) return;
    const iid = byBinance.get(d.s.toLowerCase());
    if (iid === undefined) return;
    const bid = Number(d.b);
    const ask = Number(d.a);
    if (!(bid > 0) || !(ask > bid)) return;
    const s = per.get(iid);
    s.bid = bid;
    s.ask = ask;
    s.updatedAt = clock();
    s.exchTs = Number(d.T ?? d.E ?? 0) || 0;
    messages++;
  }

  function connect() {
    const streams = [...per.values()].map((s) => `${s.binance}@bookTicker`).join("/");
    ws = new WebSocketImpl(`${url}?streams=${streams}`);
    ws.on("open", () => {
      reconnectDelay = 1000;
      connected = true;
      log.info("reference: connected", { venue: "binance-futures", streams, mode: refCfg.mode });
      ev.emit("connected");
    });
    ws.on("message", onMessage);
    ws.on("error", (e) => log.warn("reference: websocket error", { error: e.message }));
    ws.on("close", (code) => {
      const was = connected;
      connected = false;
      if (closing) return;
      if (was) log.warn("reference: disconnected", { code });
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
      setTimeout(() => !closing && connect(), delay);
    });
  }

  function binMid(iid) {
    const s = per.get(iid);
    return s && s.bid > 0 && s.ask > s.bid ? (s.bid + s.ask) / 2 : NaN;
  }

  return Object.assign(ev, {
    enabled,
    mode: refCfg.mode,

    start() {
      if (!enabled) return;
      closing = false;
      connect();
    },

    stop() {
      closing = true;
      if (ws) ws.close();
    },

    isConnected: () => connected,
    messageCount: () => messages,

    /**
     * Feed in Polymarket's current mid and advance the basis EMA. Called once
     * per instrument per engine loop, so the EMA is sampled on a regular clock
     * rather than on book churn.
     */
    observe(iid, pmMid, now = clock()) {
      if (!enabled) return;
      const s = per.get(iid);
      if (!s) return;
      const bm = binMid(iid);
      if (!(pmMid > 0) || !(bm > 0)) return;
      if (now - s.updatedAt > refCfg.staleMs) return; // do not fold a stale reference into the EMA
      const basis = ((pmMid - bm) / bm) * 1e4;
      s.emaBps = emaStep(s.emaBps, basis, s.lastEmaAt ? now - s.lastEmaAt : 0, refCfg.basisHalfLifeSec);
      s.lastEmaAt = now;
      s.firstSampleAt ||= now;

      // Record what the bot saw, so markout can be bucketed by edge later.
      // One row a second is plenty and keeps the file small.
      if (reporter && now - s.lastLogAt >= 1000) {
        s.lastLogAt = now;
        const edge = edgeBps(pmMid, bm, s.emaBps);
        reporter.reference?.({
          ts: new Date(now).toISOString(),
          iid,
          symbol: s.symbol,
          binBid: s.bid,
          binAsk: s.ask,
          pmMid,
          basisBps: basis.toFixed(4),
          emaBps: Number.isFinite(s.emaBps) ? s.emaBps.toFixed(4) : "",
          edgeBps: Number.isFinite(edge) ? edge.toFixed(4) : "",
        });
      }
    },

    /**
     * The signal for one instrument. `ok` is false whenever the feed cannot be
     * trusted - off, disconnected, stale, or still warming up - and callers
     * must then behave exactly as if there were no reference at all.
     */
    view(iid, pmMid, now = clock()) {
      const s = per.get(iid);
      if (!enabled || !s) return { ok: false, reason: "off", edgeBps: NaN };
      const staleMs = s.updatedAt ? now - s.updatedAt : Infinity;
      if (staleMs > refCfg.staleMs) return { ok: false, reason: "stale", edgeBps: NaN, staleMs };
      if (!s.firstSampleAt || now - s.firstSampleAt < refCfg.warmupSec * 1000) {
        return { ok: false, reason: "warming", edgeBps: NaN, staleMs };
      }
      const edge = edgeBps(pmMid, binMid(iid), s.emaBps);
      if (!Number.isFinite(edge)) return { ok: false, reason: "no price", edgeBps: NaN, staleMs };
      return {
        ok: true,
        // Only "gate" mode is allowed to change a decision; "observe" reports
        // the same number but tells the strategy not to act on it.
        acting: refCfg.mode === "gate",
        edgeBps: edge,
        basisBps: ((pmMid - binMid(iid)) / binMid(iid)) * 1e4,
        emaBps: s.emaBps,
        binMid: binMid(iid),
        staleMs,
      };
    },

    health(now = clock()) {
      if (!enabled) return { enabled: false, mode: refCfg.mode };
      let worstStale = 0;
      let warm = true;
      for (const s of per.values()) {
        worstStale = Math.max(worstStale, s.updatedAt ? now - s.updatedAt : Infinity);
        if (!s.firstSampleAt || now - s.firstSampleAt < refCfg.warmupSec * 1000) warm = false;
      }
      return { enabled: true, mode: refCfg.mode, connected, warm, staleMs: worstStale, messages };
    },
  });
}
