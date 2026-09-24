import test from "node:test";
import assert from "node:assert/strict";
import { adverseSignals, decideQuotes, isOpeningSide } from "../src/strategy.mjs";
import { cfg, testConfig, BTC } from "./fixtures.mjs";

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
  cfg,
  ...over,
});
const places = (r) => r.actions.filter((a) => a.type === "place");
const cancels = (r) => r.actions.filter((a) => a.type === "cancel");
const live = (coid, price, status = "live") => ({ coid, price, qty: 0.0003, status });

test("joins best bid and best ask, post-only sizes meet min notional", () => {
  const r = decideQuotes(base());
  const p = places(r);
  assert.equal(p.length, 2);
  assert.deepEqual(p.map((a) => [a.side, a.price]), [["buy", 85_000], ["sell", 85_001]]);
  for (const a of p) assert.ok(a.qty * a.price >= BTC.minNotional, "notional below minimum");
});

test("never quotes into a locked or crossed book", () => {
  assert.equal(places(decideQuotes(base({ book: { bid: 85_001, ask: 85_001, bidQty: 1, askQty: 1 } }))).length, 0);
  assert.equal(places(decideQuotes(base({ book: { bid: 85_002, ask: 85_001, bidQty: 1, askQty: 1 } }))).length, 0);
  assert.equal(places(decideQuotes(base({ book: { bid: NaN, ask: 85_001 } }))).length, 0);
});

test("keeps an order that is still at the best price (no churn)", () => {
  const r = decideQuotes(base({ quotes: { buy: live("b", 85_000), sell: live("s", 85_001) } }));
  assert.equal(r.actions.length, 0);
});

test("debounce: does not chase a best price that just changed", () => {
  const r = decideQuotes(base({ quotes: { buy: live("b", 84_999), sell: live("s", 85_001) }, bestSince: { buy: 9_900, sell: 0 } }));
  assert.equal(r.actions.length, 0, "moved 100ms ago < debounceMs 300");
});

test("rejoins once the new best has persisted and pacing allows", () => {
  const r = decideQuotes(base({ quotes: { buy: live("b", 84_999), sell: live("s", 85_001) }, bestSince: { buy: 9_000, sell: 0 } }));
  assert.deepEqual(cancels(r).map((a) => a.coid), ["b"]);
  assert.equal(places(r)[0].price, 85_000);
});

test("pacing: no replace faster than minReplaceMs", () => {
  const r = decideQuotes(base({ quotes: { buy: live("b", 84_999), sell: live("s", 85_001) }, bestSince: { buy: 0, sell: 0 }, lastReplaceAt: { buy: 9_900, sell: 0 } }));
  assert.equal(r.actions.length, 0);
});

test("waits for a pending/cancelling order instead of stacking another", () => {
  const r = decideQuotes(base({ quotes: { buy: live("b", 84_999, "pending"), sell: live("s", 85_001, "cancelling") } }));
  assert.equal(places(r).length, 0);
});

test("inventory cap stops the side that would grow the position", () => {
  const r = decideQuotes(base({ position: { size: 0.0009, notional: 76.5 } })); // +25 would exceed 80
  assert.deepEqual(places(r).map((a) => a.side), ["sell"]);
  const s = decideQuotes(base({ position: { size: -0.0009, notional: -76.5 } }));
  assert.deepEqual(places(s).map((a) => a.side), ["buy"]);
});

test("cost budget spent: only the reducing side is quoted; flat -> nothing", () => {
  assert.equal(places(decideQuotes(base({ canOpen: false }))).length, 0);
  const r = decideQuotes(base({ canOpen: false, position: { size: 0.0003, notional: 25.5 } }));
  assert.deepEqual(places(r).map((a) => a.side), ["sell"]);
});

test("self-trade guard: never places a bid at or above our own resting ask", () => {
  // Our stale ask sits at 85_000 (a best bid of 85_000 would cross it).
  const r = decideQuotes(base({ quotes: { buy: null, sell: live("s", 85_000, "cancelling") } }));
  assert.ok(!places(r).some((a) => a.side === "buy"), "bid would cross our own ask");
});

