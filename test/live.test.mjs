// Live executor and market-data reconnect logic against mocks (no network).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ApiError } from "../src/api.mjs";
import { createLiveExec } from "../src/exec/live.mjs";
import { createMarketData } from "../src/marketdata.mjs";
import { BTC } from "./fixtures.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const insts = new Map([[6, BTC]]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeApi(over = {}) {
  const calls = [];
  const api = {
    calls,
    open: [],
    fillsRows: [],
    fundingRows: [],
    createOrders: async (orders) => (calls.push(["create", orders]), { data: [{ status: "ok", oid: 111, coid: orders[0].coid }] }),
    cancelOrdersCOID: async (c) => (calls.push(["cancel", c]), { data: [{ status: "ok" }] }),
    cancelAll: async (iid) => (calls.push(["cancelAll", iid]), { data: { status: "ok" } }),
    openOrders: async () => api.open,
    portfolio: async () => ({ positions: [{ instrument_id: 6, size: "0.0003", entry_price: "85000", liquidation_price: "77000" }], margin: { total_initial_margin: "2.5", total_account_value: "200" }, fee_tier: 0 }),
    fills: async () => api.fillsRows,
    funding: async () => api.fundingRows,
    ...over,
  };
  return api;
}

const order = (over = {}) => ({ coid: "a".repeat(32), iid: 6, side: "buy", price: 85_000, qty: 0.0003, tif: "gtc", postOnly: true, reduceOnly: false, ...over });

test("place: sends string price/qty with coid and tracks the oid", async () => {
  const api = fakeApi();
  const ex = createLiveExec({ api, insts, log: quiet, marketdata: new EventEmitter() });
  const r = await ex.place(order());
  assert.equal(r.status, "ok");
  assert.equal(r.oid, 111);
  const sent = api.calls[0][1][0];
  assert.deepEqual(sent, { iid: 6, buy: true, price: "85000", qty: "0.0003", tif: "gtc", postOnly: true, reduceOnly: false, coid: "a".repeat(32) });
});

test("place: per-order rejection is reported and classified", async () => {
  const api = fakeApi({ createOrders: async () => ({ data: [{ status: "err", error: "post only order would cross" }] }) });
  const ex = createLiveExec({ api, insts, log: quiet, marketdata: new EventEmitter() });
  const done = [];
  ex.on("orderDone", (d) => done.push(d));
  const r = await ex.place(order());
  assert.equal(r.status, "rejected");
  assert.equal(r.error.kind, "PostOnlyReject");
  assert.equal(done.length, 1);
});

test("place: indeterminate result is resolved by looking the coid up", async () => {
  const err = new ApiError("Indeterminate", "503");
  err.indeterminate = true;
  const api = fakeApi({ createOrders: async () => Promise.reject(err) });
  api.open = [{ client_order_id: "a".repeat(32), order_id: 999 }];
  const ex = createLiveExec({ api, insts, log: quiet, marketdata: new EventEmitter() });
  const r = await ex.place(order());
  assert.deepEqual([r.status, r.oid, r.recovered], ["ok", 999, true]);

  api.open = [];
  const r2 = await ex.place(order({ coid: "b".repeat(32) }));
  assert.equal(r2.status, "unknown", "not found -> unknown, never assumed placed or not placed");
});

test("fills: a WS fill and the same fill from REST count once", async () => {
  const md = new EventEmitter();
  const api = fakeApi();
  const ex = createLiveExec({ api, insts, log: quiet, marketdata: md });
  const fills = [];
  ex.on("fill", (f) => fills.push(f));
  await ex.place(order());
  const ts = Date.now();
  md.emit("fill", { tradeId: 5, oid: 111, iid: 6, buy: true, price: 85_000, qty: 0.0003, fee: 0.0032, coid: "a".repeat(32), ts, source: "ws" });
  // Same fill, different id format from REST.
  api.fillsRows = [{ trade_id: "5-rest", order_id: 111, instrument_id: 6, side: "long", price: "85000", quantity: "0.0003", fee: "0.0032", taker: false, timestamp: ts }];
  await ex.reconcile({ iids: [6], sinceTs: 0 });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].taker, false, "post-only fill is maker");
});

test("reconcile: a just-placed order is not closed inside the grace period; positions and margin read", async () => {
  const api = fakeApi();
  const ex = createLiveExec({ api, insts, log: quiet, marketdata: new EventEmitter() });
  const done = [];
  ex.on("orderDone", (d) => done.push(d.coid));
  await ex.place(order());
  await ex.reconcile({ iids: [6], sinceTs: 0 });
  assert.equal(done.length, 0, "just placed: not listed yet is fine");
  const snap = await ex.reconcile({ iids: [6], sinceTs: 0 });
  assert.equal(snap.positions[6].size, 0.0003);
  assert.equal(snap.marginUsed, 2.5);
});

