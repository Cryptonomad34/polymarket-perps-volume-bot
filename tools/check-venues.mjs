#!/usr/bin/env node
// Are the reference venues reachable from this machine?
//
// Connects to each venue src/reference.mjs supports (public market data only:
// no account, no key) for a short while and counts the BTC/ETH price updates
// that arrive, using the bot's own connectors and parsers. Run it on the VPS
// before switching strategy.mode to "fair": a venue showing 0 updates is
// blocked or down from there and should be left out of reference.venues.
//
// Usage: node tools/check-venues.mjs [--seconds 15] [--venues binance,bybit,okx]

import { VENUES, createReference } from "../src/reference.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SECONDS = Number(opt("seconds", "15"));
const venues = opt("venues", Object.keys(VENUES).join(",")).split(",");
const markets = [
  { iid: 6, symbol: "BTC-USD" },
  { iid: 7, symbol: "ETH-USD" },
];
const quiet = { debug() {}, info() {}, warn: (m, d) => console.log(`  ! ${d?.venue ?? ""} ${m}: ${d?.error ?? d?.code ?? ""}`), error() {} };

// One reference per venue, so each venue's updates are counted apart.
const refs = venues.map((name) => {
  const cfg = { reference: { mode: "observe", basisHalfLifeSec: 60, warmupSec: 10, staleMs: 5000, gateBps: 1, venues: [name] } };
  const ref = createReference({ cfg, markets, log: quiet });
  const perSymbol = Object.fromEntries(markets.map((m) => [m.symbol, 0]));
  ref.on("tick", (iid) => perSymbol[markets.find((m) => m.iid === iid).symbol]++);
  return { name, ref, perSymbol };
});

console.log(`connecting to ${venues.join(", ")} for ${SECONDS}s ...`);
for (const { ref } of refs) ref.start();

setTimeout(() => {
  console.log(`\nprice updates in ${SECONDS}s:`);
  let ok = 0;
  for (const { name, ref, perSymbol } of refs) {
    const total = Object.values(perSymbol).reduce((a, b) => a + b, 0);
    if (total > 0) ok++;
    const detail = Object.entries(perSymbol).map(([s, n]) => `${s} ${n}`).join("  ");
    console.log(`  ${name.padEnd(8)} ${ref.isConnected() ? "connected    " : "NOT CONNECTED"}  ${detail}${total === 0 ? "   <- leave out of reference.venues" : ""}`);
    ref.stop();
  }
  console.log(ok === venues.length ? "\nall venues OK" : `\n${ok}/${venues.length} venues delivering prices`);
  process.exit(ok ? 0 : 1);
}, SECONDS * 1000);
