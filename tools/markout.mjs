#!/usr/bin/env node
// Offline analysis of the bot's own logs. Read-only: it never touches the
// exchange, the state file or anything the running bot depends on.
//
//   node tools/markout.mjs                          whole of today's live log
//   node tools/markout.mjs --since 2026-09-23T01:56 --until 2026-09-23T04:21
//   node tools/markout.mjs --split 2026-09-23T01:56 compare before vs after
//   node tools/markout.mjs --calibrate 10000        rolling 10s mid-range percentiles
//
// WHY THIS EXISTS
// Cost per $1M is dominated by the market regime: the same change measured 33%
// better over 39 minutes and 13% worse over 145 minutes on 23 Sep, because the
// second window had a 1% rally in it. Markout is per-fill, converges in a few
// hundred fills, and answers the only question that matters for adverse
// selection: where did the price go right after we got filled?
//
// MID RECONSTRUCTION
// When logs/reference.csv exists (any reference mode but "off", and always in
// strategy.mode "fair") its pmMid column is Polymarket's mid once a second,
// and that is used. Otherwise the mid is rebuilt from our own placements.
// That fallback only works in "join" mode: our own quote
// placements sit ON the best bid/ask, so quotes.csv is a sampled BBO. The one
// correction needed is that a quote placed while an adverse signal is firing is
// deliberately `backoffTicks` behind the best, so that offset is added back.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tickAt } from "../src/precision.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// price_decimals from /v1/info/instruments. The 5-significant-figure rule in
// precision.mjs usually dominates these anyway (BTC ticks at $1, ETH at $0.10).
// price_decimals from /v1/info/instruments. A symbol missing here is dropped
// from the reconstructed book and silently produces no markout, so anything
// the bot trades must be listed; unknown symbols are reported below.
const PRICE_DECIMALS = { "BTC-USD": 1, "ETH-USD": 2, "BNB-USD": 2, "SOL-USD": 3, "LINK-USD": 3 };

const HORIZONS_SEC = [5, 30, 120];
const MAX_MID_GAP_MS = 120_000; // refuse to price a markout off a sample this stale

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const a = {
    logs: path.join(HERE, "..", "logs"),
    mode: "live",
    since: null,
    until: null,
    split: null,
    by: null,
    calibrate: null,
    backoffTicks: null, // read from config.json when not given
  };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split("=");
    const val = () => inline ?? argv[++i];
    switch (k) {
      case "--logs": a.logs = val(); break;
      case "--mode": a.mode = val(); break;
      case "--since": a.since = val(); break;
      case "--until": a.until = val(); break;
      case "--split": a.split = val(); break;
      case "--by": a.by = val(); break;
      case "--calibrate": a.calibrate = Number(val()); break;
      case "--backoff-ticks": a.backoffTicks = Number(val()); break;
      case "--help": case "-h": a.help = true; break;
      default: throw new Error(`unknown option ${k} (try --help)`);
    }
  }
  return a;
}

const USAGE = `
markout.mjs — what happened to the price right after we got filled

  --logs DIR           logs directory (default: ../logs)
  --mode live|dry      which rows to read (default: live)
  --since TS           ISO timestamp, inclusive (prefix match is fine)
  --until TS           ISO timestamp, exclusive
  --split TS           report the window before and after TS separately
  --by level|age       also break markout down by ladder level or order age
                       (how long the order rested before it filled)
  --calibrate MS       also print the rolling mid-range distribution over MS
  --backoff-ticks N    override quote.adverse.backoffTicks from config.json
`;

// ---------------------------------------------------------------- csv

// Minimal RFC4180 reader: report.mjs quotes any cell containing , " or newline.
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  if (!head) return [];
  return rows
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const num = (x) => (x === "" || x == null ? null : Number(x));

// ---------------------------------------------------------------- mid series

