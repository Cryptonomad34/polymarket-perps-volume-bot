// End-to-end check of strategy.mode "fair" through the real engine and the
// real dry-run executor, with a fake market-data feed and a reference whose
// fair value the test controls.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../src/engine.mjs";
import { createSimExec } from "../src/exec/sim.mjs";
import { rollIfHeaderChanged } from "../src/report.mjs";
import { freshState } from "../src/state.mjs";
import { BTC, testConfig } from "./fixtures.mjs";

const log = { debug() {}, info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await wait(20);
  }
}

function harness() {
  const cfg = testConfig({
    strategy: { mode: "fair" },
    reference: { mode: "gate", basisHalfLifeSec: 300, warmupSec: 10, staleMs: 2000, gateBps: 0.6 },
    fair: { edgeBps: 1, levels: 2, levelStepBps: 1, cancelEdgeBps: 0.3, maxDistanceBps: 6, imbalanceWeight: 0, skewBps: 1.5, maxDeviationBps: 15 },
    sim: { latencyMs: 0 },
  });
  const insts = new Map([[BTC.iid, BTC]]);
  const md = new EventEmitter();
  const bk = { bid: 85_000, ask: 85_001, bidQty: 1, askQty: 1, bids: [[85_000, 1]], asks: [[85_001, 1]], updatedAt: Date.now(), exchTs: 0 };
  md.books = new Map([[BTC.iid, bk]]);
  md.staleness = () => 0;

  const refState = { fair: 85_000.5 };
  const reference = Object.assign(new EventEmitter(), {
    enabled: true,
    start() {},
    stop() {},
    observe() {},
    view: () => ({ ok: true, acting: true, refFair: refState.fair, edgeBps: 0 }),
    health: () => ({ enabled: false }),
  });

  const state = freshState("dry");
  const fills = [];
  const reporter = { fill: (r) => fills.push(r), quote() {}, summary() {}, reference() {} };
  const exec = createSimExec({ insts, books: md.books, cfg, log, getPosition: (iid) => state.positions[iid] ?? { size: 0 } });
  const engine = createEngine({ cfg, mode: "dry", insts, api: { tickers: async () => [] }, md, exec, store: { save() {} }, state, reporter, log, reference });
  const ladder = () => {
    const s = engine._internals.per.get(BTC.iid);
    const orders = engine._internals.orders;
    const live = (side) => s.ladder[side].map((c) => orders.get(c)).filter((o) => o && o.status !== "done");
    return { buy: live("buy"), sell: live("sell") };
  };
  return { cfg, engine, exec, md, reference, refState, state, fills, ladder, bk };
}

test("fair mode: rests a ladder, keeps it when the book moves, pulls on a fair-value tick, logs the fill", async () => {
  const h = harness();
  h.md.emit("restored");
  await h.engine.start();
  try {
    // 1. Two resting orders per side, priced from fair value.
    await until(() => h.ladder().buy.length === 2 && h.ladder().sell.length === 2 && h.ladder().buy.every((o) => o.status === "live"));
    const before = h.ladder().buy.map((o) => o.coid).sort();
    assert.deepEqual(h.ladder().buy.map((o) => o.price).sort(), [84_983, 84_991]);
    assert.equal(h.engine._internals.per.get(BTC.iid).quotes.buy, null, "join-mode slots stay unused");

    // 2. The book moves, fair value does not: nothing is replaced (queue kept).
    Object.assign(h.bk, { bid: 84_996, ask: 84_997, bids: [[84_996, 1]], asks: [[84_997, 1]], updatedAt: Date.now() });
    await wait(500);
    assert.deepEqual(h.ladder().buy.map((o) => o.coid).sort(), before, "resting bids must not be re-placed");

    // 3. Fair value drops next to the level-0 bid; the tick pulls it at once.
    h.refState.fair = 84_993;
    const l0 = h.ladder().buy.find((o) => o.price === 84_991).coid;
    h.reference.emit("tick", BTC.iid);
    assert.equal(h.engine._internals.orders.get(l0).status, "cancelling", "pulled on the tick, not on the next loop");
    await until(() => h.engine._internals.orders.get(l0).status === "done");

    // 4. A sell trades through the deep bid: a maker fill with ladder fields.
    await until(() => h.ladder().buy.length === 2);
    const deep = h.ladder().buy.find((o) => o.price === 84_983);
    h.md.emit("trade", { iid: BTC.iid, takerBuy: false, price: 84_980, qty: 1 });
    await until(() => h.fills.length > 0);
    const f = h.fills[0];
    assert.equal(f.coid, deep.coid);
    assert.equal(f.liquidity, "maker");
    assert.equal(f.level, 1);
    assert.equal(f.fair_at_place, 85_000.5);
    assert.ok(f.edge_vs_fair_bps > 2, `bought ~2 bps under the fair value it was priced from, got ${f.edge_vs_fair_bps}`);
    assert.ok(f.order_age_ms >= 500, "it had rested in the queue");
    assert.ok(h.state.positions[BTC.iid].size > 0);
  } finally {
    // The simulator's clock is unref'd (the real bot's sockets keep the
    // process alive); hold the loop open until its cancels have landed.
    const keepAlive = setInterval(() => {}, 50);
    await h.engine.shutdown("test");
    clearInterval(keepAlive);
    h.exec.stop();
  }
  assert.equal(h.ladder().buy.length + h.ladder().sell.length, 0, "shutdown cancels the whole ladder");
});

test("report: a CSV with an older header is moved aside instead of being appended to", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-report-"));
  const file = path.join(dir, "fills.csv");
  fs.writeFileSync(file, "ts,mode,price\n2026-01-01,dry,1\n");
  const moved = rollIfHeaderChanged(file, ["ts", "mode", "price", "level"]);
  assert.ok(moved && fs.existsSync(moved), "old file kept under a new name");
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, "ts,mode,price,level\n");
  assert.equal(rollIfHeaderChanged(file, ["ts", "mode", "price", "level"]), null, "same header: left alone");
  fs.rmSync(dir, { recursive: true });
});
