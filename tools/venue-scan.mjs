#!/usr/bin/env node
// Which Polymarket instrument is actually worth making a market in?
//
// A passive maker earns the half-spread plus the rebate and pays adverse
// selection, which scales with volatility. So the whole game is:
//
//     half-spread + rebate   vs   volatility
//
// BTC-USD fails that test badly. Its spread is one tick (~0.2 bps) while its
// 5-second volatility is over 1 bps, so every resting order is an option sold
// for a fraction of its worth - which is exactly what the -2.14 bps markout
// says. But this venue lists 89 instruments, and some quote far wider relative
// to how much they move. The fee schedule has a single "equity" category
// covering everything, so the maker rebate is identical wherever we quote.
//
// The ranking column is EARN/VOL, which needs no assumption about how toxic a
// market is. Measured on BTC-USD: 5-second volatility 1.90 bps against a
// markout of 2.14 bps, so adverse selection there runs at 1.13x volatility.
// An instrument only beats BTC if it earns more than 1.13x its own volatility,
// and only makes money if that ratio is above 1.13 by enough to cover the gap.
// Whether 1.13 carries to another instrument is itself unknown - a market with
// fewer arbitrageurs should be gentler, one with more should be worse - so the
// ratio is a shortlist, never a result.
//
// Volume matters as much as edge here: a wide spread nobody trades against
// earns nothing and farms no volume either. `moves/min` is how often the mid
// changes, which is the best free proxy for activity.
//
// MARKET HOURS MATTER. Equity and index instruments (SP500, NAS100, MU,
// SKHYNIX, SPCX) only have a live underlying for part of the day. Scanned
// while their market is shut they look ideal - a wide spread and almost no
// volatility - but nothing trades, so there is no volume to farm, and a maker
// resting through the open eats the whole gap. Commodities (oil, gold, silver)
// and crypto run nearly around the clock. Judge any instrument on a scan that
// spans a full day, and treat a short scan as a shortlist only.
//
// Usage: node tools/venue-scan.mjs [--minutes 10] [--top 20] [--report 0]
//   --report N   also print a snapshot every N minutes, for long runs

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const MINUTES = Number(opt("minutes", "10"));
const TOP = Number(opt("top", "20"));
const REPORT_MIN = Number(opt("report", "0"));
const POLL_MS = 1000;
const BASE = "https://api.perpetuals.polymarket.com";

// Measured on BTC-USD: markout -2.14 bps against 5s volatility of 1.90 bps.
// This is the bar another instrument has to clear, not an assumption applied
// to it: earn/vol must exceed 1.13 to be better than what we trade today.
const BTC_ADVERSE_PER_VOL = 1.13;
const REBATE_BPS = 0.5;

const j = async (p) => (await fetch(BASE + p)).json();

const meta = new Map();
for (const i of await j("/v1/info/instruments")) {
  meta.set(i.instrument_id, { symbol: i.symbol, category: i.category, minNotional: Number(i.min_notional) });
}

const per = new Map();

// ---- analysis ------------------------------------------------------------
const med = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// Standard deviation of 5-second mid returns, in bps.
//
// Paired by TIMESTAMP, not by sample count: /v1/info/bbo returns all 89
// instruments at once and can take several seconds, so the polling interval
// drifts. Counting samples instead of seconds would silently measure a
// different horizon per run and make instruments incomparable.
const VOL_WINDOW_MS = 5000;
function vol5s(mids) {
  const rs = [];
  let j = 0;
  for (let i = 0; i < mids.length; i++) {
    const target = mids[i].t - VOL_WINDOW_MS;
    while (j < i && mids[j].t < target) j++;
    if (j === 0 || j >= i) continue;
    // mids[j-1] is the last sample at or before the target instant.
    const a = mids[j - 1];
    if (Math.abs(a.t - target) > VOL_WINDOW_MS / 2) continue; // too far to call it a 5s gap
    if (a.mid > 0 && mids[i].mid > 0) rs.push(((mids[i].mid - a.mid) / a.mid) * 1e4);
  }
  if (rs.length < 20) return NaN;
  const mu = rs.reduce((x, y) => x + y, 0) / rs.length;
  return Math.sqrt(rs.reduce((x, y) => x + (y - mu) ** 2, 0) / (rs.length - 1));
}

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

