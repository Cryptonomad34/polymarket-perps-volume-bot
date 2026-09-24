import test from "node:test";
import assert from "node:assert/strict";
import { autoCancelHeadroomLow, costUsed, evaluate, netPnl } from "../src/risk.mjs";
import { classifyError } from "../src/api.mjs";
import { snapshotIsFresh } from "../src/engine.mjs";
import { emptyDaily } from "../src/state.mjs";
import { cfg } from "./fixtures.mjs";

const NOW = 1_800_000_000_000;
const snap = (over = {}) => ({
  now: NOW,
  cfg,
  daily: { ...emptyDaily("2026-09-22"), unrealized: 0 },
  consecutiveFatal: 0,
  feed: { connected: true, downSince: null, disconnectsToday: 0 },
  stale: { 6: { staleMs: 100, staleSince: null }, 7: { staleMs: 100, staleSince: null } },
  autoCancel: { enabled: true, triggered: 0, dailyLimit: 1000, fatalError: null },
  live: true,
  ...over,
});

test("healthy snapshot trades", () => {
  const r = evaluate(snap());
  assert.equal(r.ok, true);
  assert.equal(r.stop, null);
  assert.equal(r.canOpen, true);
  assert.deepEqual(r.cancelIids, []);
});

test("daily loss stop counts trading P&L, fees and funding", () => {
  const daily = { ...emptyDaily("d"), realized: -6, unrealized: -2, makerFees: 1, takerFees: 0.5, funding: 0.5 };
  assert.equal(netPnl(daily), -10);
  const r = evaluate(snap({ daily }));
  assert.equal(r.stop.reason, "daily loss stop");
  const ok = evaluate(snap({ daily: { ...daily, funding: 0.49 } }));
  assert.equal(ok.stop, null);
});

test("cost budget = all-in cost (fees + funding - trading P&L); spent budget blocks opening, not a stop", () => {
  // Rebates cancel the fees, but the position lost money: that loss is cost.
  const rebate = { ...emptyDaily("d"), makerFees: -0.08, takerFees: 0.09, slippage: -0.01, realized: -0.2, unrealized: -0.15 };
  assert.ok(Math.abs(costUsed(rebate) - 0.36) < 1e-12);
  // Budget $5 below the $10 loss stop: at $6 of cost the bot stops opening
  // new positions but keeps running (reduce-only) instead of stopping.
  const lowBudget = { ...cfg, budget: { dailyCostUsd: 5 } };
  const daily = { ...emptyDaily("d"), makerFees: 3, takerFees: 1, funding: 0.5, slippage: 0.5, realized: -1.5 };
  assert.equal(costUsed(daily), 6);
  const r = evaluate(snap({ cfg: lowBudget, daily }));
  assert.equal(r.stop, null);
  assert.equal(r.canOpen, false);
  assert.equal(evaluate(snap({ cfg: lowBudget, daily: { ...daily, realized: 2 } })).canOpen, true, "cost 2.5 < 5");
});

test("three consecutive Fatal API errors stop trading", () => {
  assert.equal(evaluate(snap({ consecutiveFatal: 2 })).stop, null);
  assert.equal(evaluate(snap({ consecutiveFatal: 3 })).stop.reason, "consecutive API errors");
});

test("error classes: only genuine errors are Fatal", () => {
  assert.equal(classifyError(429, "too many requests"), "RateLimited");
  assert.equal(classifyError(400, "action_rate_limited"), "RateLimited");
  assert.equal(classifyError(400, "ip_rate_limited"), "RateLimited");
  assert.equal(classifyError(503, "service_unavailable"), "Indeterminate");
  assert.equal(classifyError(500, "internal_error"), "Indeterminate");
  assert.equal(classifyError(200, "order_in_flight"), "Maintenance");
  assert.equal(classifyError(200, "exchange is in cancel-only mode"), "Maintenance");
  assert.equal(classifyError(200, "post only order would cross"), "PostOnlyReject");
  assert.equal(classifyError(400, "reduce_only_invalid"), "StaleState");
  assert.equal(classifyError(400, "position_not_found"), "StaleState");
  assert.equal(classifyError(400, "invalid signature"), "Fatal");
  assert.equal(classifyError(400, "insufficient margin"), "Fatal");
});

