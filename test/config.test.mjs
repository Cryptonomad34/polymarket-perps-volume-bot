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
  assert.equal(c.mode, "dry");
  assert.throws(() => {
    c.quote.notionalUsd = 1;
  });
});

test("specific, human-readable errors", () => {
  assert.deepEqual(errorsFor((c) => (c.flatten.maxHoldSec = 900)), ["config.flatten.maxHoldSec must be ≤ 300 (got 900)"]);
  assert.deepEqual(errorsFor((c) => (c.mode = "paper")), ['config.mode must be one of "dry", "live" (got "paper")']);
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
