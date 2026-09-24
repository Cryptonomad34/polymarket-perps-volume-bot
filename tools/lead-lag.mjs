#!/usr/bin/env node
// Does Binance lead Polymarket, and is the lead big enough to be worth money?
//
// Reads logs/ref.csv from tools/record-ref.mjs (pm = Polymarket book,
// bin = Binance futures book, idx = Polymarket index price) and reports:
//
//   1. Cross-correlation of returns at a range of lags. If Binance leads, the
//      correlation peaks at a positive lag, and that lag is our reaction
//      budget. A peak at lag 0 means the two move together and there is
//      nothing to react to.
//   2. The edge signal (how far Polymarket has lagged its usual basis)
//      regressed on where Polymarket goes next. Slope near 1 means Polymarket
//      closes the whole gap.
//   3. A gate simulation: if we stop quoting the warned side, how much adverse
//      movement do we avoid, and how much quoting time does it cost?
//
// Everything is measured on OUR receive timestamps, not exchange stamps, so
// the answer is what a bot on this machine could actually have acted on.
//
// Usage: node tools/lead-lag.mjs [--file logs/ref.csv] [--halflife 300] [--grid 100]

import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const FILE = opt("file", "logs/ref.csv");
const HALFLIFE_S = Number(opt("halflife", "300"));
const GRID_MS = Number(opt("grid", "100"));
const SYM = { 6: "BTC-USD", 7: "ETH-USD" };
const LAGS_MS = [-2000, -1000, -500, -300, -200, -100, 0, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000];
const HORIZONS_S = [1, 2, 5, 10, 30];

// ---- load ---------------------------------------------------------------
const series = new Map(); // `${src}|${iid}` -> [{ts, mid}]
const key = (src, iid) => `${src}|${iid}`;
for (const line of fs.readFileSync(FILE, "utf8").split("\n").slice(1)) {
  if (!line) continue;
  const [recvTs, src, iidS, , bid, ask] = line.split(",");
  const iid = Number(iidS);
  if (!SYM[iid]) continue;
  const b = Number(bid);
  const a = Number(ask);
  if (!(b > 0) || !(a > 0)) continue;
  const k = key(src, iid);
  if (!series.has(k)) series.set(k, []);
  series.get(k).push({ ts: Number(recvTs), mid: (a + b) / 2 });
}

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// Resample onto a uniform grid, carrying the last value forward. Both feeds
// must sit on the same clock before their returns can be compared.
function resample(arr, t0, t1, step) {
  const out = new Float64Array(Math.floor((t1 - t0) / step) + 1);
  let i = 0;
  let last = NaN;
  for (let k = 0; k < out.length; k++) {
    const t = t0 + k * step;
    while (i < arr.length && arr[i].ts <= t) last = arr[i++].mid;
    out[k] = last;
  }
  return out;
}

function corr(xs, ys) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    n++;
    sx += xs[i];
    sy += ys[i];
  }
  if (n < 30) return { n, r: NaN };
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return { n, r: sxy / Math.sqrt(sxx * syy), slope: sxy / sxx, sdX: Math.sqrt(sxx / n) };
}

