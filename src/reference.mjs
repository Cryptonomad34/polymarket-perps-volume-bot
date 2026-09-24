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
// Several venues can feed it (config.reference.venues: binance, bybit, okx).
// Each keeps its own basis EMA against Polymarket, because each has its own
// permanent offset. The combined signal is the MEDIAN across venues that are
// fresh and warm, so one lagging or broken venue cannot move it:
//
//     fair_v   = venueMid_v * (1 + ema_v / 1e4)   Polymarket-equivalent price
//     refFair  = median(fair_v)                    used by the "fair" strategy
//     edgeBps  = median(ema_v - basis_v)           used by the gate
//
// With only Binance configured (the default) this is exactly the original
// single-venue signal.
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
export const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
export const OKX_WS = "wss://ws.okx.com:8443/ws/v5/public";

// A price update from any venue, normalised. A side a message does not carry
// is NaN (kept from the previous update); an explicit unusable price is 0 or
// negative and rejects the whole update.
const num = (x) => (x === undefined || x === null || x === "" ? NaN : Number(x));

// Polymarket instrument -> venue symbol, plus how to connect and parse. An
// instrument with no entry for a venue simply gets nothing from that venue;
// with no venue at all it gets no signal and quotes as if the reference were
// off. It is never an error.
export const VENUES = {
  // USD-M futures bookTicker: every message is the full top of book.
  binance: {
    symbols: { "BTC-USD": "BTCUSDT", "ETH-USD": "ETHUSDT", "BNB-USD": "BNBUSDT" },
    url: (syms) => `${BINANCE_WS}?streams=${syms.map((s) => `${s.toLowerCase()}@bookTicker`).join("/")}`,
    subscribe: null,
    ping: null,
    parse(m) {
      const d = m?.data;
      if (!d?.s) return null;
      return [{ sym: String(d.s).toUpperCase(), bid: num(d.b), ask: num(d.a), exchTs: num(d.T ?? d.E) || 0 }];
    },
  },
  // v5 linear perpetuals, level-1 order book. A delta may carry one side
  // only, and a level with size 0 is a removal: both count as "not carried".
  bybit: {
    symbols: { "BTC-USD": "BTCUSDT", "ETH-USD": "ETHUSDT", "BNB-USD": "BNBUSDT" },
    url: () => BYBIT_WS,
    subscribe: (syms) => ({ op: "subscribe", args: syms.map((s) => `orderbook.1.${s}`) }),
    ping: { everyMs: 20_000, msg: JSON.stringify({ op: "ping" }) },
    parse(m) {
      if (typeof m?.topic !== "string" || !m.topic.startsWith("orderbook.1.") || !m.data) return null;
      const side = (lv) => (lv && num(lv[1]) > 0 ? num(lv[0]) : NaN);
      return [{ sym: String(m.data.s ?? m.topic.slice("orderbook.1.".length)).toUpperCase(), bid: side(m.data.b?.[0]), ask: side(m.data.a?.[0]), exchTs: num(m.ts) || 0 }];
    },
  },
  // Public bbo-tbt channel on the USDT-margined swap: every push is the full
  // top of book. Keepalive is the plain-text "ping" (answered with "pong").
  okx: {
    symbols: { "BTC-USD": "BTC-USDT-SWAP", "ETH-USD": "ETH-USDT-SWAP", "BNB-USD": "BNB-USDT-SWAP" },
    url: () => OKX_WS,
    subscribe: (syms) => ({ op: "subscribe", args: syms.map((instId) => ({ channel: "bbo-tbt", instId })) }),
    ping: { everyMs: 25_000, msg: "ping" },
    parse(m) {
      if (m?.arg?.channel !== "bbo-tbt" || !Array.isArray(m.data)) return null;
      return m.data.map((d) => ({ sym: String(m.arg.instId).toUpperCase(), bid: num(d.bids?.[0]?.[0]), ask: num(d.asks?.[0]?.[0]), exchTs: num(d.ts) || 0 }));
    },
  },
};

export const REF_COLUMNS = ["ts", "iid", "symbol", "binBid", "binAsk", "pmMid", "basisBps", "emaBps", "edgeBps", "refFair", "venues"];

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

