import test from "node:test";
import assert from "node:assert/strict";
import { decideLadder, orderIsSafe, sideCapacity, unsafeOrders } from "../src/ladder.mjs";
import { BTC, ETH, testConfig } from "./fixtures.mjs";

const cfg = testConfig({
  fair: { edgeBps: 1, levels: 2, levelStepBps: 1, cancelEdgeBps: 0.3, maxDistanceBps: 6, imbalanceWeight: 0.5, skewBps: 1.5, maxDeviationBps: 15 },
  inventory: { maxNotionalUsd: 80, skewAtUsd: 80 },
  quote: { notionalUsd: 25 },
});

// BTC at 85,000 ticks at $1. Fair 85,000.5: 1 bps = $8.50005.
//   bids round down: L0 84,991 (84,991.99995)   L1 84,983 (84,983.4999)
//   asks round up:   L0 85,010 (85,009.00005)   L1 85,018 (85,017.5001)
// RESTING below holds orders placed a little earlier, one tick nearer.
const BOOK = { bid: 85_000, ask: 85_001, bidQty: 1, askQty: 1 };
const FAIR = { ok: true, fair: 85_000.5 };
const live = (coid, price, level = 0, qty = 0.0003) => ({ coid, price, qty, remaining: qty, status: "live", level });
const RESTING = { buy: [live("b0", 84_992, 0), live("b1", 84_983, 1)], sell: [live("s0", 85_009, 0), live("s1", 85_018, 1)] };

const run = (over = {}) =>
  decideLadder({
    inst: BTC,
    book: BOOK,
    position: { size: 0, notional: 0 },
    orders: { buy: [], sell: [] },
    fairView: FAIR,
    canOpen: true,
    flattening: false,
    blocked: null,
    cfg,
    ...over,
  });
const places = (r, side) => r.actions.filter((a) => a.type === "place" && (!side || a.side === side));
const cancels = (r) => r.actions.filter((a) => a.type === "cancel");

test("an empty ladder rests every level around fair value, behind the best price", () => {
  const r = run();
  assert.deepEqual(places(r, "buy").map((a) => [a.price, a.level]), [[84_991, 0], [84_983, 1]]);
  assert.deepEqual(places(r, "sell").map((a) => [a.price, a.level]), [[85_010, 0], [85_018, 1]]);
  for (const a of places(r)) {
    assert.ok(a.qty * a.price >= BTC.minNotional && a.qty * a.price <= 25.01, `quote size ${a.qty * a.price}`);
    assert.equal(a.fair, 85_000.5, "the order remembers the fair value it was priced from");
  }
});

test("queue priority: a safe order is left alone however the best price moves", () => {
  // The book moved several ticks; fair value did not. The join strategy would
  // cancel and re-join here, going to the back of the queue. This must not.
  const r = run({ orders: RESTING, book: { bid: 84_996, ask: 84_997, bidQty: 1, askQty: 1 } });
  assert.deepEqual(r.actions, []);
});

test("an order fair value has come too close to is cancelled, the rest stay", () => {
  // Fair drops to 84,993: the 84,992 bid is now within 0.3 bps (2.55) of it.
  const r = run({ orders: RESTING, fairView: { ok: true, fair: 84_993 } });
  assert.deepEqual(cancels(r).map((a) => a.coid), ["b0"]);
  assert.match(cancels(r)[0].reason, /unsafe/);
  // The freed slot is refilled at the new level 0; the deep bid keeps its queue.
  assert.deepEqual(places(r, "buy").map((a) => a.price), [84_984]);
  assert.equal(places(r, "sell").length, 0, "asks are further from fair now: still safe, still useful");
});

test("an order left too far behind by the market is cancelled and re-placed nearer", () => {
  const r = run({ orders: RESTING, fairView: { ok: true, fair: 85_060 }, book: { bid: 85_059, ask: 85_060, bidQty: 1, askQty: 1 } });
  const gone = cancels(r).map((a) => a.coid).sort();
  assert.ok(gone.includes("b0") && gone.includes("b1"), `bids > 6 bps behind fair should go: ${gone}`);
  assert.ok(gone.includes("s0") && gone.includes("s1"), "asks now below fair are unsafe");
});

test("inventory cap: a side only rests what can fill without breaching the cap", () => {
  // Long $60 with an $80 cap: $20 of room on the bid, less than one $25 quote.
  const r = run({ position: { size: 60 / 85_000.5, notional: 60 }, fairView: { ok: true, fair: 85_000.5 } });
  assert.equal(places(r, "buy").length, 0);
  assert.equal(places(r, "sell").length, 2, "the reducing side has plenty of room");
  // An already-resting bid that no longer fits is cut, deepest first.
  const r2 = run({ position: { size: 40 / 85_000.5, notional: 40 }, orders: { buy: RESTING.buy, sell: [] } });
  assert.deepEqual(cancels(r2).map((a) => a.coid), ["b1"]);
  assert.match(cancels(r2)[0].reason, /inventory cap/);
});

