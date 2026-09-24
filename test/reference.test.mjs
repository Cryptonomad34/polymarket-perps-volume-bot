import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createReference, edgeBps, emaStep, warnedSide } from "../src/reference.mjs";
import { decideQuotes, refWarns } from "../src/strategy.mjs";
import { BTC, ETH, testConfig } from "./fixtures.mjs";

const log = { debug() {}, info() {}, warn() {}, error() {} };
const MARKETS = [
  { iid: BTC.iid, symbol: "BTC-USD" },
  { iid: ETH.iid, symbol: "ETH-USD" },
];

// Minimal stand-in for the Binance websocket.
class FakeWs extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    FakeWs.last = this;
  }
  close() {
    this.emit("close", 1000);
  }
  // Push one Binance bookTicker message.
  push(symbol, bid, ask, T = Date.now()) {
    this.emit("message", JSON.stringify({ stream: `${symbol.toLowerCase()}@bookTicker`, data: { s: symbol, b: String(bid), a: String(ask), T } }));
  }
}

const refCfg = (over = {}) => testConfig({ reference: { mode: "gate", basisHalfLifeSec: 300, warmupSec: 120, staleMs: 2000, gateBps: 1.5, ...over } });

// The service stamps each reference update with its own clock, so tests drive
// that clock instead of waiting on the wall one.
function connected(cfg, startAt = 1_000_000) {
  const now = { t: startAt };
  const ref = createReference({ cfg, markets: MARKETS, log, WebSocketImpl: FakeWs, clock: () => now.t });
  ref.start();
  FakeWs.last.emit("open");
  return { ref, ws: FakeWs.last, now };
}

// ---------------------------------------------------------------- pure parts

test("edgeBps: Polymarket below its usual basis gives a positive edge", () => {
  // Normal basis is +10 bps. Right now Polymarket is only +2 bps above
  // Binance, so it is 8 bps low and should rise.
  const binMid = 100_000;
  const pmMid = 100_000 * (1 + 2 / 1e4);
  assert.ok(Math.abs(edgeBps(pmMid, binMid, 10) - 8) < 1e-6);
});

test("edgeBps: a Polymarket mid exactly at its usual basis gives zero edge", () => {
  const binMid = 100_000;
  const pmMid = 100_000 * (1 + 3.5 / 1e4);
  assert.ok(Math.abs(edgeBps(pmMid, binMid, 3.5)) < 1e-6);
});

test("edgeBps: unusable inputs give NaN, never a number to act on", () => {
  assert.ok(Number.isNaN(edgeBps(0, 100, 1)));
  assert.ok(Number.isNaN(edgeBps(100, 0, 1)));
  assert.ok(Number.isNaN(edgeBps(100, 100, NaN)));
});

test("warnedSide: a rising Polymarket warns the ask, a falling one warns the bid", () => {
  assert.equal(warnedSide(2, 1.5), "sell");
  assert.equal(warnedSide(-2, 1.5), "buy");
  assert.equal(warnedSide(1.4, 1.5), null);
  assert.equal(warnedSide(-1.4, 1.5), null);
  assert.equal(warnedSide(1.5, 1.5), "sell", "the threshold itself warns");
  assert.equal(warnedSide(NaN, 1.5), null);
});

test("emaStep: the half-life does not depend on how often it is called", () => {
  // One 1000 ms step must equal five 200 ms steps, or the engine loop rate
  // would silently change the smoothing.
  const halfLife = 300;
  const oneBig = emaStep(0, 10, 1000, halfLife);
  let many = 0;
  for (let i = 0; i < 5; i++) many = emaStep(many, 10, 200, halfLife);
  assert.ok(Math.abs(oneBig - many) < 1e-9, `${oneBig} vs ${many}`);
});

test("emaStep: one half-life closes half the gap", () => {
  assert.ok(Math.abs(emaStep(0, 10, 300_000, 300) - 5) < 1e-9);
});

test("emaStep: the first sample seeds the average instead of decaying from zero", () => {
  assert.equal(emaStep(NaN, 7, 200, 300), 7);
});

// ------------------------------------------------------------ the service

test("mode off never connects and never reports a signal", () => {
  const ref = createReference({ cfg: refCfg({ mode: "off" }), markets: MARKETS, log, WebSocketImpl: FakeWs });
  ref.start();
  assert.equal(ref.enabled, false);
  assert.equal(ref.view(BTC.iid, 100_000).ok, false);
  assert.equal(ref.health().enabled, false);
});

