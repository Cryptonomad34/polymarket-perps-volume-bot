import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { qtyForNotional, roundPrice, roundQty, sigFigs, stepAt, toDecimalString } from "../src/precision.mjs";
import { makeCoid } from "../src/coid.mjs";
import { createStateStore, freshState } from "../src/state.mjs";
import { loadCredentials, resolveCredentialsFile } from "../src/env.mjs";
import { redact } from "../src/log.mjs";
import { computeSummary } from "../src/report.mjs";
import { emptyDaily } from "../src/state.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test("precision: 5 significant figures and decimals", () => {
  assert.equal(stepAt(85_612, 1), 1); // BTC: whole dollars
  assert.equal(stepAt(2741.3, 2), 0.1); // ETH: 0.1 despite 2 decimals
  assert.equal(roundPrice(85_612.7, 1, "buy"), 85_612);
  assert.equal(roundPrice(85_612.2, 1, "sell"), 85_613);
  assert.equal(roundPrice(2741.37, 2, "buy"), 2741.3);
  assert.equal(roundQty(0.000291234, 5), 0.00029);
  const q = qtyForNotional(25, 85_612, 5, 10);
  assert.ok(q * 85_612 >= 10 && sigFigs(toDecimalString(q)) <= 5);
  assert.ok(qtyForNotional(9, 85_612, 5, 10) * 85_612 >= 10, "bumped up to min notional");
  assert.equal(toDecimalString(0.1 + 0.2), "0.3");
});

test("coid: deterministic, 32 hex chars, unique per nonce/intent", () => {
  const a = makeCoid({ sessionId: "s", iid: 6, intent: "quote-bid", nonce: 1 });
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, makeCoid({ sessionId: "s", iid: 6, intent: "quote-bid", nonce: 1 }));
  assert.notEqual(a, makeCoid({ sessionId: "s", iid: 6, intent: "quote-bid", nonce: 2 }));
  assert.notEqual(a, makeCoid({ sessionId: "s", iid: 6, intent: "quote-ask", nonce: 1 }));
  assert.throws(() => makeCoid({ sessionId: "s", iid: 6, intent: "withdraw", nonce: 1 }));
});

