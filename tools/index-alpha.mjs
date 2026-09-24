#!/usr/bin/env node
// Does Polymarket's index price LEAD its order book?
//
// Reads logs/index.csv from tools/record-index.mjs and answers, in order:
//
//   1. Is the basis (index - mid) a constant offset, or does it move?
//      A constant carries no information. Only deviations can predict.
//   2. Does a deviation predict where the mid goes next? This is the whole
//      question: slope near 1 means the mid closes the entire gap, slope 0
//      means the gap is noise.
//   3. What would it be worth? Adverse selection is the price moving against
//      us after a fill. If the signal predicts that move, declining to quote
//      the side it warns about removes exactly those fills.
//
// The signal is the basis minus its own slow EMA, because a persistent offset
// (funding, a different index composition) is not tradeable - only the wobble
// around it is.
//
// Usage: node tools/index-alpha.mjs [--file logs/index.csv] [--halflife 300]

import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const FILE = opt("file", "logs/index.csv");
const HALFLIFE_S = Number(opt("halflife", "300"));
const HORIZONS = [1, 2, 5, 10, 30, 60];
const SYM = { 6: "BTC-USD", 7: "ETH-USD" };

// ---- load ---------------------------------------------------------------
const lines = fs.readFileSync(FILE, "utf8").split("\n");
const books = new Map(); // iid -> [{ts, mid, bid, ask}]
const idx = new Map(); // iid -> [{ts, exchTs, index}]
const push = (map, iid, row) => {
  if (!map.has(iid)) map.set(iid, []);
  map.get(iid).push(row);
};

for (let i = 1; i < lines.length; i++) {
  const L = lines[i];
  if (!L) continue;
  const [recvTs, src, iidS, exchTs, index, , bid, ask] = L.split(",");
  const iid = Number(iidS);
  if (!SYM[iid]) continue;
  if (src === "bbo") {
    const b = Number(bid);
    const a = Number(ask);
    if (!(b > 0 && a > b)) continue;
    push(books, iid, { ts: Number(recvTs), mid: (a + b) / 2, bid: b, ask: a });
  } else if (src === "idx") {
    const v = Number(index);
    if (!(v > 0)) continue;
    push(idx, iid, { ts: Number(recvTs), exchTs: Number(exchTs), index: v });
  }
}

// Last book at or before t. Rows are appended in time order.
function bookAt(arr, t) {
  let lo = 0;
  let hi = arr.length - 1;
  let best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].ts <= t) {
      best = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return best < 0 ? null : arr[best];
}

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function stats(xs) {
  const n = xs.length;
  if (!n) return { n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(n - 1, Math.max(0, Math.floor(p * n)))];
  return { n, mean, sd, min: s[0], p05: q(0.05), med: q(0.5), p95: q(0.95), max: s[n - 1] };
}

// Ordinary least squares y = a + b*x, plus the correlation r.
function ols(xs, ys) {
  const n = xs.length;
  if (n < 30) return { n, slope: NaN, r: NaN, sdX: NaN };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return { n, slope: sxy / sxx, r: sxy / Math.sqrt(sxx * syy), sdX: Math.sqrt(sxx / n) };
}

