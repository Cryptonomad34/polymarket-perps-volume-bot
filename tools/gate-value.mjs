#!/usr/bin/env node
// Is the reference gate worth turning on?
//
// Joins real maker fills (logs/fills.csv) to what the reference signal said at
// that moment (logs/reference.csv, written whenever config.reference.mode is
// not "off") and answers one question: do the fills the signal warned about
// actually markout worse than the ones it did not?
//
// This is the test that price data alone cannot answer. Simulating the gate on
// prices assumes fills arrive uniformly in time. They do not - an arbitrageur
// takes our quote precisely when it has gone stale, so fills cluster exactly
// where the edge is large. Only real fills show how strong that clustering is,
// and therefore how much the gate is really worth.
//
// "Warnedness" is the edge signed against the side we were filled on:
//   a sell fill is warned when edge > 0 (Polymarket about to rise)
//   a buy  fill is warned when edge < 0 (about to fall)
// Positive warnedness means the signal called this fill dangerous.
//
// Usage: node tools/gate-value.mjs [--since ISO] [--until ISO] [--horizon 5]

import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SINCE = opt("since", null) ? Date.parse(opt("since", null)) : -Infinity;
const UNTIL = opt("until", null) ? Date.parse(opt("until", null)) : Infinity;
const HORIZON = Number(opt("horizon", "5"));
// Dry-run fills are modelled, not real. Mixing them with live fills would make
// the markout meaningless, so this looks at one mode at a time.
const MODE = opt("mode", "live");
const MAX_JOIN_MS = 2000; // a signal older than this is not what the fill saw
// price_decimals from /v1/info/instruments. Only used to size the back-off
// correction; the 5-significant-figure rule dominates at these price levels.
const PRICE_DECIMALS = { "BTC-USD": 1, "ETH-USD": 2, "BNB-USD": 2, "LINK-USD": 3, "SOL-USD": 3, "GOLD-USD": 1, "SILVER-USD": 3, "WTIOIL-USD": 3, "SPCX-USD": 2 };
const BACKOFF_TICKS = 1;

function readCsv(path) {
  if (!fs.existsSync(path)) return [];
  const lines = fs.readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split(",");
  return lines
    .slice(1)
    .map((l) => l.split(","))
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const num = (x) => (x === "" || x == null ? null : Number(x));
function tickAt(price, decimals) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(price))) - 4);
  return Math.max(mag, Math.pow(10, -decimals));
}

// ---- rebuild the Polymarket mid from our own placements (same as markout.mjs)
const quotes = readCsv("logs/quotes.csv");
const book = new Map();
for (const q of quotes) {
  if (q.action !== "place") continue;
  if (q.intent !== "quote-bid" && q.intent !== "quote-ask") continue;
  const price = num(q.price);
  if (!(price > 0)) continue;
  const d = PRICE_DECIMALS[q.symbol];
  if (d === undefined) continue;
  let best = price;
  if (q.reason?.startsWith("back off")) {
    const back = BACKOFF_TICKS * tickAt(price, d);
    best = q.side === "buy" ? price + back : price - back;
  }
  if (!book.has(q.symbol)) book.set(q.symbol, { bid: [], ask: [] });
  (q.side === "buy" ? book.get(q.symbol).bid : book.get(q.symbol).ask).push([Date.parse(q.ts), best]);
}
for (const s of book.values()) {
  s.bid.sort((a, b) => a[0] - b[0]);
  s.ask.sort((a, b) => a[0] - b[0]);
}
function sampleAt(series, t) {
  let lo = 0;
  let hi = series.length - 1;
  let found = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (series[m][0] >= t) {
      found = series[m];
      hi = m - 1;
    } else lo = m + 1;
  }
  return found && found[0] - t <= 60_000 ? found[1] : null;
}
function midAt(symbol, t) {
  const s = book.get(symbol);
  if (!s) return null;
  const b = sampleAt(s.bid, t);
  const a = sampleAt(s.ask, t);
  return b != null && a != null ? (b + a) / 2 : null;
}

// ---- the recorded signal, per symbol, in time order ----
const refRows = readCsv("logs/reference.csv");
if (!refRows.length) {
  console.log("logs/reference.csv is empty or missing.");
  console.log("Set config.reference.mode to \"observe\" and let the bot trade for a while first.");
  process.exit(0);
}
const refBySymbol = new Map();
for (const r of refRows) {
  const e = num(r.edgeBps);
  if (e == null || !Number.isFinite(e)) continue;
  if (!refBySymbol.has(r.symbol)) refBySymbol.set(r.symbol, []);
  refBySymbol.get(r.symbol).push([Date.parse(r.ts), e]);
}
for (const a of refBySymbol.values()) a.sort((x, y) => x[0] - y[0]);

// Last signal at or before t - what the bot could actually have known.
function edgeAt(symbol, t) {
  const a = refBySymbol.get(symbol);
  if (!a) return null;
  let lo = 0;
  let hi = a.length - 1;
  let best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a[m][0] <= t) {
      best = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  if (best < 0) return null;
  return t - a[best][0] <= MAX_JOIN_MS ? a[best][1] : null;
}