export function median(xs) {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const venueMid = (v) => (v.bid > 0 && v.ask > v.bid ? (v.bid + v.ask) / 2 : NaN);

export function createReference({ cfg, markets, log, reporter = null, WebSocketImpl = WebSocket, clock = Date.now }) {
  const ev = new EventEmitter();
  const refCfg = cfg.reference;
  const enabled = refCfg.mode !== "off";
  const venueNames = (refCfg.venues ?? ["binance"]).filter((n) => VENUES[n]);

  // iid -> { symbol, venues: Map(name -> live state), lastLogAt }
  const per = new Map();
  // venue name -> Map(venue symbol -> iid)
  const bySym = new Map(venueNames.map((n) => [n, new Map()]));
  for (const { iid, symbol } of markets) {
    const venues = new Map();
    for (const name of venueNames) {
      const vsym = VENUES[name].symbols[symbol];
      if (!vsym) continue;
      venues.set(name, { sym: vsym, bid: NaN, ask: NaN, updatedAt: 0, exchTs: 0, emaBps: NaN, lastEmaAt: 0, firstSampleAt: 0 });
      bySym.get(name).set(vsym, iid);
    }
    if (venues.size) per.set(iid, { symbol, venues, lastLogAt: 0 });
  }

  // venue name -> connection state
  const conns = new Map();
  let closing = false;
  let messages = 0;

  function onMessage(name, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return; // e.g. OKX's plain-text "pong"
    }
    const updates = VENUES[name].parse(m);
    if (!updates) return;
    for (const u of updates) {
      const iid = bySym.get(name).get(u.sym);
      if (iid === undefined) continue;
      const v = per.get(iid).venues.get(name);
      // A carried price must be usable; a missing side keeps its last value.
      if ((!Number.isNaN(u.bid) && !(u.bid > 0)) || (!Number.isNaN(u.ask) && !(u.ask > 0))) continue;
      const bid = Number.isNaN(u.bid) ? v.bid : u.bid;
      const ask = Number.isNaN(u.ask) ? v.ask : u.ask;
      if (!(bid > 0) || !(ask > bid)) continue;
      v.bid = bid;
      v.ask = ask;
      v.updatedAt = clock();
      v.exchTs = u.exchTs;
      messages++;
      // Lets the engine react to this tick directly instead of on its next
      // loop; the reference leads Polymarket by ~100 ms, less than one loop.
      ev.emit("tick", iid);
    }
  }

  function connect(name) {
    const venue = VENUES[name];
    const syms = [...bySym.get(name).keys()];
    const c = conns.get(name) ?? { connected: false, reconnectDelay: 1000, ws: null, pingTimer: null };
    conns.set(name, c);
    const ws = new WebSocketImpl(venue.url(syms));
    c.ws = ws;
    ws.on("open", () => {
      c.reconnectDelay = 1000;
      c.connected = true;
      if (venue.subscribe) ws.send?.(JSON.stringify(venue.subscribe(syms)));
      if (venue.ping) {
        clearInterval(c.pingTimer);
        c.pingTimer = setInterval(() => {
          try {
            ws.send?.(venue.ping.msg);
          } catch {
            // the close handler reconnects
          }
        }, venue.ping.everyMs);
        c.pingTimer.unref?.();
      }
      log.info("reference: connected", { venue: name, symbols: syms, mode: refCfg.mode });
      ev.emit("connected", name);
    });
    ws.on("message", (raw) => onMessage(name, raw));
    ws.on("error", (e) => log.warn("reference: websocket error", { venue: name, error: e.message }));
    ws.on("close", (code) => {
      const was = c.connected;
      c.connected = false;
      clearInterval(c.pingTimer);
      if (closing) return;
      if (was) log.warn("reference: disconnected", { venue: name, code });
      const delay = c.reconnectDelay;
      c.reconnectDelay = Math.min(c.reconnectDelay * 2, 15_000);
      setTimeout(() => !closing && connect(name), delay);
    });
  }

  const isFresh = (v, now) => v.updatedAt > 0 && now - v.updatedAt <= refCfg.staleMs;
  const isWarm = (v, now) => v.firstSampleAt > 0 && now - v.firstSampleAt >= refCfg.warmupSec * 1000;

  return Object.assign(ev, {
    enabled,
    mode: refCfg.mode,
    venues: venueNames,

    start() {
      if (!enabled) return;
      closing = false;
      for (const name of venueNames) if (bySym.get(name).size) connect(name);
    },

    stop() {
      closing = true;
      for (const c of conns.values()) {
        clearInterval(c.pingTimer);
        c.ws?.close();
      }
    },

    isConnected: () => [...conns.values()].some((c) => c.connected),
    messageCount: () => messages,

    /**
     * Feed in Polymarket's current mid and advance each venue's basis EMA.
     * Called once per instrument per engine loop, so the EMAs are sampled on
     * a regular clock rather than on book churn.
     */
    observe(iid, pmMid, now = clock()) {
      if (!enabled) return;
      const s = per.get(iid);
      if (!s || !(pmMid > 0)) return;
      for (const v of s.venues.values()) {
        const vm = venueMid(v);
        if (!(vm > 0) || !isFresh(v, now)) continue; // never fold a stale reference into the EMA
        const basis = ((pmMid - vm) / vm) * 1e4;
        v.emaBps = emaStep(v.emaBps, basis, v.lastEmaAt ? now - v.lastEmaAt : 0, refCfg.basisHalfLifeSec);
        v.lastEmaAt = now;
        v.firstSampleAt ||= now;
      }

      // Record what the bot saw, so markout can be bucketed by edge later
      // and use pmMid as its mid series. One row a second is plenty.
      if (reporter && now - s.lastLogAt >= 1000) {
        s.lastLogAt = now;
        const view = this.view(iid, pmMid, now);
        const bin = s.venues.get("binance");
        reporter.reference?.({
          ts: new Date(now).toISOString(),
          iid,
          symbol: s.symbol,
          binBid: bin?.bid,
          binAsk: bin?.ask,
          pmMid,
          basisBps: Number.isFinite(view.basisBps) ? view.basisBps.toFixed(4) : "",
          emaBps: Number.isFinite(view.emaBps) ? view.emaBps.toFixed(4) : "",
          edgeBps: Number.isFinite(view.edgeBps) ? view.edgeBps.toFixed(4) : "",
          refFair: Number.isFinite(view.refFair) ? view.refFair : "",
          venues: view.venues ?? 0,
        });
      }
    },

    /**
     * The signal for one instrument. `ok` is false whenever it cannot be
     * trusted - off, every venue stale, still warming up - and callers must
     * then behave exactly as if there were no reference at all.
     */
    view(iid, pmMid, now = clock()) {
      const s = per.get(iid);
      if (!enabled || !s) return { ok: false, reason: "off", edgeBps: NaN };
      const all = [...s.venues.entries()];
      const fresh = all.filter(([, v]) => isFresh(v, now) && venueMid(v) > 0);
      const staleMs = Math.min(...all.map(([, v]) => (v.updatedAt ? now - v.updatedAt : Infinity)));
      if (!fresh.length) return { ok: false, reason: "stale", edgeBps: NaN, staleMs };
      const used = fresh.filter(([, v]) => isWarm(v, now) && Number.isFinite(v.emaBps));
      if (!used.length) return { ok: false, reason: "warming", edgeBps: NaN, staleMs };
      if (!(pmMid > 0)) return { ok: false, reason: "no price", edgeBps: NaN, staleMs };

      const bases = [];
      const emas = [];
      const edges = [];
      const fairs = [];
      for (const [, v] of used) {
        const vm = venueMid(v);
        const basis = ((pmMid - vm) / vm) * 1e4;
        bases.push(basis);
        emas.push(v.emaBps);
        edges.push(v.emaBps - basis);
        fairs.push(vm * (1 + v.emaBps / 1e4));
      }
      const bin = s.venues.get("binance");
      return {
        ok: true,
        // Only "gate" mode is allowed to change a decision; "observe" reports
        // the same numbers but tells the strategy not to act on them.
        acting: refCfg.mode === "gate",
        edgeBps: median(edges),
        refFair: median(fairs),
        venues: used.length,
        venueNames: used.map(([n]) => n),
        basisBps: median(bases),
        emaBps: median(emas),
        binMid: bin && isFresh(bin, now) ? venueMid(bin) : NaN,
        staleMs,
      };
    },

    health(now = clock()) {
      if (!enabled) return { enabled: false, mode: refCfg.mode };
      let worstStale = 0;
      let warm = true;
      for (const s of per.values()) {
        const vs = [...s.venues.values()];
        worstStale = Math.max(worstStale, Math.min(...vs.map((v) => (v.updatedAt ? now - v.updatedAt : Infinity))));
        if (!vs.some((v) => isWarm(v, now))) warm = false;
      }
      const venues = Object.fromEntries(venueNames.map((n) => [n, Boolean(conns.get(n)?.connected)]));
      return { enabled: true, mode: refCfg.mode, connected: Object.values(venues).some(Boolean), venues, warm, staleMs: worstStale, messages };
    },
  });
}