test("state: atomic save/load, nonce jumps forward, refuses secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-state-"));
  const store = createStateStore({ dir, mode: "dry", log: quiet });
  const s = store.load();
  s.coidNonce = 42;
  s.daily.makerFees = 1.5;
  store.save(s);
  const back = store.load();
  assert.equal(back.daily.makerFees, 1.5);
  assert.ok(back.coidNonce > 42, "restart must never reuse a coid nonce");
  assert.throws(() => store.save({ ...freshState("dry"), positions: { 6: { privateKey: "x" } } }), /secret/);
  assert.throws(() => store.save({ ...freshState("dry"), extra: { sig: "0x" } }), /secret/);
  fs.writeFileSync(store.file, "{not json");
  assert.equal(store.load().coidNonce, 0, "corrupt file moved aside, fresh state");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("state: a new UTC day resets daily counters and stop", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-state-"));
  const store = createStateStore({ dir, mode: "dry", log: quiet });
  const s = store.load(Date.parse("2026-09-21T23:00:00Z"));
  s.daily.makerFees = 3;
  s.stop = { reason: "daily loss stop" };
  store.save(s);
  const next = store.load(Date.parse("2026-09-22T00:00:01Z"));
  assert.equal(next.daily.day, "2026-09-22");
  assert.equal(next.daily.makerFees, 0);
  assert.equal(next.stop, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("credentials: key/address check, expiry check, secrets never serialised", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-env-"));
  const key = generatePrivateKey();
  const proxy = privateKeyToAccount(key).address;
  const file = path.join(dir, "p.env");
  const write = (over = {}) =>
    fs.writeFileSync(
      file,
      Object.entries({
        POLYMARKET_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
        PERPS_PROXY_ADDRESS: proxy,
        PERPS_PROXY_PRIVATE_KEY: key,
        PERPS_PROXY_SECRET: "s3cr3t-value",
        PERPS_PROXY_EXPIRES_AT: String(Date.now() + 7 * 86_400_000),
        ...over,
      })
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
  write();
  const c = loadCredentials(file);
  for (const s of [JSON.stringify(c), inspect(c), String(c), JSON.stringify(redact({ c }))]) {
    assert.ok(!s.includes(key.slice(2)) && !s.includes("s3cr3t-value"), `secret leaked: ${s}`);
  }
  assert.equal(c.privateKey(), key);
  write({ PERPS_PROXY_EXPIRES_AT: String(Date.now() + 3_600_000) });
  assert.throws(() => loadCredentials(file), /need at least 24 h/);
  write({ PERPS_PROXY_ADDRESS: privateKeyToAccount(generatePrivateKey()).address });
  assert.throws(() => loadCredentials(file), /does not belong/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("credentials: auto-discovery picks the newest unexpired proxy file", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vb-creds-"));
  const now = 1_700_000_000_000;
  assert.equal(resolveCredentialsFile({ baseDir: base, now }), null); // no credentials/ folder yet
  const dir = path.join(base, "credentials");
  fs.mkdirSync(dir);
  const put = (addr, exp) => fs.writeFileSync(path.join(dir, `proxy-0x${addr.repeat(40)}.env`), `PERPS_PROXY_EXPIRES_AT=${exp}
`);
  put("a", now - 1); // expired
  put("b", now + 5 * 86_400_000);
  put("c", now + 9 * 86_400_000); // newest
  fs.writeFileSync(path.join(dir, `proxy-0x${"d".repeat(40)}.REVOKED.env`), `PERPS_PROXY_EXPIRES_AT=${now + 99 * 86_400_000}
`);
  assert.equal(resolveCredentialsFile({ baseDir: base, now }), path.join(dir, `proxy-0x${"c".repeat(40)}.env`));
  assert.equal(resolveCredentialsFile({ baseDir: base, now: now + 10 * 86_400_000 }), null); // all expired
  assert.equal(resolveCredentialsFile({ baseDir: base, cfgEnvFile: "x.env", now }), path.resolve(base, "x.env"));
  assert.equal(resolveCredentialsFile({ baseDir: base, envVar: "/abs/y.env", cfgEnvFile: "x.env", now }), "/abs/y.env");
});

test("log redaction hides secret-looking keys", () => {
  const r = redact({ secret: "a", privateKey: "b", sig: "c", nested: { proxy_secret: "d", price: 1 } });
  assert.deepEqual(r, { secret: "[redacted]", privateKey: "[redacted]", sig: "[redacted]", nested: { proxy_secret: "[redacted]", price: 1 } });
});

test("summary: cost components separate; net cost = fees + funding - trading P&L", () => {
  const d = { ...emptyDaily("2026-09-22"), grossVolume: 10_000, makerVolume: 9_000, takerVolume: 1_000, makerFees: 1.125, takerFees: 0.4, funding: 0.05, slippage: -0.2, realized: -0.3, unrealized: 0.1, firstActivityAt: 0 };
  const s = computeSummary(d, { now: 86_400_000, mode: "dry", marginUsed: 5, minLiqDistancePct: 9, budgetLimit: 10 });
  assert.equal(s.maker_fees, 1.125);
  assert.equal(s.taker_fees, 0.4);
  assert.equal(s.funding, 0.05);
  assert.equal(s.slippage, -0.2);
  const net = 1.125 + 0.4 + 0.05 - (-0.3 + 0.1);
  assert.ok(Math.abs(s.net_cost - net) < 1e-12);
  assert.ok(Math.abs(s["cost_per_$1"] - net / 10_000) < 1e-15);
  assert.ok(Math.abs(s["projected_days_to_$1M_tier"] - 100) < 1e-9, "10k/day -> 100 days");
  assert.ok(Math.abs(s.inventory_drift - (-0.2 + -0.2)) < 1e-12);
});