function valueAt(arr, t) {
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

// ---- per instrument -----------------------------------------------------
for (const iid of [6, 7]) {
  const pm = series.get(key("pm", iid)) ?? [];
  const bin = series.get(key("bin", iid)) ?? [];
  const idx = series.get(key("idx", iid)) ?? [];
  if (pm.length < 100 || bin.length < 100) {
    console.log(`\n${SYM[iid]}: not enough data (pm=${pm.length} bin=${bin.length})`);
    continue;
  }
  const t0 = Math.max(pm[0].ts, bin[0].ts);
  const t1 = Math.min(pm.at(-1).ts, bin.at(-1).ts);
  const mins = (t1 - t0) / 60000;
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${SYM[iid]}   ${fmt(mins, 1)} min   pm=${pm.length} bin=${bin.length} idx=${idx.length} updates`);

  const gp = resample(pm, t0, t1, GRID_MS);
  const gb = resample(bin, t0, t1, GRID_MS);

  // --- 1. lead-lag ---
  // Compare 1-second returns. A positive lag means Binance moved FIRST.
  const W = Math.round(1000 / GRID_MS);
  console.log(`\n  1s-return correlation, Binance shifted against Polymarket`);
  console.log(`  (positive lag = Binance moves first = our reaction budget)`);
  console.log(`    lag      r        n`);
  let best = { r: -2, lag: null };
  for (const lagMs of LAGS_MS) {
    const shift = Math.round(lagMs / GRID_MS);
    const xs = [];
    const ys = [];
    for (let i = W; i < gp.length; i++) {
      const j = i - shift;
      if (j - W < 0 || j >= gb.length) continue;
      const pr = (gp[i] - gp[i - W]) / gp[i - W];
      const br = (gb[j] - gb[j - W]) / gb[j - W];
      if (!Number.isFinite(pr) || !Number.isFinite(br)) continue;
      xs.push(br);
      ys.push(pr);
    }
    const c = corr(xs, ys);
    if (Number.isFinite(c.r) && c.r > best.r) best = { r: c.r, lag: lagMs };
    const bar = Number.isFinite(c.r) ? "#".repeat(Math.max(0, Math.round(c.r * 40))) : "";
    console.log(`  ${String(lagMs).padStart(6)}ms  ${fmt(c.r, 3).padStart(6)}  ${String(c.n).padStart(6)}  ${bar}`);
  }
  console.log(`\n    peak correlation ${fmt(best.r, 3)} at lag ${best.lag}ms`);
  if (best.lag > 0) console.log(`    -> Binance leads by about ${best.lag}ms. That is the window to cancel in.`);
  else if (best.lag === 0) console.log(`    -> they move together at this resolution: no reaction time to exploit.`);
  else console.log(`    -> Polymarket leads Binance, which would be very surprising. Check the data.`);

  // --- 2. the edge signal ---
  const alpha = 1 - Math.exp((-Math.LN2 * GRID_MS) / (HALFLIFE_S * 1000));
  let ema = NaN;
  const rows = [];
  for (let i = 0; i < gp.length; i++) {
    if (!Number.isFinite(gp[i]) || !Number.isFinite(gb[i])) continue;
    const basis = ((gp[i] - gb[i]) / gb[i]) * 1e4;
    ema = Number.isFinite(ema) ? ema + alpha * (basis - ema) : basis;
    rows.push({ t: t0 + i * GRID_MS, mid: gp[i], edge: ema - basis });
  }
  const warm = Math.floor(rows.length * 0.2); // discard while the EMA settles
  const usable = rows.slice(warm);
  const sd = Math.sqrt(usable.reduce((a, r) => a + r.edge ** 2, 0) / usable.length);
  console.log(`\n  edge signal (how far Polymarket has lagged its usual basis)`);
  console.log(`    sd ${fmt(sd)} bps   over ${usable.length} grid points`);

  console.log(`\n  where Polymarket goes next, regressed on the edge`);
  console.log(`    horizon      n     slope       r     move at 1sd edge`);
  for (const h of HORIZONS_S) {
    const xs = [];
    const ys = [];
    const step = Math.round((h * 1000) / GRID_MS);
    for (let i = 0; i + step < usable.length; i += 3) {
      const a = usable[i];
      const b = usable[i + step];
      if (!Number.isFinite(a.mid) || !Number.isFinite(b.mid)) continue;
      xs.push(a.edge);
      ys.push(((b.mid - a.mid) / a.mid) * 1e4);
    }
    const c = corr(xs, ys);
    console.log(`    +${String(h).padStart(3)}s   ${String(c.n).padStart(6)}   ${fmt(c.slope).padStart(6)}  ${fmt(c.r, 3).padStart(6)}      ${fmt(c.slope * c.sdX).padStart(6)} bps`);
  }

  // --- 3. gate simulation ---
  // The 5s horizon matches how markout is measured on real fills.
  const step5 = Math.round(5000 / GRID_MS);
  const pairs = [];
  for (let i = 0; i + step5 < usable.length; i++) {
    const a = usable[i];
    const b = usable[i + step5];
    if (!Number.isFinite(a.mid) || !Number.isFinite(b.mid)) continue;
    pairs.push({ edge: a.edge, fwd: ((b.mid - a.mid) / a.mid) * 1e4 });
  }
  if (pairs.length > 200) {
    const byE = [...pairs].sort((a, b) => a.edge - b.edge);
    console.log(`\n  next-5s move by edge decile   (this is the adverse selection we are paying)`);
    console.log(`    decile    edge range (bps)       mean 5s move (bps)`);
    for (let d = 0; d < 10; d++) {
      const lo = Math.floor((d * byE.length) / 10);
      const hi = Math.floor(((d + 1) * byE.length) / 10);
      const sl = byE.slice(lo, hi);
      if (!sl.length) continue;
      const m = sl.reduce((a, b) => a + b.fwd, 0) / sl.length;
      console.log(`      ${String(d + 1).padStart(2)}    ${fmt(sl[0].edge).padStart(7)} .. ${fmt(sl.at(-1).edge).padEnd(8)} ${fmt(m).padStart(9)}`);
    }

    console.log(`\n  gate simulation at 5s`);
    console.log(`    gateBps   time gated   avoided adverse move   markout on kept quotes`);
    for (const th of [0.5, 0.75, 1, 1.5, 2, 3]) {
      const warned = pairs.filter((p) => Math.abs(p.edge) >= th);
      const kept = pairs.filter((p) => Math.abs(p.edge) < th);
      if (warned.length < 30 || kept.length < 30) continue;
      // On a warned sample the exposed side is hit and loses when the move
      // agrees with the signal. Average signed loss avoided:
      const avoided = warned.reduce((a, p) => a + Math.sign(p.edge) * p.fwd, 0) / warned.length;
      // What is left: the average adverse move on quotes we still show. The
      // exposed side is whichever the residual edge leans toward.
      const residual = kept.reduce((a, p) => a + Math.sign(p.edge || 1) * p.fwd, 0) / kept.length;
      console.log(
        `    ${fmt(th, 2).padStart(5)}    ${pct(warned.length / pairs.length).padStart(7)}      ${fmt(avoided).padStart(7)} bps            ${fmt(-residual).padStart(7)} bps`,
      );
    }
  }

  // --- 4. how the index compares, for the record ---
  if (idx.length > 20) {
    const xs = [];
    const ys = [];
    for (const s of idx) {
      const a = valueAt(pm, s.ts);
      const b = valueAt(pm, s.ts + 5000);
      const bn = valueAt(bin, s.ts);
      if (!a || !b || !bn) continue;
      xs.push(((s.mid - bn.mid) / bn.mid) * 1e4);
      ys.push(((b.mid - a.mid) / a.mid) * 1e4);
    }
    const c = corr(xs, ys);
    console.log(`\n  for comparison, Polymarket's own index vs Binance: r=${fmt(c.r, 3)} against the next 5s (n=${c.n})`);
  }
}
console.log();