// Regression: on 2026-09-22 a portfolio snapshot that had been requested
// *before* a flatten IOC filled was adopted, resurrecting a closed position.
// The bot then sent reduce-only orders the exchange rejected once a second,
// and three Fatal rejects in a row stopped it for the whole UTC day.
test("stale position snapshot is not adopted over a newer fill", () => {
  const requestedAt = 1_000_000;
  assert.equal(snapshotIsFresh(requestedAt, requestedAt - 50), true, "fill before the request: trust the snapshot");
  assert.equal(snapshotIsFresh(requestedAt, requestedAt + 95), false, "fill after the request: keep our own position");
  assert.equal(snapshotIsFresh(requestedAt, 0), true, "no fill yet");
  assert.equal(snapshotIsFresh(undefined, 0), true, "executor without a timestamp keeps the old behaviour");
});

test("a rejected reduce-only order does not count toward the daily stop", () => {
  // Only Fatal increments consecutiveFatal, so a StaleState reject can never
  // reach the 3-strikes rule no matter how often the exchange sends it.
  assert.notEqual(classifyError(400, "reduce_only_invalid"), "Fatal");
  assert.equal(evaluate(snap({ consecutiveFatal: 0 })).stop, null);
});

test("WebSocket down: cancel everything; stop if not restored within grace", () => {
  const down = evaluate(snap({ feed: { connected: false, downSince: NOW - 10_000, disconnectsToday: 1 } }));
  assert.equal(down.stop, null);
  assert.equal(down.cancelIids, "all");
  const late = evaluate(snap({ feed: { connected: false, downSince: NOW - (cfg.risk.reconnectGraceSec * 1000 + 1), disconnectsToday: 1 } }));
  assert.equal(late.stop.reason, "WebSocket not restored in time");
});

test("4th disconnect in a UTC day stops trading (limit 3)", () => {
  assert.equal(evaluate(snap({ feed: { connected: true, downSince: null, disconnectsToday: 3 } })).stop, null);
  assert.equal(evaluate(snap({ feed: { connected: true, downSince: null, disconnectsToday: 4 } })).stop.reason, "too many WebSocket disconnects today");
});

test("stale data cancels that instrument; stale past grace stops", () => {
  const r = evaluate(snap({ stale: { 6: { staleMs: 6_000, staleSince: NOW - 6_000 }, 7: { staleMs: 100, staleSince: null } } }));
  assert.equal(r.stop, null);
  assert.deepEqual(r.cancelIids, [6]);
  const s = evaluate(snap({ stale: { 6: { staleMs: 40_000, staleSince: NOW - 31_000 }, 7: { staleMs: 100, staleSince: null } } }));
  assert.equal(s.stop.reason, "market data stale");
});

test("auto-cancel: near the daily fire limit or failed arming stops (live only)", () => {
  assert.equal(autoCancelHeadroomLow({ triggered: 7, dailyLimit: 10 }), false);
  assert.equal(autoCancelHeadroomLow({ triggered: 8, dailyLimit: 10 }), true);
  assert.equal(autoCancelHeadroomLow({ triggered: 899, dailyLimit: 1000 }), false);
  assert.equal(autoCancelHeadroomLow({ triggered: 900, dailyLimit: 1000 }), true);
  assert.equal(autoCancelHeadroomLow({ triggered: NaN, dailyLimit: NaN }), false);
  assert.equal(evaluate(snap({ autoCancel: { enabled: true, triggered: 8, dailyLimit: 10 } })).stop.reason, "auto-cancel daily fire limit nearly used");
  assert.equal(evaluate(snap({ autoCancel: { enabled: true, fatalError: "boom" } })).stop.reason, "auto-cancel could not be armed");
  assert.equal(evaluate(snap({ live: false, autoCancel: { enabled: true, triggered: 9, dailyLimit: 10 } })).stop, null);
});