// ---- per instrument -----------------------------------------------------
for (const iid of [...idx.keys()].sort()) {
  const I = idx.get(iid);
  const B = books.get(iid) ?? [];
  if (I.length < 50 || B.length < 50) {
    console.log(`\n${SYM[iid]}: not enough data (idx=${I.length} bbo=${B.length})`);
    continue;
  }
  const spanMin = (I[I.length - 1].ts - I[0].ts) / 60000;
  console.log(`\n${"=".repeat(76)}\n${SYM[iid]}  ${I.length} index samples, ${B.length} book updates, ${fmt(spanMin, 1)} min`);

  // --- 1. the basis ---
  const perSample = 1.8; // seconds between distinct index snapshots
  const alpha = 1 - Math.exp(-Math.LN2 / (HALFLIFE_S / perSample));
  let ema = NaN;
  const rows = [];
  for (const s of I) {
    const bk = bookAt(B, s.ts);
    if (!bk) continue;
    const basis = ((s.index - bk.mid) / bk.mid) * 1e4; // bps
    ema = Number.isFinite(ema) ? ema + alpha * (basis - ema) : basis;
    rows.push({ ts: s.ts, mid: bk.mid, basis, ema, signal: basis - ema });
  }
  const bs = stats(rows.map((r) => r.basis));
  const sg = stats(rows.map((r) => r.signal));
  console.log(`\n  basis (index - mid), bps`);
  console.log(`    mean ${fmt(bs.mean)}  sd ${fmt(bs.sd)}   p05 ${fmt(bs.p05)}  med ${fmt(bs.med)}  p95 ${fmt(bs.p95)}   range ${fmt(bs.min)} .. ${fmt(bs.max)}`);
  console.log(`  signal (basis minus its ${HALFLIFE_S}s EMA), bps`);
  console.log(`    sd ${fmt(sg.sd)}   p05 ${fmt(sg.p05)}  med ${fmt(sg.med)}  p95 ${fmt(sg.p95)}   range ${fmt(sg.min)} .. ${fmt(sg.max)}`);
  if (bs.sd < 0.1) console.log(`    -> the basis barely moves: it is a constant offset and carries no information.`);

  // --- 2. does the signal predict the next move? ---
  console.log(`\n  future mid move regressed on signal   (slope 1.0 = mid closes the whole gap)`);
  console.log(`    horizon      n     slope       r    signal sd   move at 1sd`);
  for (const h of HORIZONS) {
    const xs = [];
    const ys = [];
    for (const r of rows) {
      const fut = bookAt(B, r.ts + h * 1000);
      if (!fut || fut.ts < r.ts + h * 500) continue; // need a real later observation
      xs.push(r.signal);
      ys.push(((fut.mid - r.mid) / r.mid) * 1e4);
    }
    const o = ols(xs, ys);
    console.log(
      `    +${String(h).padStart(3)}s   ${String(o.n).padStart(6)}   ${fmt(o.slope).padStart(6)}  ${fmt(o.r).padStart(6)}   ${fmt(o.sdX).padStart(6)} bps   ${fmt(o.slope * o.sdX).padStart(6)} bps`,
    );
  }

  // --- 3. what is it worth? ---
  // A maker filled on the ask loses when the mid rises afterwards. Quoting a
  // side only when the signal does not warn against it removes those fills.
  const h = 5;
  const pairs = [];
  for (const r of rows) {
    const fut = bookAt(B, r.ts + h * 1000);
    if (!fut || fut.ts < r.ts + h * 500) continue;
    pairs.push({ signal: r.signal, fwd: ((fut.mid - r.mid) / r.mid) * 1e4 });
  }
  if (pairs.length >= 100) {
    const byS = [...pairs].sort((a, b) => a.signal - b.signal);
    console.log(`\n  mid move over the next ${h}s, by signal decile`);
    console.log(`    decile    signal range (bps)     mean fwd move (bps)    n`);
    const D = 10;
    for (let d = 0; d < D; d++) {
      const lo = Math.floor((d * byS.length) / D);
      const hi = Math.floor(((d + 1) * byS.length) / D);
      const slice = byS.slice(lo, hi);
      if (!slice.length) continue;
      const m = slice.reduce((a, b) => a + b.fwd, 0) / slice.length;
      console.log(
        `      ${String(d + 1).padStart(2)}    ${fmt(slice[0].signal).padStart(7)} .. ${fmt(slice[slice.length - 1].signal).padEnd(8)} ${fmt(m).padStart(8)}         ${slice.length}`,
      );
    }

    // Signal > 0 means the index is above the mid: the mid should rise, so the
    // ASK is the side about to be picked off. Signal < 0 warns the bid.
    console.log(`\n  gate simulation: skip the side the signal warns about`);
    console.log(`    threshold   samples kept   avoided move on skipped side   kept-side |move|`);
    for (const th of [0.5, 1, 1.5, 2, 3]) {
      const warned = pairs.filter((p) => Math.abs(p.signal) >= th);
      const kept = pairs.filter((p) => Math.abs(p.signal) < th);
      if (warned.length < 20 || kept.length < 20) continue;
      const avoided = warned.reduce((a, p) => a + Math.sign(p.signal) * p.fwd, 0) / warned.length;
      const keptMove = kept.reduce((a, p) => a + Math.abs(p.fwd), 0) / kept.length;
      console.log(
        `      ${fmt(th, 1).padStart(4)} bps   ${pct(kept.length / pairs.length).padStart(7)}        ${fmt(avoided).padStart(7)} bps                 ${fmt(keptMove).padStart(7)} bps`,
      );
    }
  }
}
console.log();