// Rebuild best-bid and best-ask series per symbol from our own placements.
// A quote placed under an adverse signal is backoffTicks behind the best, so
// that offset is added back; ignoring it biases the mid whenever the two sides
// back off at different rates (on 23 Sep: 498 ask vs 160 bid back-offs).
function buildBook(quotes, backoffTicks) {
  const bysymbol = new Map();
  const unknown = new Set();
  for (const q of quotes) {
    if (q.action !== "place") continue;
    if (q.intent !== "quote-bid" && q.intent !== "quote-ask") continue;
    const price = num(q.price);
    if (!(price > 0)) continue;
    const decimals = PRICE_DECIMALS[q.symbol];
    if (decimals === undefined) {
      // Say so. Dropping a symbol quietly would report "no maker quote fills"
      // for a market the bot really traded, which reads as a result.
      unknown.add(q.symbol);
      continue;
    }

    let best = price;
    if (q.reason?.startsWith("back off")) {
      const back = backoffTicks * tickAt(price, decimals);
      best = q.side === "buy" ? price + back : price - back;
    }
    const s = bysym(bysymbol, q.symbol);
    (q.side === "buy" ? s.bid : s.ask).push([Date.parse(q.ts), best]);
  }
  for (const s of bysymbol.values()) {
    s.bid.sort((a, b) => a[0] - b[0]);
    s.ask.sort((a, b) => a[0] - b[0]);
  }
  if (unknown.size) {
    console.log(`\n  WARNING: no price_decimals for ${[...unknown].join(", ")} - those markets are MISSING from this report.`);
    console.log(`  Add them to PRICE_DECIMALS in tools/markout.mjs (see /v1/info/instruments).`);
  }
  return bysymbol;
}

// Polymarket's mid once a second, as the bot saw it (reference.csv). Replaces
// the placement-based series for every symbol it covers, because in "fair"
// mode our orders rest away from the best price and are not a sampled BBO.
function mergeReferenceMids(book, refRows) {
  const mids = new Map();
  for (const r of refRows) {
    const t = Date.parse(r.ts);
    const m = num(r.pmMid);
    if (!(m > 0) || !Number.isFinite(t) || !r.symbol) continue;
    if (!mids.has(r.symbol)) mids.set(r.symbol, []);
    mids.get(r.symbol).push([t, m]);
  }
  for (const [symbol, series] of mids) {
    series.sort((x, y) => x[0] - y[0]);
    book.set(symbol, { bid: series, ask: series, source: "reference.csv" });
  }
  return mids.size;
}

function bysym(map, symbol) {
  let s = map.get(symbol);
  if (!s) map.set(symbol, (s = { bid: [], ask: [] }));
  return s;
}

// First sample at or after t, if it is close enough to be meaningful.
function sampleAt(series, t) {
  let lo = 0, hi = series.length - 1, found = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (series[m][0] >= t) { found = series[m]; hi = m - 1; } else lo = m + 1;
  }
  return found && found[0] - t <= MAX_MID_GAP_MS ? found[1] : null;
}

function midAt(book, symbol, t) {
  const s = book.get(symbol);
  if (!s) return null;
  const bid = sampleAt(s.bid, t);
  const ask = sampleAt(s.ask, t);
  return bid != null && ask != null ? (bid + ask) / 2 : null;
}

