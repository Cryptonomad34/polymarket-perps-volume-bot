// Verifies that src/signing.mjs produces byte-identical signatures and request
// bodies to the official @polymarket/client@0.10.0 SDK.
//
// The SDK is installed into a temp folder only for this test; it is never a
// runtime dependency. Its internal `mi` (sign), `Xo` (order -> array) and
// `Fr` (array -> JSON op) functions are not exported, so we load a copy of
// the bundle with one extra export line appended.
//
// Run: node test/signing-match.mjs

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { commands, createSigner } from "../src/signing.mjs";

const SDK = "@polymarket/client@0.10.0";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-sdk-"));
console.log(`Installing ${SDK} into ${dir} ...`);
execSync(`npm install --no-fund --no-audit --ignore-scripts ${SDK}`, { cwd: dir, stdio: "ignore" });

const dist = path.join(dir, "node_modules", "@polymarket", "client", "dist");
const chunk = fs.readdirSync(dist).find((f) => f.endsWith(".js") && fs.readFileSync(path.join(dist, f), "utf8").includes('primaryType:"Op"'));
assert.ok(chunk, "could not find the SDK chunk containing Op signing");
const harness = path.join(dist, "__signing_harness.js");
fs.writeFileSync(harness, fs.readFileSync(path.join(dist, chunk), "utf8") + "\nexport { mi as __mi, Xo as __Xo, Fr as __Fr };\n");
const { __mi: sdkSign, __Xo: sdkOrderArray, __Fr: sdkOpJson } = await import(pathToFileURL(harness).href);

const privateKey = generatePrivateKey();
const signer = createSigner(() => privateKey);
assert.equal(signer.address, privateKeyToAccount(privateKey).address);

const coid = "0123456789abcdef0123456789abcdef";
const sdkOrders = [
  { instrumentId: 6, side: "BUY", price: "85590", quantity: "0.00029", timeInForce: "gtc", postOnly: true, clientOrderId: coid },
  { instrumentId: 7, side: "SELL", price: "2737.4", quantity: "0.0091", timeInForce: "ioc", postOnly: false, reduceOnly: true, clientOrderId: coid.replace(/0/g, "f") },
];
const ours = [
  { iid: 6, buy: true, price: "85590", qty: "0.00029", tif: "gtc", postOnly: true, coid },
  { iid: 7, buy: false, price: "2737.4", qty: "0.0091", tif: "ioc", postOnly: false, reduceOnly: true, coid: coid.replace(/0/g, "f") },
];

const cases = [
  ["createOrders", commands.createOrders(ours), ["createOrders", sdkOrders.map(sdkOrderArray)]],
  ["cancelOrders", commands.cancelOrders([111, 222]), ["cancelOrders", [111, 222]]],
  ["cancelOrdersCOID", commands.cancelOrdersCOID([coid]), ["cancelOrdersCOID", [coid]]],
  ["cancelAll(iid)", commands.cancelAll(6), ["cancelAll", [6]]],
  ["cancelAll()", commands.cancelAll(), ["cancelAll", []]],
  ["autoCancel", commands.autoCancel(1790000015000), ["autoCancel", [1790000015000]]],
  ["autoCancel(0)", commands.autoCancel(0), ["autoCancel", [0]]],
  ["updateLeverage", commands.updateLeverage(6, 10, false), ["updateLeverage", [6, 10, false]]],
];

let passed = 0;
for (const [name, cmd, sdkArray] of cases) {
  const ts = 1790000000000 + passed;
  const salt = 123456789 + passed;
  assert.deepEqual(cmd.array, sdkArray, `${name}: op array differs from SDK`);
  assert.deepEqual(cmd.json, sdkOpJson(sdkArray), `${name}: JSON op differs from SDK`);
  const body = await signer.sign(cmd, { ts, salt });
  const sdkSig = sdkSign({ chainId: 137, op: sdkArray, privateKey, salt, timestamp: ts });
  assert.equal(body.sig.toLowerCase(), sdkSig.toLowerCase(), `${name}: signature differs from SDK`);
  console.log(`  ok  ${name}`);
  passed++;
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nAll ${passed} commands match @polymarket/client@0.10.0 (array, JSON and signature).`);