test("a feed that has not warmed up yet reports no signal", () => {
  const { ref, ws, now } = connected(refCfg({ warmupSec: 120 }));
  ws.push("BTCUSDT", 100_000, 100_002, now.t);
  ref.observe(BTC.iid, 100_030, now.t);
  now.t += 1000;
  const v = ref.view(BTC.iid, 100_030, now.t);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "warming");
});

test("a stale feed reports no signal even after warming up", () => {
  const { ref, ws, now } = connected(refCfg({ warmupSec: 10, staleMs: 2000 }));
  for (let i = 0; i < 100; i++, now.t += 200) {
    ws.push("BTCUSDT", 100_000, 100_002, now.t);
    ref.observe(BTC.iid, 100_030, now.t);
  }
  assert.equal(ref.view(BTC.iid, 100_030, now.t).ok, true, "should be usable while fresh");
  // Now let the reference go quiet past staleMs.
  const v = ref.view(BTC.iid, 100_030, now.t + 5000);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "stale");
});

test("a stale reference is not folded into the basis average", () => {
  const { ref, ws, now } = connected(refCfg({ warmupSec: 10, staleMs: 2000, basisHalfLifeSec: 10 }));
  for (let i = 0; i < 100; i++, now.t += 200) {
    ws.push("BTCUSDT", 100_000, 100_000.2, now.t);
    ref.observe(BTC.iid, 100_030, now.t);
  }
  const before = ref.view(BTC.iid, 100_030, now.t).emaBps;
  // Go quiet well past staleMs, then feed a wildly different Polymarket mid.
  // Pairing it with a reference price that old would be meaningless, so it
  // must be ignored entirely.
  now.t += 5000;
  for (let i = 0; i < 100; i++, now.t += 200) ref.observe(BTC.iid, 200_000, now.t);
  ws.push("BTCUSDT", 100_000, 100_000.2, now.t);
  const after = ref.view(BTC.iid, 100_030, now.t).emaBps;
  assert.ok(Math.abs(after - before) < 1e-6, `EMA moved on a stale reference: ${before} -> ${after}`);
});

test("once warm, the edge tracks how far Polymarket has lagged", () => {
  const { ref, ws, now } = connected(refCfg({ warmupSec: 10, basisHalfLifeSec: 600 }));
  // Settle at a +3 bps basis.
  const pm = 100_000 * (1 + 3 / 1e4);
  for (let i = 0; i < 300; i++, now.t += 200) {
    ws.push("BTCUSDT", 100_000, 100_000.2, now.t);
    ref.observe(BTC.iid, pm, now.t);
  }
  const settled = ref.view(BTC.iid, pm, now.t);
  assert.equal(settled.ok, true);
  assert.ok(Math.abs(settled.edgeBps) < 0.2, `settled edge should be near zero, got ${settled.edgeBps}`);

  // Binance jumps 5 bps; Polymarket has not moved yet.
  const jumped = 100_000 * (1 + 5 / 1e4);
  ws.push("BTCUSDT", jumped, jumped * 1.000002, now.t);
  const v = ref.view(BTC.iid, pm, now.t);
  assert.ok(v.edgeBps > 4, `Polymarket is now ~5 bps behind, got ${v.edgeBps}`);
  assert.equal(warnedSide(v.edgeBps, 1.5), "sell", "the stale ask is the exposed side");
});

test("each instrument keeps its own basis", () => {
  const { ref, ws, now } = connected(refCfg({ warmupSec: 10 }));
  for (let i = 0; i < 200; i++, now.t += 200) {
    ws.push("BTCUSDT", 100_000, 100_000.2, now.t);
    ws.push("ETHUSDT", 3_000, 3_000.01, now.t);
    ref.observe(BTC.iid, 100_000 * (1 + 3 / 1e4), now.t);
    ref.observe(ETH.iid, 3_000 * (1 - 2 / 1e4), now.t);
  }
  const btc = ref.view(BTC.iid, 100_000 * (1 + 3 / 1e4), now.t);
  const eth = ref.view(ETH.iid, 3_000 * (1 - 2 / 1e4), now.t);
  assert.ok(Math.abs(btc.emaBps - 3) < 0.5, `BTC basis ${btc.emaBps}`);
  assert.ok(Math.abs(eth.emaBps + 2) < 0.5, `ETH basis ${eth.emaBps}`);
});

// ------------------------------------------------------- observe vs gate