test("no fair value: only an existing position is worked off, sized to all of it", () => {
  const pos = { size: 0.0003, notional: 0.0003 * 85_000.5 };
  const r = run({ position: pos, fairView: { ok: false, reason: "reference stale" }, orders: { buy: [live("b0", 84_992)], sell: [] } });
  assert.deepEqual(cancels(r).map((a) => a.coid), ["b0"]);
  assert.match(cancels(r)[0].reason, /no fair value \(reference stale\)/);
  const sells = places(r, "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0].qty, 0.0003, "the whole position, even though the exit is priced above the mid");
  assert.ok(sells[0].price > BOOK.ask, "priced off the microprice plus edge, not given away");
  assert.equal(places(r, "buy").length, 0);
  // Flat with no fair value: nothing at all.
  assert.deepEqual(run({ fairView: { ok: false, reason: "warming" } }).actions, []);
});

test("cost budget spent: only the reducing side, sized to the position", () => {
  const r = run({ canOpen: false, position: { size: -0.0003, notional: -0.0003 * 85_000.5 } });
  assert.equal(places(r, "sell").length, 0);
  assert.equal(places(r, "buy").length, 1);
  assert.equal(places(r, "buy")[0].qty, 0.0003);
  assert.match(places(r, "buy")[0].reason, /cost budget/);
});

test("in a wide book the ladder steps inside the spread when fair value allows", () => {
  // ETH-like instrument with a 5 bps spread: fair 600.15, 1 bps = 0.06.
  const r = run({ inst: ETH, book: { bid: 600.0, ask: 600.3, bidQty: 1, askQty: 1 }, fairView: { ok: true, fair: 600.15 } });
  const bid0 = places(r, "buy").find((a) => a.level === 0);
  const ask0 = places(r, "sell").find((a) => a.level === 0);
  assert.ok(bid0.price > 600.0 && bid0.price < 600.15, `bid inside the spread: ${bid0.price}`);
  assert.ok(ask0.price < 600.3 && ask0.price > 600.15, `ask inside the spread: ${ask0.price}`);
});

test("post-only: a target never reaches the opposite best price", () => {
  // Fair far above the book: the bid would be above the ask. It is capped a tick below.
  const r = run({ fairView: { ok: true, fair: 85_012 }, book: { bid: 85_000, ask: 85_001, bidQty: 1, askQty: 1 } });
  for (const a of places(r, "buy")) assert.ok(a.price < 85_001, `bid ${a.price} would cross`);
});

test("never at or through our own opposite order, even one still being cancelled", () => {
  const r = run({ orders: { buy: [], sell: [{ ...live("s0", 84_990), status: "cancelling" }] } });
  for (const a of places(r, "buy")) assert.ok(a.price < 84_990, `bid ${a.price} would trade with our own ask`);
});

test("flattening or blocked: every ladder order is cancelled", () => {
  for (const over of [{ flattening: true }, { blocked: "stale market data" }]) {
    const r = run({ orders: RESTING, ...over });
    assert.equal(cancels(r).length, 4);
    assert.equal(places(r).length, 0);
  }
});

test("unsafeOrders: only acknowledged orders fair value threatens", () => {
  const orders = { buy: [live("b0", 84_992), { ...live("bp", 84_992.5), status: "pending" }], sell: [live("s0", 85_009)] };
  assert.deepEqual(unsafeOrders({ fair: 84_993, orders, cfg }).map((u) => u.coid), ["b0"]);
  assert.deepEqual(unsafeOrders({ fair: 85_000.5, orders, cfg }), []);
  assert.deepEqual(unsafeOrders({ fair: NaN, orders, cfg }), []);
});

test("orderIsSafe and sideCapacity basics", () => {
  assert.equal(orderIsSafe("buy", 99.9, 100, cfg), true);
  assert.equal(orderIsSafe("buy", 99.999, 100, cfg), false);
  assert.equal(orderIsSafe("sell", 100.1, 100, cfg), true);
  assert.equal(sideCapacity("buy", { size: 0, notional: 0 }, 80, false).limit, 80);
  assert.equal(sideCapacity("sell", { size: 0.001, notional: 30 }, 80, false).limit, 110);
  assert.equal(sideCapacity("buy", { size: 0.001, notional: 30 }, 80, true).limit, 0, "reduce-only never adds");
  assert.equal(sideCapacity("sell", { size: 0.001, notional: 30 }, 80, true).limit, 0.001, "measured in quantity");
});
