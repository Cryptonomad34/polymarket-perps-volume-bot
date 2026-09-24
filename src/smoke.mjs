// Live smoke test (node bot.mjs --live --smoke). Places nothing that can fill:
//   1. one ~$10 post-only buy 3% below mid on the first market -> confirm it
//      is in open orders -> cancel it -> confirm it is gone
//   2. place a second one, arm auto-cancel 15 s ahead and DON'T re-arm (as if
//      the bot had died) -> confirm the exchange cancels it and the daily
//      `triggered` counter went up by exactly one
// Results are printed and written to logs/smoke-<time>.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCoid } from "./coid.mjs";
import { itemError } from "./api.mjs";
import { mid } from "./marketdata.mjs";
import { qtyForNotional, roundPrice, toDecimalString } from "./precision.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "logs");

export async function runSmokeTest({ api, insts, md, log, cfg }) {
  const inst = [...insts.values()][0];
  const session = `smoke-${Date.now()}`;
  let nonce = 0;
  const results = { instrument: inst.symbol, steps: [] };
  const step = (name, ok, detail = {}) => {
    results.steps.push({ name, ok, ...detail });
    log[ok ? "info" : "error"](`smoke: ${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) throw new Error(`smoke test failed at: ${name}`);
  };

  const order = () => {
    const m = mid(md.books.get(inst.iid));
    const price = roundPrice(m * 0.97, inst.priceDecimals, "buy");
    const qty = qtyForNotional(Math.max(10.5, inst.minNotional * 1.05), price, inst.quantityDecimals, inst.minNotional);
    return { iid: inst.iid, buy: true, price: toDecimalString(price), qty: toDecimalString(qty), tif: "gtc", postOnly: true, coid: makeCoid({ sessionId: session, iid: inst.iid, intent: "smoke", nonce: ++nonce }), mid: m };
  };
  const isOpen = async (coid) => (await api.openOrders(inst.iid)).some((o) => o.client_order_id === coid);

  // 1. place, confirm, cancel, confirm
  const a = order();
  const placed = await api.createOrders([a]);
  const errA = itemError(placed.data?.[0]);
  step("place post-only order 3% below mid", !errA, { price: a.price, qty: a.qty, mid: a.mid, notional: Number(a.price) * Number(a.qty), error: errA?.code });
  await sleep(1500);
  step("order visible in open orders", await isOpen(a.coid), { coid: a.coid });
  const cancelled = await api.cancelOrdersCOID([a.coid]);
  step("cancel accepted", !itemError(cancelled.data?.[0]), { response: cancelled.data?.[0]?.status });
  await sleep(1500);
  step("order gone from open orders", !(await isOpen(a.coid)));

  // 2. dead-man's switch
  const before = await api.autoCancelStatus();
  const b = order();
  const placedB = await api.createOrders([b]);
  step("place second order", !itemError(placedB.data?.[0]), { price: b.price, qty: b.qty });
  const ahead = cfg.autoCancel.aheadSec * 1000;
  await api.autoCancel(api.now() + ahead);
  log.info(`smoke: auto-cancel armed ${cfg.autoCancel.aheadSec}s ahead and NOT re-armed; waiting for it to fire`, { triggeredBefore: before.triggered, dailyLimit: before.daily_limit });
  const t0 = Date.now();
  let goneAfterMs = null;
  while (Date.now() - t0 < ahead + 15_000) {
    await sleep(1000);
    if (!(await isOpen(b.coid))) {
      goneAfterMs = Date.now() - t0;
      break;
    }
  }
  step("auto-cancel removed the order", goneAfterMs !== null && goneAfterMs <= ahead + 5_000, { goneAfterMs, expectedWithinMs: ahead + 5_000 });
  const after = await api.autoCancelStatus();
  step("auto-cancel fired exactly once", Number(after.triggered) === Number(before.triggered) + 1, {
    triggeredBefore: before.triggered,
    triggeredAfter: after.triggered,
    dailyLimit: after.daily_limit,
  });

  const file = path.join(LOG_DIR, `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  log.info(`smoke: all steps passed; results in ${file}`);
}