test("flattening or blocked: cancels all quotes, places none", () => {
  const q = { buy: live("b", 85_000), sell: live("s", 85_001) };
  for (const over of [{ flattening: true }, { blocked: "stale data" }]) {
    const r = decideQuotes(base({ quotes: q, ...over }));
    assert.equal(places(r).length, 0);
    assert.deepEqual(cancels(r).map((a) => a.coid).sort(), ["b", "s"]);
  }
});

test("opening side definition", () => {
  assert.equal(isOpeningSide("buy", 0), true);
  assert.equal(isOpeningSide("sell", 0), true);
  assert.equal(isOpeningSide("buy", -1), false);
  assert.equal(isOpeningSide("sell", 1), false);
});

// ---- adverse-selection back-off ----

const sig = (over = {}) =>
  adverseSignals({ book: { bid: 85_000, ask: 85_001, bidQty: 1, askQty: 1 }, position: { size: 0, notional: 0 }, quotes: { buy: null, sell: null }, flow: null, cfg, ...over });

test("adverse: balanced deep book, no flow, flat -> join both sides", () => {
  assert.deepEqual(sig(), { buy: null, sell: null });
});

test("adverse: thin queue on one side backs that side off", () => {
  assert.equal(sig({ book: { bid: 85_000, ask: 85_001, bidQty: 0.001, askQty: 1 } }).buy, "thin bid queue");
});

test("adverse: book imbalance backs off the light side", () => {
  const s = sig({ book: { bid: 85_000, ask: 85_001, bidQty: 0.1, askQty: 1 } }); // bid share 9%
  assert.equal(s.buy, "book leaning down");
  assert.equal(s.sell, null);
  assert.equal(sig({ book: { bid: 85_000, ask: 85_001, bidQty: 1, askQty: 0.1 } }).sell, "book leaning up");
});

test("adverse: one-sided taker flow backs off the side being hit", () => {
  assert.equal(sig({ flow: { buyUsd: 900, sellUsd: 100 } }).sell, "aggressive buying");
  assert.equal(sig({ flow: { buyUsd: 100, sellUsd: 900 } }).buy, "aggressive selling");
  assert.deepEqual(sig({ flow: { buyUsd: 90, sellUsd: 10 } }), { buy: null, sell: null }, "below minFlowUsd is noise");
});

test("adverse: holding inventory backs off the side that adds to it", () => {
  assert.equal(sig({ position: { size: 0.0003, notional: 25 } }).buy, "holding inventory");
  assert.equal(sig({ position: { size: -0.0003, notional: -25 } }).sell, "holding inventory");
});

test("adverse: live book includes our own order, which is subtracted", () => {
  // Balanced book, 0.0061 BTC at the best bid, of which 0.0003 is ours.
  const book = { bid: 85_000, ask: 85_001, bidQty: 0.0061, askQty: 0.0061 };
  const quotes = { buy: { coid: "b", price: 85_000, qty: 0.0003, status: "live" }, sell: null };
  assert.equal(sig({ book, quotes, bookIncludesOwn: false }).buy, null, "0.0061 BTC = $518.50 >= $500");
  assert.equal(sig({ book, quotes, bookIncludesOwn: true }).buy, "thin bid queue", "without ours 0.0058 BTC = $493 < $500");
});

test("adverse: disabled switch turns every signal off", () => {
  const off = { ...cfg, quote: { ...cfg.quote, adverse: { ...cfg.quote.adverse, enabled: false } } };
  assert.deepEqual(sig({ cfg: off, book: { bid: 85_000, ask: 85_001, bidQty: 0, askQty: 1 }, flow: { buyUsd: 1e6, sellUsd: 0 } }), { buy: null, sell: null });
});

test("adverse side quotes one tick behind the best; other side still joins", () => {
  const r = decideQuotes(base({ book: { bid: 85_000, ask: 85_001, bidQty: 0.1, askQty: 1 } }));
  const p = Object.fromEntries(places(r).map((a) => [a.side, a]));
  assert.equal(p.buy.price, 84_999);
  assert.match(p.buy.reason, /back off: book leaning down/);
  assert.equal(p.sell.price, 85_001);
  assert.equal(r.adverse.buy, "book leaning down");
});