test("observe mode produces a signal but never acts on it", () => {
  const cfg = refCfg({ mode: "observe", warmupSec: 10 });
  const { ref, ws, now } = connected(cfg);
  for (let i = 0; i < 200; i++, now.t += 200) {
    ws.push("BTCUSDT", 100_000, 100_000.2, now.t);
    ref.observe(BTC.iid, 100_000, now.t);
  }
  const jumped = 100_000 * 1.001;
  ws.push("BTCUSDT", jumped, jumped * 1.000002, now.t);
  const v = ref.view(BTC.iid, 100_000, now.t);
  assert.equal(v.ok, true);
  assert.ok(v.edgeBps > 5, "the signal is still computed");
  assert.equal(v.acting, false, "but observe mode must not act");
  assert.equal(refWarns(v, "sell", cfg), false);
});

test("refWarns only fires for the warned side, and only when acting", () => {
  const cfg = refCfg({ gateBps: 1.5 });
  assert.equal(refWarns({ ok: true, acting: true, edgeBps: 2 }, "sell", cfg), true);
  assert.equal(refWarns({ ok: true, acting: true, edgeBps: 2 }, "buy", cfg), false);
  assert.equal(refWarns({ ok: true, acting: false, edgeBps: 2 }, "sell", cfg), false);
  assert.equal(refWarns({ ok: false, acting: true, edgeBps: 2 }, "sell", cfg), false);
  assert.equal(refWarns(null, "sell", cfg), false);
});

// ------------------------------------------------------ strategy behaviour

const base = (over = {}) => ({
  inst: BTC,
  book: { bid: 85_000, ask: 85_001, bidQty: 1, askQty: 1 },
  position: { size: 0, notional: 0 },
  quotes: { buy: null, sell: null },
  bestSince: { buy: 0, sell: 0 },
  lastReplaceAt: { buy: 0, sell: 0 },
  canOpen: true,
  flattening: false,
  blocked: null,
  now: 10_000,
  cfg: refCfg(),
  ref: null,
  ...over,
});
const places = (r) => r.actions.filter((a) => a.type === "place");

test("gate: the warned side stops quoting, the other side carries on", () => {
  const r = decideQuotes(base({ ref: { ok: true, acting: true, edgeBps: 3 } }));
  const p = places(r);
  assert.equal(p.length, 1);
  assert.equal(p[0].side, "buy", "the ask is warned, so only the bid should quote");
});

test("gate: a signal below the threshold changes nothing", () => {
  const p = places(decideQuotes(base({ ref: { ok: true, acting: true, edgeBps: 1.0 } })));
  assert.equal(p.length, 2);
});

test("gate: an unusable reference leaves behaviour exactly as it was", () => {
  for (const ref of [null, { ok: false, edgeBps: NaN }, { ok: false, reason: "stale", edgeBps: 99 }]) {
    assert.equal(places(decideQuotes(base({ ref }))).length, 2, `ref ${JSON.stringify(ref)} must be a no-op`);
  }
});

test("gate: never blocks the side that reduces an open position", () => {
  // Long BTC: "sell" reduces. The signal warns the ask, but blocking it would
  // strand the position until flatten.mjs paid the taker fee to get out.
  const r = decideQuotes(
    base({
      position: { size: 0.0003, notional: 25.5 },
      ref: { ok: true, acting: true, edgeBps: 3 },
    }),
  );
  const p = places(r);
  assert.ok(
    p.some((a) => a.side === "sell"),
    "the reducing ask must still quote",
  );
});

test("gate: cancels a resting quote on the side it warns about", () => {
  const r = decideQuotes(
    base({
      quotes: { buy: { coid: "b", price: 85_000, qty: 0.0003, status: "live" }, sell: { coid: "s", price: 85_001, qty: 0.0003, status: "live" } },
      ref: { ok: true, acting: true, edgeBps: 3 },
    }),
  );
  const cancelled = r.actions.filter((a) => a.type === "cancel");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].side, "sell");
  assert.match(cancelled[0].reason, /reference/);
});

test("gate: a falling signal blocks the bid instead", () => {
  const p = places(decideQuotes(base({ ref: { ok: true, acting: true, edgeBps: -3 } })));
  assert.equal(p.length, 1);
  assert.equal(p[0].side, "sell");
});

test("an instrument with no Binance symbol gets no signal instead of an error", () => {
  const cfg = refCfg({ warmupSec: 10 });
  const ref = createReference({ cfg, markets: [{ iid: 99, symbol: "WTIOIL-USD" }], log, WebSocketImpl: FakeWs });
  ref.start();
  FakeWs.last.emit("open");
  const v = ref.view(99, 90.5);
  assert.equal(v.ok, false, "unmapped instruments must fail closed, not throw");
  ref.observe(99, 90.5); // must not throw
});
