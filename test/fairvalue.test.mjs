import test from "node:test";
import assert from "node:assert/strict";
import { fairValue, microprice } from "../src/fairvalue.mjs";
import { testConfig } from "./fixtures.mjs";

const cfg = testConfig({ fair: { imbalanceWeight: 0.5, skewBps: 2, maxDeviationBps: 15 }, inventory: { maxNotionalUsd: 80, skewAtUsd: 80 } });
const book = (bidQty = 1, askQty = 1) => ({ bid: 100_000, ask: 100_001, bidQty, askQty });
const ref = (refFair) => ({ ok: true, acting: true, refFair, edgeBps: 0 });
const flat = { size: 0, notional: 0 };

test("microprice leans toward the side with less size", () => {
  // Big bid, small ask: buyers are about to lift the ask, so fair is near it.
  assert.ok(microprice(book(9, 1)) > 100_000.5);
  assert.ok(microprice(book(1, 9)) < 100_000.5);
  assert.equal(microprice(book(1, 1)), 100_000.5);
  assert.equal(microprice({ bid: 100, ask: 101, bidQty: 0, askQty: 5 }), 100.5, "no size on a side: plain mid");
});

test("fair value is the reference price, nudged by the book's imbalance", () => {
  const even = fairValue({ ref: ref(100_000.5), book: book(), position: flat, cfg });
  assert.equal(even.ok, true);
  assert.equal(even.fair, 100_000.5);
  const leaning = fairValue({ ref: ref(100_000.5), book: book(9, 1), position: flat, cfg });
  const micro = microprice(book(9, 1));
  assert.ok(Math.abs(leaning.fair - (100_000.5 + 0.5 * (micro - 100_000.5))) < 1e-9);
});

test("inventory shifts fair value: long lowers it, short raises it, capped at the limit", () => {
  const f = (notional) => fairValue({ ref: ref(100_000), book: book(), position: { size: notional / 1e5, notional }, cfg }).fair;
  assert.ok(f(40) < 100_000, "long: sell sooner, buy later");
  assert.ok(f(-40) > 100_000, "short: buy sooner, sell later");
  assert.ok(Math.abs((1 - f(80) / 100_000) * 1e4 - 2) < 1e-6, "full cap = skewBps");
  assert.equal(f(160), f(80), "beyond the cap the shift does not keep growing");
});

test("no usable reference, or one far from Polymarket, gives no fair value", () => {
  assert.equal(fairValue({ ref: { ok: false, reason: "stale" }, book: book(), position: flat, cfg }).ok, false);
  assert.equal(fairValue({ ref: null, book: book(), position: flat, cfg }).ok, false);
  assert.equal(fairValue({ ref: { ok: true, refFair: NaN }, book: book(), position: flat, cfg }).ok, false);
  const far = fairValue({ ref: ref(100_000 * 1.002), book: book(), position: flat, cfg }); // 20 bps away
  assert.equal(far.ok, false);
  assert.match(far.reason, /bps from Polymarket mid/);
});