test("hysteresis: a side stays backed off until adverseUntil", () => {
  const r = decideQuotes(base({ adverseUntil: { buy: 20_000, sell: 0 } }));
  assert.equal(places(r).find((a) => a.side === "buy").price, 84_999);
  const later = decideQuotes(base({ adverseUntil: { buy: 5_000, sell: 0 } }));
  assert.equal(places(later).find((a) => a.side === "buy").price, 85_000);
});

// ---- inventory skew: the reducing side is the exit, not a taker flatten ----

const skewCfg = testConfig({ inventory: { skewAtUsd: 25, maxNotionalUsd: 80 }, quote: { notionalUsd: 25 } });
const skewBase = (over = {}) => base({ cfg: skewCfg, ...over });

test("skew: flat -> quotes both sides as usual", () => {
  const p = places(decideQuotes(skewBase()));
  assert.deepEqual(p.map((a) => a.side).sort(), ["buy", "sell"]);
});

test("skew: holding long -> only the ask quotes, sized to the whole position", () => {
  const size = 0.0003; // $25.50 at 85,000
  const r = decideQuotes(skewBase({ position: { size, notional: size * 85_000 } }));
  const p = places(r);
  assert.equal(p.length, 1, "the buy side must not add to the position");
  assert.equal(p[0].side, "sell");
  assert.equal(p[0].qty, size, "one fill leaves us flat, with no dust");
  assert.equal(p[0].reason, "reduce at best");
  assert.equal(p[0].price, 85_001, "exits at the best ask, earning the rebate");
});

test("skew: holding short -> only the bid quotes", () => {
  const size = -0.0003;
  const p = places(decideQuotes(skewBase({ position: { size, notional: size * 85_000 } })));
  assert.equal(p.length, 1);
  assert.equal(p[0].side, "buy");
  assert.equal(p[0].qty, 0.0003);
});

test("skew: below the threshold both sides still quote", () => {
  const size = 0.0001; // $8.50, under skewAtUsd $25
  const p = places(decideQuotes(skewBase({ position: { size, notional: size * 85_000 } })));
  assert.equal(p.length, 2, "a small position does not stop the opening side");
});

test("skew: a reduce quote below min notional falls back to the normal size", () => {
  const size = 0.00005; // $4.25, under BTC min notional $10
  const p = places(decideQuotes(skewBase({ position: { size, notional: 26 } }))); // notional forces the skew
  assert.equal(p.length, 1);
  assert.ok(p[0].qty * p[0].price >= BTC.minNotional, "never places an order the exchange would reject");
});

test("skew: a resting reduce quote is resized when the position changes", () => {
  const size = 0.0006;
  const r = decideQuotes(skewBase({
    position: { size, notional: size * 85_000 },
    quotes: { buy: null, sell: { coid: "s", price: 85_001, qty: 0.0003, status: "live" } },
  }));
  const p = places(r);
  assert.equal(cancels(r).length, 1, "the stale size is cancelled");
  assert.equal(p.length, 1);
  assert.equal(p[0].qty, size);
  assert.equal(p[0].replaces, "s");
});

test("skew off (skewAtUsd = cap) keeps the old two-sided behaviour", () => {
  const size = 0.0003;
  const p = places(decideQuotes(base({ position: { size, notional: size * 85_000 } })));
  assert.equal(p.length, 2, "fixture cfg has the skew disabled");
});

test("skew: a partly filled reduce quote is left alone (its remainder already matches)", () => {
  const size = 0.0003; // half of a 0.0006 order already filled
  const r = decideQuotes(skewBase({
    position: { size, notional: size * 85_000 },
    quotes: { buy: null, sell: { coid: "s", price: 85_001, qty: 0.0006, remaining: 0.0003, status: "live" } },
  }));
  assert.equal(r.actions.length, 0, "re-posting would only cost queue position");
});