function rank() {
  const out = [];
  for (const [iid, s] of per) {
    const m = meta.get(iid);
    const spread = med(s.spreads);
    const vol = vol5s(s.mids);
    if (!Number.isFinite(spread) || !Number.isFinite(vol)) continue;
    const earn = spread / 2 + REBATE_BPS;
    out.push({
      symbol: m.symbol,
      category: m.category,
      spread,
      vol,
      earn,
      // How many times its own volatility this market pays us to quote it.
      // Above 1.13 beats BTC; well above 1.13 might actually make money.
      ratio: earn / vol,
      net: earn - BTC_ADVERSE_PER_VOL * vol,
      touchUsd: med(s.touch),
      // Per minute of wall clock, not per sample: the poll interval drifts.
      movesPerMin: s.moves / Math.max(1 / 60, (s.mids.at(-1).t - s.mids[0].t) / 60_000),
      minNotional: m.minNotional,
    });
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

const HEAD = `  ${"symbol".padEnd(16)} ${"cat".padEnd(10)} ${"spread".padStart(7)} ${"vol5s".padStart(7)} ${"earn".padStart(6)} ${"RATIO".padStart(6)} ${"net".padStart(7)}  ${"touch$".padStart(8)} ${"moves/min".padStart(9)} ${"min$".padStart(5)}`;
const row = (r, suffix = "") =>
  `  ${r.symbol.padEnd(16)} ${String(r.category).padEnd(10)} ${f(r.spread).padStart(7)} ${f(r.vol).padStart(7)} ${f(r.earn).padStart(6)} ${f(r.ratio).padStart(6)} ${f(r.net).padStart(7)}  ${("$" + Math.round(r.touchUsd)).padStart(8)} ${f(r.movesPerMin, 1).padStart(9)} ${("$" + r.minNotional).padStart(5)}${suffix}`;

function report(label) {
  const out = rank();
  console.log(`\nVENUE SCAN  ${label}  ${out.length} instruments   ${new Date().toISOString().slice(11, 19)} UTC\n`);
  console.log(`  earn  = half-spread + ${REBATE_BPS} bps rebate`);
  console.log(`  RATIO = earn / 5s volatility. Assumption-free. BTC measures ${BTC_ADVERSE_PER_VOL};`);
  console.log(`          anything above that is a better market than the one we trade today.`);
  console.log(`  net   = earn - ${BTC_ADVERSE_PER_VOL} x vol, i.e. IF this market is as toxic as BTC.`);
  console.log(`  moves/min is the activity proxy: a wide spread nobody trades farms no volume.\n`);
  console.log(HEAD);
  console.log(`  ${"-".repeat(100)}`);
  for (const r of out.slice(0, TOP)) console.log(row(r));
  console.log(`\n  where we trade now:`);
  for (const sym of ["BTC-USD", "ETH-USD"]) {
    const r = out.find((x) => x.symbol === sym);
    if (r) console.log(row(r, `  <- rank ${out.indexOf(r) + 1}/${out.length}`));
  }
  console.log();
}

// ---- sampling ------------------------------------------------------------
// Run to a wall-clock deadline. The bbo call for all 89 instruments can take
// seconds, so a fixed sample count would mean an unpredictable duration.
const startedAt = Date.now();
const stopAt = startedAt + MINUTES * 60_000;
let nextReportAt = REPORT_MIN > 0 ? startedAt + REPORT_MIN * 60_000 : Infinity;
let nextProgressAt = startedAt + 60_000;
let polls = 0;
process.stderr.write(`sampling ${meta.size} instruments until ${new Date(stopAt).toISOString().slice(11, 19)} UTC...\n`);

while (Date.now() < stopAt) {
  const pollStart = Date.now();
  let rows;
  try {
    rows = await j("/v1/info/bbo");
  } catch (e) {
    process.stderr.write(`poll: ${e.message}\n`);
    await new Promise((r) => setTimeout(r, POLL_MS));
    continue;
  }
  polls++;
  const now = Date.now();
  for (const r of rows) {
    if (!meta.has(r.instrument_id)) continue;
    const bid = Number(r.bid_price);
    const ask = Number(r.ask_price);
    if (!(bid > 0) || !(ask > bid)) continue;
    const mid = (bid + ask) / 2;
    let s = per.get(r.instrument_id);
    if (!s) per.set(r.instrument_id, (s = { spreads: [], mids: [], touch: [], moves: 0, lastMid: NaN }));
    s.spreads.push(((ask - bid) / mid) * 1e4);
    s.mids.push({ t: now, mid });
    s.touch.push(Math.min(Number(r.bid_quantity) * bid, Number(r.ask_quantity) * ask));
    if (Number.isFinite(s.lastMid) && s.lastMid !== mid) s.moves++;
    s.lastMid = mid;
  }
  const now2 = Date.now();
  if (now2 >= nextProgressAt) {
    const mins = (now2 - startedAt) / 60_000;
    process.stderr.write(`  ${mins.toFixed(0)}/${MINUTES} min, ${polls} polls (${((now2 - startedAt) / polls / 1000).toFixed(1)}s apart)\n`);
    nextProgressAt = now2 + 60_000;
  }
  if (now2 >= nextReportAt) {
    report(`snapshot at ${((now2 - startedAt) / 60_000).toFixed(0)} min`);
    nextReportAt = now2 + REPORT_MIN * 60_000;
  }
  // Pace to POLL_MS between starts; if the call itself took longer, go again.
  const wait = POLL_MS - (Date.now() - pollStart);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

report(`${MINUTES} min final, ${polls} polls`);
