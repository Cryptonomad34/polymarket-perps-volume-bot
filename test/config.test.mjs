import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, validateConfig } from "../src/config.mjs";
import { rawConfig } from "./fixtures.mjs";

function errorsFor(mutate) {
  const c = rawConfig();
  mutate(c);
  try {
    validateConfig(c);
    return [];
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.errors;
  }
}

test("example config is valid and frozen", () => {
  const c = validateConfig(rawConfig());
  assert.equal(c.mode, "live");
  assert.throws(() => {
    c.quote.notionalUsd = 1;
  });
});

test("specific, human-readable errors", () => {
  assert.deepEqual(errorsFor((c) => (c.flatten.maxHoldSec = 900)), ["config.flatten.maxHoldSec must be ≤ 300 (got 900)"]);
  assert.deepEqual(errorsFor((c) => (c.mode = "paper")), ['config.mode must be one of "dry", "live" (got "paper")']);
  assert.deepEqual(errorsFor((c) => delete c.mode), []); // optional: the bot defaults to live
  assert.deepEqual(errorsFor((c) => (c.leverage.value = 10.5)), ["config.leverage.value must be a whole number (got 10.5)"]);
  assert.deepEqual(errorsFor((c) => delete c.risk.dailyLossUsd), ["config.risk.dailyLossUsd is missing"]);
  assert.deepEqual(errorsFor((c) => (c.quote.notonalUsd = 5)), ["config.quote.notonalUsd is not a known setting"]);
  // Matched by shape, not by the exact list: which markets are vetted changes
  // as instruments are checked out, and that is not what this test is about.
  assert.match(errorsFor((c) => (c.markets = ["BTC-USD", "NOPE-USD"]))[0], /^config\.markets contains "NOPE-USD"; only .+ are supported$/);
  assert.deepEqual(errorsFor((c) => (c.budget.dailyCostUsd = "10")), ['config.budget.dailyCostUsd must be a number (got "10")']);
});

test("cross-field rules", () => {
  assert.match(errorsFor((c) => (c.autoCancel.rearmSec = 15))[0], /rearmSec \(15\) must be < aheadSec/);
  assert.match(errorsFor((c) => ((c.flatten.maxHoldSec = 120), (c.flatten.passiveSec = 100), (c.flatten.extendSec = 100)))[0], /maxHoldSec \(120\) must be ≥ passiveSec \+ extendSec/);
  assert.match(errorsFor((c) => ((c.inventory.skewAtUsd = 70), (c.inventory.maxNotionalUsd = 50), (c.quote.notionalUsd = 25)))[0], /skewAtUsd \(70\) must be ≤ maxNotionalUsd/);
  assert.match(errorsFor((c) => ((c.quote.notionalUsd = 40), (c.inventory.maxNotionalUsd = 30)))[0], /notionalUsd \(40\) must be ≤ inventory.maxNotionalUsd/);
});

test("reports every problem at once", () => {
  const errs = errorsFor((c) => {
    c.quote.notionalUsd = 1000;
    c.risk.staleMs = 5;
  });
  assert.equal(errs.length, 2);
});

// ------------------------------------------------------------ fair mode

const FAIR = { edgeBps: 1, levels: 2, levelStepBps: 1, cancelEdgeBps: 0.3, maxDistanceBps: 6, imbalanceWeight: 0.5, skewBps: 1.5, maxDeviationBps: 15 };

test("configs written before fair mode existed still load, as join mode", () => {
  const c = rawConfig();
  delete c.strategy;
  delete c.fair;
  delete c.reference.venues;
  const v = validateConfig(c);
  assert.equal(v.strategy, undefined);
});

test("fair mode needs its settings and a reference in gate mode", () => {
  const c = rawConfig();
  c.strategy = { mode: "fair" };
  delete c.fair;
  c.reference.mode = "observe";
  assert.throws(() => validateConfig(c), (e) => /config\.fair is missing/.test(e.message) && /reference\.mode must be "gate"/.test(e.message));
  c.fair = FAIR;
  c.reference.mode = "gate";
  assert.equal(validateConfig(c).strategy.mode, "fair");
});

test("fair settings: cancel distance below the edge, deepest level inside maxDistance", () => {
  const c = rawConfig();
  c.fair = { ...FAIR, cancelEdgeBps: 1 };
  assert.throws(() => validateConfig(c), /cancelEdgeBps \(1\) must be < edgeBps/);
  c.fair = { ...FAIR, levels: 5, levelStepBps: 2, maxDistanceBps: 6 };
  assert.throws(() => validateConfig(c), /maxDistanceBps \(6\) must exceed the deepest level/);
  c.fair = { ...FAIR, bogus: 1 };
  assert.throws(() => validateConfig(c), /config\.fair\.bogus is not a known setting/);
});

test("reference venues: known names only, no duplicates", () => {
  const c = rawConfig();
  c.reference.venues = ["binance", "bybit", "okx"];
  assert.deepEqual([...validateConfig(c).reference.venues], ["binance", "bybit", "okx"]);
  c.reference.venues = ["binance", "kraken"];
  assert.throws(() => validateConfig(c), /contains "kraken"/);
  c.reference.venues = ["okx", "okx"];
  assert.throws(() => validateConfig(c), /contains duplicates/);
});