// ---------------------------------------------------------------- stats

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const usd = (x, dp = 4) => `$${x.toFixed(dp)}`;
const bps = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} bps`;

// ---------------------------------------------------------------- report

function costBreakdown(fills) {
  const volume = sum(fills.map((f) => f.notional));
  const fees = sum(fills.map((f) => f.fee));
  const tradingPnl = sum(fills.map((f) => f.realized_pnl));
  const maker = fills.filter((f) => f.liquidity === "maker");
  const taker = fills.filter((f) => f.liquidity === "taker");
  const netCost = fees - tradingPnl; // funding lands in the summary, not per fill
  return {
    volume, fees, tradingPnl, netCost,
    fills: fills.length,
    makerVolume: sum(maker.map((f) => f.notional)),
    takerVolume: sum(taker.map((f) => f.notional)),
    makerFees: sum(maker.map((f) => f.fee)),
    takerFees: sum(taker.map((f) => f.fee)),
    per1M: volume > 0 ? (1e6 * netCost) / volume : 0,
  };
}

function markouts(fills, book) {
  const out = new Map();
  for (const f of fills) {
    if (f.liquidity !== "maker" || !f.intent?.startsWith("quote")) continue;
    const t = Date.parse(f.ts);
    const sign = f.side === "buy" ? 1 : -1;
    let row = out.get(f.symbol);
    if (!row) out.set(f.symbol, (row = { n: 0, h: new Map() }));
    row.n++;
    for (const H of HORIZONS_SEC) {
      const m = midAt(book, f.symbol, t + H * 1000);
      if (m == null) continue;
      let h = row.h.get(H);
      if (!h) row.h.set(H, (h = { bpsList: [], usd: 0 }));
      h.bpsList.push((1e4 * sign * (m - f.price)) / f.price);
      h.usd += sign * (m - f.price) * f.qty;
    }
  }
  return out;
}

// Markout grouped by a key: is the ladder's deep level less toxic than its
// first, and do orders that rested longer (front of the queue) fill better?
function printMarkoutBy(fills, book, by) {
  const keyOf =
    by === "level"
      ? (f) => (f.level === "" || f.level == null ? "join mode" : `level ${f.level}`)
      : (f) => {
          const ms = num(f.order_age_ms);
          if (ms == null) return "unknown";
          if (ms < 1_000) return "a <1s";
          if (ms < 5_000) return "b 1-5s";
          if (ms < 30_000) return "c 5-30s";
          if (ms < 120_000) return "d 30-120s";
          return "e 120s+";
        };
  const groups = new Map();
  for (const f of fills) {
    if (f.liquidity !== "maker" || !f.intent?.startsWith("quote")) continue;
    const k = keyOf(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  console.log(`\n  MARKOUT BY ${by.toUpperCase()} (vs fill price; + means the price went our way)`);
  if (!groups.size) { console.log("    no maker quote fills"); return; }
  for (const k of [...groups.keys()].sort()) {
    const g = groups.get(k);
    const cols = HORIZONS_SEC.map((H) => {
      const xs = [];
      for (const f of g) {
        const m = midAt(book, f.symbol, Date.parse(f.ts) + H * 1000);
        if (m != null) xs.push((1e4 * (f.side === "buy" ? 1 : -1) * (m - f.price)) / f.price);
      }
      return `+${H}s ${xs.length ? bps(mean(xs)) : "n/a"}`;
    });
    const edges = g.map((f) => num(f.edge_vs_fair_bps)).filter((x) => x != null);
    const edge = edges.length ? `  vs fair ${bps(mean(edges))}` : "";
    console.log(`    ${k.padEnd(12)} ${String(g.length).padStart(5)} fills  ${cols.join("  ")}${edge}`);
  }
}

function printWindow(label, fills, book, by = null) {
  if (!fills.length) { console.log(`\n=== ${label} ===\n  no fills in window`); return; }
  const first = Date.parse(fills[0].ts), last = Date.parse(fills.at(-1).ts);
  const mins = Math.max(1 / 60, (last - first) / 60_000);
  const c = costBreakdown(fills);

  console.log(`\n=== ${label} ===`);
  console.log(`  ${fills[0].ts.slice(0, 19)} -> ${fills.at(-1).ts.slice(0, 19)}  (${mins.toFixed(0)} min)`);
  console.log(`  volume      ${usd(c.volume, 2)}  (${c.fills} fills, ${usd((c.volume / mins) * 60, 0)}/hour, ${(c.fills / mins).toFixed(1)} fills/min)`);
  console.log(`  maker       ${usd(c.makerVolume, 0)} (${pct(c.makerVolume, c.volume)})  fees ${usd(c.makerFees)}`);
  console.log(`  taker       ${usd(c.takerVolume, 0)} (${pct(c.takerVolume, c.volume)})  fees ${usd(c.takerFees)}`);
  console.log(`  net fees    ${usd(c.fees)}   (${bpsOf(c.fees, c.volume)} of volume)`);
  console.log(`  adverse sel ${usd(-c.tradingPnl)}   (costs ${(c.volume > 0 ? (-1e4 * c.tradingPnl) / c.volume : 0).toFixed(2)} bps of volume)`);
  console.log(`  NET COST    ${usd(c.netCost)}  ->  $${c.per1M.toFixed(0)} per $1M`);

  console.log(`\n  MARKOUT (maker quote fills; negative = picked off)`);
  const mk = markouts(fills, book);
  if (!mk.size) console.log("    no maker quote fills");
  for (const [symbol, row] of mk) {
    console.log(`    ${symbol}  ${row.n} fills`);
    for (const H of HORIZONS_SEC) {
      const h = row.h.get(H);
      if (!h || !h.bpsList.length) { console.log(`      +${String(H).padStart(3)}s  (no mid)`); continue; }
      const sorted = [...h.bpsList].sort((a, b) => a - b);
      console.log(
        `      +${String(H).padStart(3)}s  n=${String(h.bpsList.length).padStart(4)}` +
        `  mean ${bps(mean(h.bpsList))}  median ${bps(percentile(sorted, 50))}  total ${usd(h.usd)}`,
      );
    }
  }
  if (by) printMarkoutBy(fills, book, by);
  return c;
}

const pct = (x, total) => `${total ? ((100 * x) / total).toFixed(0) : 0}%`;
const bpsOf = (x, volume) => (volume > 0 ? bps((1e4 * x) / volume) : "n/a");

function printPricePath(fills) {
  console.log(`\n  PRICE PATH (so a trend is not mistaken for a bad strategy)`);
  const bySymbol = new Map();
  for (const f of fills) {
    let a = bySymbol.get(f.symbol);
    if (!a) bySymbol.set(f.symbol, (a = []));
    a.push(f.price);
  }
  for (const [symbol, prices] of bySymbol) {
    const first = prices[0], last = prices.at(-1);
    const hi = Math.max(...prices), lo = Math.min(...prices);
    console.log(
      `    ${symbol.padEnd(8)} ${first} -> ${last}  ` +
      `(${(((last / first) - 1) * 100).toFixed(2)}%)  range ${(((hi / lo) - 1) * 100).toFixed(2)}%`,
    );
  }
}

function printBuckets(fills) {
  const bucket = (keyOf, title) => {
    const m = new Map();
    for (const f of fills) {
      const k = keyOf(f);
      let b = m.get(k);
      if (!b) m.set(k, (b = { volume: 0, fees: 0, pnl: 0, n: 0 }));
      b.volume += f.notional; b.fees += f.fee; b.pnl += f.realized_pnl; b.n++;
    }
    console.log(`\n  ${title}`);
    const rows = [...m.entries()]
      .map(([k, b]) => ({ k, ...b, per1M: b.volume > 0 ? (1e6 * (b.fees - b.pnl)) / b.volume : 0 }))
      .sort((a, b) => a.per1M - b.per1M);
    for (const r of rows) {
      console.log(`    ${String(r.k).padEnd(16)} ${usd(r.volume, 0).padStart(9)}  ${String(r.n).padStart(4)} fills   $${r.per1M.toFixed(0).padStart(5)} per $1M`);
    }
  };
  bucket((f) => `${f.ts.slice(11, 13)}:00 UTC`, "COST BY HOUR (cheapest first -> Lever D)");
  bucket((f) => f.symbol, "COST BY MARKET");
}

// Rolling peak-to-trough mid range, the metric the volatility gate will use.
// Percentiles here choose pauseBps/widenBps instead of copying arcus's numbers,
// whose venue is far wider than Polymarket's ~0.2 bps spread.
function printCalibration(book, windowMs) {
  console.log(`\n=== VOLATILITY CALIBRATION (rolling ${windowMs} ms mid range) ===`);
  for (const [symbol, s] of book) {
    const mids = [];
    for (const [t] of s.bid) {
      const m = midAt(book, symbol, t);
      if (m != null) mids.push([t, m]);
    }
    if (mids.length < 10) { console.log(`  ${symbol}: too few samples (${mids.length})`); continue; }
    const ranges = [];
    let lo = 0;
    for (let hi = 0; hi < mids.length; hi++) {
      while (mids[hi][0] - mids[lo][0] > windowMs) lo++;
      if (hi - lo < 2) continue;
      let min = Infinity, max = -Infinity;
      for (let i = lo; i <= hi; i++) { const v = mids[i][1]; if (v < min) min = v; if (v > max) max = v; }
      ranges.push((1e4 * (max - min)) / mids[hi][1]);
    }
    ranges.sort((a, b) => a - b);
    const p = (q) => percentile(ranges, q).toFixed(2);
    console.log(`  ${symbol}  n=${ranges.length}`);
    console.log(`    p50 ${p(50)}  p75 ${p(75)}  p90 ${p(90)}  p95 ${p(95)}  p99 ${p(99)}  max ${percentile(ranges, 100).toFixed(2)} bps`);
    console.log(`    -> suggested widenBps ${p(90)}   pauseBps ${p(99)}`);
  }
}

// ---------------------------------------------------------------- main

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(USAGE); return; }

  let backoffTicks = a.backoffTicks;
  if (backoffTicks == null) {
    const cfgFile = path.join(HERE, "..", "config.json");
    backoffTicks = fs.existsSync(cfgFile)
      ? (JSON.parse(fs.readFileSync(cfgFile, "utf8")).quote?.adverse?.backoffTicks ?? 1)
      : 1;
  }

  const inWindow = (ts) => (!a.since || ts >= a.since) && (!a.until || ts < a.until);
  // Mids are needed up to the longest horizon after the last fill.
  const pad = (ts, ms) => new Date(Date.parse(ts) + ms).toISOString();
  const inWindowWide = (ts) => (!a.since || ts >= a.since) && (!a.until || ts < pad(a.until, (Math.max(...HORIZONS_SEC) + 5) * 1000));
  if (a.by && a.by !== "level" && a.by !== "age") throw new Error(`--by must be "level" or "age" (got "${a.by}")`);

  const fills = readCsv(path.join(a.logs, "fills.csv"))
    .filter((f) => f.mode === a.mode && inWindow(f.ts))
    .map((f) => ({
      ...f,
      price: num(f.price), qty: num(f.qty), notional: num(f.notional),
      fee: num(f.fee), realized_pnl: num(f.realized_pnl),
    }))
    .sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));

  const quotes = readCsv(path.join(a.logs, "quotes.csv")).filter((q) => q.mode === a.mode);
  const book = buildBook(quotes, backoffTicks);
  const refSymbols = mergeReferenceMids(book, readCsv(path.join(a.logs, "reference.csv")).filter((r) => inWindowWide(r.ts)));

  console.log(`logs ${a.logs}  mode ${a.mode}  backoffTicks ${backoffTicks}`);
  console.log(`${fills.length} fills, ${quotes.length} quote rows, book samples: ` +
    [...book].map(([s, v]) => `${s} ${v.bid.length}/${v.ask.length}`).join("  ") +
    (refSymbols ? "  (mid from reference.csv)" : "  (mid rebuilt from our placements: only valid in join mode)"));

  if (a.split) {
    printWindow("BEFORE " + a.split, fills.filter((f) => f.ts < a.split), book, a.by);
    printWindow("AFTER  " + a.split, fills.filter((f) => f.ts >= a.split), book, a.by);
  } else {
    printWindow("WINDOW", fills, book, a.by);
  }
  if (fills.length) {
    printPricePath(fills);
    printBuckets(fills);
  }
  if (a.calibrate) printCalibration(book, a.calibrate);
}

main();