test("reconcile: foreign orders on a bot instrument are reported", async () => {
  const api = fakeApi();
  api.open = [{ client_order_id: "f".repeat(32), order_id: 7, instrument_id: 6 }];
  const ex = createLiveExec({ api, insts, log: quiet, marketdata: new EventEmitter() });
  const snap = await ex.reconcile({ iids: [6], sinceTs: 0 });
  assert.equal(snap.foreign.length, 1);
});

test("cancel: already-terminal answers count as done, not errors", async () => {
  const api = fakeApi({ cancelOrdersCOID: async () => ({ data: [{ status: "err", error: "order_already_terminal" }] }) });
  const ex = createLiveExec({ api, insts, log: quiet, marketdata: new EventEmitter() });
  await ex.place(order());
  const r = await ex.cancel("a".repeat(32));
  assert.equal(r.status, "ok");
});

test("funding: longs pay a positive rate, shorts receive it", async () => {
  const api = fakeApi();
  api.fundingRows = [
    { id: 1, instrument_id: 6, size: "0.001", funding_rate: "0.0001", funding: "-0.0085", timestamp: 1 },
    { id: 2, instrument_id: 6, size: "-0.001", funding_rate: "0.0001", funding: "0.0085", timestamp: 2 },
  ];
  const ex = createLiveExec({ api, insts, log: quiet, marketdata: new EventEmitter() });
  const got = [];
  ex.on("funding", (f) => got.push(f.cost));
  const seen = new Set();
  await ex.pollFunding({ start: 0, seen });
  await ex.pollFunding({ start: 0, seen });
  assert.deepEqual(got, [0.0085, -0.0085], "sign from position x rate; each payment counted once");
});

// ---- market data reconnect ----

class FakeWS extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    FakeWS.instances.push(this);
    setTimeout(() => this.emit("open"), 5);
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.emit("close", 1000);
  }
  terminate() {
    this.emit("close", 1006);
  }
}

test("marketdata: disconnect is reported, reconnect resyncs and restores", async () => {
  FakeWS.instances = [];
  const api = { book: async () => ({ bids: [["85000", "1"]], asks: [["85001", "1"]], timestamp: 1 }) };
  const md = createMarketData({ api, iids: [6], log: quiet, WebSocketImpl: FakeWS, url: "ws://fake" });
  const events = [];
  md.on("restored", () => events.push("restored"));
  md.on("disconnected", () => events.push("disconnected"));
  md.start();
  await sleep(50);
  assert.deepEqual(events, ["restored"]);
  assert.equal(md.books.get(6).bid, 85_000);
  assert.deepEqual(FakeWS.instances[0].sent[0], { req: "sub", chs: ["bbo::6", "book::6", "trades::6"] });

  FakeWS.instances[0].terminate();
  assert.deepEqual(events, ["restored", "disconnected"]);
  await sleep(1_100); // first reconnect after 1s
  assert.deepEqual(events, ["restored", "disconnected", "restored"]);
  assert.equal(FakeWS.instances.length, 2);

  FakeWS.instances[1].emit("message", JSON.stringify({ ch: "bbo::6", ts: 2, data: { iid: 6, bp: "85002", bq: "1", ap: "85003", aq: "1" } }));
  assert.equal(md.books.get(6).bid, 85_002);
  md.stop();
});

test("marketdata: private channels only with credentials; auth sent first", async () => {
  FakeWS.instances = [];
  const api = { book: async () => ({ bids: [], asks: [], timestamp: 1 }) };
  const creds = { authArgs: () => ({ proxy: "0xP", secret: "S" }) };
  const md = createMarketData({ api, iids: [6], log: quiet, WebSocketImpl: FakeWS, url: "ws://fake", creds });
  md.start();
  await sleep(30);
  const [auth, sub] = FakeWS.instances[0].sent;
  assert.equal(auth.op.type, "auth");
  assert.ok(sub.chs.includes("fills") && sub.chs.includes("orders"));
  md.stop();
});

test("reconcile: the snapshot carries when the portfolio request left", async () => {
  const api = fakeApi();
  const ex = createLiveExec({ api, insts, log: quiet, marketdata: new EventEmitter() });
  const before = Date.now();
  const snap = await ex.reconcile({ iids: [6], sinceTs: before - 60_000 });
  assert.ok(snap.requestedAt >= before, "stamped when the request was issued");
  assert.ok(snap.requestedAt <= Date.now());
});
