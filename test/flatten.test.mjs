import test from "node:test";
import assert from "node:assert/strict";
import { decideFlatten, flattenTrigger, IDLE, liquidationDistancePct } from "../src/flatten.mjs";
import { cfg, BTC } from "./fixtures.mjs";

const book = (bid = 85_000, ask = 85_001) => ({ bid, ask });
const pos = (over = {}) => ({ size: 0.0003, notional: 25.5, entryPrice: 85_000, openedAt: 0, liqPrice: 77_000, ...over });
const T0 = 1_000_000;
const f = cfg.flatten;

function run(steps) {
  // steps: [{ at, book?, position? }]; returns decisions
  let fstate = IDLE;
  return steps.map((s) => {
    const d = decideFlatten({ inst: BTC, position: pos(s.position), book: s.book ?? book(), fstate, now: s.at, cfg, force: s.force });
    fstate = d.fstate;
    return d;
  });
}

test("no trigger: young, small, far from liquidation -> idle", () => {
  const [d] = run([{ at: T0, position: { openedAt: T0 - 1000 } }]);
  assert.equal(d.fstate.phase, "idle");
  assert.equal(d.standing, null);
  assert.equal(d.ioc, null);
});

test("triggers: inventory cap, position age, liquidation distance", () => {
  const m = 85_000.5;
  assert.equal(flattenTrigger({ position: pos({ notional: 81, openedAt: T0 }), mid: m, now: T0, cfg }), "inventory cap");
  assert.equal(flattenTrigger({ position: pos({ openedAt: T0 - f.maxPositionAgeSec * 1000 - 1 }), mid: m, now: T0, cfg }), "position age");
  assert.equal(flattenTrigger({ position: pos({ openedAt: T0, liqPrice: 83_000 }), mid: m, now: T0, cfg }), "liquidation distance");
  assert.ok(Math.abs(liquidationDistancePct({ liqPrice: 81_600 }, 85_000) - 4) < 1e-9);
});

test("step 1: passive reduce-only post-only at the best exit price", () => {
  const [d] = run([{ at: T0, position: { openedAt: T0 - 61_000 } }]);
  assert.equal(d.fstate.phase, "passive");
  assert.deepEqual(
    { side: d.standing.side, price: d.standing.price, postOnly: d.standing.postOnly, reduceOnly: d.standing.reduceOnly, tif: d.standing.tif },
    { side: "sell", price: 85_001, postOnly: true, reduceOnly: true, tif: "gtc" },
  );
  assert.equal(d.ioc, null);
});

test("step 1 re-pegs to the new best while the window lasts", () => {
  const ds = run([
    { at: T0, position: { openedAt: T0 - 61_000 } },
    { at: T0 + 5_000, position: { openedAt: T0 - 61_000 }, book: book(84_990, 84_991) },
  ]);
  assert.equal(ds[1].standing.price, 84_991);
});

test("step 2: favourable move extends exactly once, then taker", () => {
  const opened = T0 - 61_000;
  const up = book(85_010, 85_011); // mid up 10 ticks, long is in profit
  const ds = run([
    { at: T0, position: { openedAt: opened } },
    { at: T0 + f.passiveSec * 1000, position: { openedAt: opened }, book: up },
    { at: T0 + f.passiveSec * 1000 + 1_000, position: { openedAt: opened }, book: up },
    { at: T0 + (f.passiveSec + f.extendSec) * 1000 + 1, position: { openedAt: opened }, book: up },
  ]);
  assert.equal(ds[1].fstate.phase, "extended");
  assert.equal(ds[2].fstate.phase, "extended");
  assert.equal(ds[3].fstate.phase, "taker");
  assert.ok(ds[3].ioc, "IOC after the single extension");
});

test("step 2 skipped when the move is not favourable -> straight to IOC", () => {
  const opened = T0 - 61_000;
  const ds = run([
    { at: T0, position: { openedAt: opened } },
    { at: T0 + f.passiveSec * 1000, position: { openedAt: opened }, book: book(84_990, 84_991) },
  ]);
  assert.equal(ds[1].fstate.phase, "taker");
  const ioc = ds[1].ioc;
  assert.equal(ioc.tif, "ioc");
  assert.equal(ioc.reduceOnly, true);
  assert.equal(ioc.postOnly, false);
  // Sell limit is capped at iocSlippageBps below the best bid, rounded UP (never worse than the cap).
  assert.ok(ioc.price >= 84_990 * (1 - f.iocSlippageBps / 1e4));
  assert.ok(ioc.price <= 84_990);
});

test("hold cap: position older than maxHoldSec goes straight to taker", () => {
  const [d] = run([{ at: T0, position: { openedAt: T0 - f.maxHoldSec * 1000 } }]);
  assert.equal(d.fstate.phase, "taker");
  assert.ok(d.ioc);
});

test("hold cap applies mid-flatten even during the extension", () => {
  const opened = T0 - (f.maxHoldSec * 1000 - f.passiveSec * 1000 - 2_000);
  const up = book(85_010, 85_011);
  const ds = run([
    { at: T0, position: { openedAt: opened } },
    { at: T0 + f.passiveSec * 1000, position: { openedAt: opened }, book: up },
    { at: T0 + f.passiveSec * 1000 + 3_000, position: { openedAt: opened }, book: up },
  ]);
  assert.equal(ds[1].fstate.phase, "extended");
  assert.equal(ds[2].fstate.phase, "taker", "maxHoldSec reached during extension");
});

test("liquidation distance below threshold skips to taker immediately", () => {
  const [d] = run([{ at: T0, position: { openedAt: T0, liqPrice: 82_000 } }]);
  assert.equal(d.fstate.phase, "taker");
  assert.ok(d.ioc);
});

test("IOC retries are spaced by iocRetryMs", () => {
  const p = { openedAt: T0 - f.maxHoldSec * 1000 };
  const ds = run([{ at: T0, position: p }, { at: T0 + f.iocRetryMs - 1, position: p }, { at: T0 + f.iocRetryMs, position: p }]);
  assert.ok(ds[0].ioc);
  assert.equal(ds[1].ioc, null);
  assert.ok(ds[2].ioc);
});

test("short position exits by buying; forced flatten starts as taker", () => {
  const [d] = run([{ at: T0, position: { size: -0.0003, notional: -25.5, openedAt: T0 }, force: true }]);
  assert.equal(d.ioc.side, "buy");
  assert.ok(d.ioc.price <= 85_001 * (1 + f.iocSlippageBps / 1e4));
});

test("flat position resets to idle; unexpressible dust does not loop", () => {
  assert.equal(run([{ at: T0, position: { size: 0, notional: 0 } }])[0].fstate.phase, "idle");
  const [d] = run([{ at: T0, position: { size: 0.000001, notional: 0.085, openedAt: 0 } }]);
  assert.equal(d.fstate.phase, "dust");
  assert.equal(d.ioc, null);
});