// ---- join fills to the signal ----
const fills = readCsv("logs/fills.csv");
const joined = [];
let unmatched = 0;
for (const f of fills) {
  if (f.mode !== MODE) continue;
  if (f.liquidity !== "maker" || !f.intent?.startsWith("quote")) continue;
  const t = Date.parse(f.ts);
  if (!(t >= SINCE && t <= UNTIL)) continue;
  const edge = edgeAt(f.symbol, t);
  if (edge == null) {
    unmatched++;
    continue;
  }
  const m = midAt(f.symbol, t + HORIZON * 1000);
  if (m == null) continue;
  const price = num(f.price);
  const sign = f.side === "buy" ? 1 : -1;
  joined.push({
    symbol: f.symbol,
    side: f.side,
    notional: num(f.notional) ?? 0,
    markout: (1e4 * sign * (m - price)) / price,
    // The edge signed against the side we were filled on.
    warnedness: f.side === "sell" ? edge : -edge,
    edge,
  });
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f2 = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x) => `${(100 * x).toFixed(1)}%`;

console.log(`\nGATE VALUE  (markout at +${HORIZON}s, negative = picked off)\n`);
console.log(`  mode: ${MODE}`);
console.log(`  maker quote fills joined to a signal: ${joined.length}${unmatched ? `  (${unmatched} had no signal within ${MAX_JOIN_MS}ms)` : ""}`);
if (joined.length < 50) {
  console.log(`\n  Not enough yet. A few hundred fills are needed before the split is real.`);
  console.log(`  Keep the bot running with reference.mode = "observe" and re-run this.`);
  process.exit(0);
}
const allVol = joined.reduce((a, f) => a + f.notional, 0);
console.log(`  total notional: $${Math.round(allVol)}`);
console.log(`  baseline markout, all fills: ${f2(mean(joined.map((f) => f.markout)))} bps\n`);

// --- 1. does warnedness sort the bad fills? ---
const byW = [...joined].sort((a, b) => a.warnedness - b.warnedness);
console.log(`  markout by warnedness decile  (10 = the signal shouted loudest)`);
console.log(`    decile   warnedness range (bps)    markout (bps)   fills`);
for (let d = 0; d < 10; d++) {
  const lo = Math.floor((d * byW.length) / 10);
  const hi = Math.floor(((d + 1) * byW.length) / 10);
  const sl = byW.slice(lo, hi);
  if (!sl.length) continue;
  console.log(
    `      ${String(d + 1).padStart(2)}     ${f2(sl[0].warnedness).padStart(6)} .. ${f2(sl.at(-1).warnedness).padEnd(7)}    ${f2(mean(sl.map((f) => f.markout))).padStart(7)}       ${sl.length}`,
  );
}

// --- 2. what each threshold would have done ---
console.log(`\n  what the gate would have done`);
console.log(`    gateBps   fills cut   volume cut   markout of what remains   change`);
const baseline = mean(joined.map((f) => f.markout));
for (const th of [0.4, 0.6, 0.8, 1.0, 1.25, 1.5, 2.0, 3.0]) {
  const kept = joined.filter((f) => f.warnedness < th);
  const cut = joined.filter((f) => f.warnedness >= th);
  if (cut.length < 5 || kept.length < 30) continue;
  const keptMk = mean(kept.map((f) => f.markout));
  const keptVol = kept.reduce((a, f) => a + f.notional, 0);
  console.log(
    `    ${f2(th, 2).padStart(6)}    ${pct(cut.length / joined.length).padStart(7)}    ${pct(1 - keptVol / allVol).padStart(8)}         ${f2(keptMk).padStart(7)} bps        ${(keptMk - baseline >= 0 ? "+" : "") + f2(keptMk - baseline)}`,
  );
}

// --- 3. the economics ---
// Earn per fill = half spread + rebate. Break even needs markout above -0.56 bps.
console.log(`\n  cost per $1M of the surviving volume  (rebate 0.50 + half-spread 0.06 bps)`);
console.log(`    gateBps   markout   net bps   cost per $1M   volume kept`);
for (const th of [0.4, 0.6, 0.8, 1.0, 1.25, 1.5, 2.0, 3.0, Infinity]) {
  const kept = joined.filter((f) => f.warnedness < th);
  if (kept.length < 30) continue;
  const keptMk = mean(kept.map((f) => f.markout));
  const keptVol = kept.reduce((a, f) => a + f.notional, 0);
  const net = keptMk + 0.56;
  const label = th === Infinity ? "  off" : f2(th, 2).padStart(6);
  console.log(
    `    ${label}   ${f2(keptMk).padStart(7)}   ${f2(net).padStart(7)}   ${("$" + Math.round(-net * 100)).padStart(11)}   ${pct(keptVol / allVol).padStart(8)}`,
  );
}
console.log(`\n  A positive "net bps" means the bot makes money on those fills.`);
console.log();
