// CSV reports in logs/: fills.csv, quotes.csv (every row carries `mode`) and
// summary.csv (every summaryEveryMin and on exit). Cost components are kept
// separate; see README "Cost metrics".
//
// reference.csv is written only when config.reference.mode is not "off": one
// row a second per instrument recording what the external reference said at
// that moment, so tools/markout.mjs can bucket markout by the signal and show
// whether it actually predicts being picked off.

import fs from "node:fs";
import path from "node:path";
import { REF_COLUMNS } from "./reference.mjs";
import { costUsed, netPnl } from "./risk.mjs";

export const FILL_COLUMNS = [
  "ts", "mode", "symbol", "iid", "side", "price", "qty", "notional", "liquidity", "fee", "intent",
  "decision_mid", "slippage_usd", "slippage_bps", "position_after", "realized_pnl", "trade_id", "coid",
  "level", "order_age_ms", "fair_at_place", "edge_vs_fair_bps",
];
export const QUOTE_COLUMNS = ["ts", "mode", "symbol", "iid", "action", "side", "price", "qty", "intent", "reason", "coid"];
export const SUMMARY_COLUMNS = [
  "ts", "mode", "day", "gross_volume", "maker_volume", "taker_volume", "fills",
  "maker_fees", "taker_fees", "funding", "slippage", "inventory_drift", "trading_pnl", "net_cost",
  "cost_per_$1", "cost_per_$1M_volume", "net_pnl", "budget_used", "budget_limit",
  "margin_used", "max_drawdown", "flattens", "avg_flatten_slippage_bps", "min_liq_distance_pct",
  "projected_days_to_$1M_tier", "projected_cost_to_$1M_tier", "stop_reason",
];

const TIER_VOLUME = 1_000_000;

function csvCell(v) {
  if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "";
  const s = typeof v === "number" ? String(Math.round(v * 1e8) / 1e8) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A file written with a different set of columns is moved aside before the
// first new row. Appending rows of a new width under the old header would be
// silently dropped by every reader (they skip rows that don't match it).
export function rollIfHeaderChanged(file, columns) {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, "r");
  let head;
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, n).toString("utf8").split("\n")[0].replace(/\r$/, "");
  } finally {
    fs.closeSync(fd);
  }
  if (head === columns.join(",")) return null;
  const moved = file.replace(/\.csv$/, "") + `.pre-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  fs.renameSync(file, moved);
  return moved;
}

function appender(file, columns) {
  let checked = false;
  return (row) => {
    if (!checked) {
      checked = true;
      rollIfHeaderChanged(file, columns);
    }
    const exists = fs.existsSync(file);
    const line = columns.map((c) => csvCell(row[c])).join(",") + "\n";
    fs.appendFileSync(file, exists ? line : columns.join(",") + "\n" + line);
  };
}

/**
 * Pure summary computation.
 *   trading_pnl     = realized + unrealized (marked to mid)
 *   slippage        = sum over fills of (fill - decision mid) signed against us
 *   inventory_drift = trading_pnl + slippage  (what the position did after the fill)
 *   net_cost        = fees + funding - trading_pnl = -(net P&L)
 */
export function computeSummary(daily, { now, mode, marginUsed, minLiqDistancePct, budgetLimit, stopReason }) {
  const fees = daily.makerFees + daily.takerFees;
  const tradingPnl = daily.realized + daily.unrealized;
  const netCost = fees + daily.funding - tradingPnl;
  const vol = daily.grossVolume;
  const perDollar = vol > 0 ? netCost / vol : null;
  const elapsedDays = daily.firstActivityAt != null ? Math.max((now - daily.firstActivityAt) / 86_400_000, 1 / 1440) : null;
  const dailyRate = elapsedDays && vol > 0 ? vol / elapsedDays : null;
  const days = dailyRate ? TIER_VOLUME / dailyRate : null;

  return {
    ts: new Date(now).toISOString(),
    mode,
    day: daily.day,
    gross_volume: vol,
    maker_volume: daily.makerVolume,
    taker_volume: daily.takerVolume,
    fills: daily.fills,
    maker_fees: daily.makerFees,
    taker_fees: daily.takerFees,
    funding: daily.funding,
    slippage: daily.slippage,
    inventory_drift: tradingPnl + daily.slippage,
    trading_pnl: tradingPnl,
    net_cost: netCost,
    "cost_per_$1": perDollar,
    "cost_per_$1M_volume": perDollar === null ? null : perDollar * 1e6,
    net_pnl: netPnl(daily),
    budget_used: costUsed(daily),
    budget_limit: budgetLimit,
    margin_used: marginUsed,
    max_drawdown: daily.maxDrawdown,
    flattens: daily.flattens,
    avg_flatten_slippage_bps: daily.flattenSlipCount ? daily.flattenSlipBpsSum / daily.flattenSlipCount : null,
    min_liq_distance_pct: Number.isFinite(minLiqDistancePct) ? minLiqDistancePct : null,
    "projected_days_to_$1M_tier": days,
    "projected_cost_to_$1M_tier": perDollar === null ? null : perDollar * TIER_VOLUME,
    stop_reason: stopReason ?? "",
  };
}

export function createReporter({ dir, mode }) {
  fs.mkdirSync(dir, { recursive: true });
  const fills = appender(path.join(dir, "fills.csv"), FILL_COLUMNS);
  const quotes = appender(path.join(dir, "quotes.csv"), QUOTE_COLUMNS);
  const summary = appender(path.join(dir, "summary.csv"), SUMMARY_COLUMNS);
  const reference = appender(path.join(dir, "reference.csv"), REF_COLUMNS);
  const ts = () => new Date().toISOString();
  return {
    fill: (row) => fills({ ts: ts(), mode, ...row }),
    quote: (row) => quotes({ ts: ts(), mode, ...row }),
    summary: (row) => summary({ ...row, mode }),
    reference: (row) => reference(row),
  };
}

export function formatSummary(s) {
  const f = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
  return [
    `[${s.mode}] ${s.day}  volume $${f(s.gross_volume, 2)} (${s.fills} fills; maker $${f(s.maker_volume, 2)} / taker $${f(s.taker_volume, 2)})`,
    `  cost per $1: ${f(s["cost_per_$1"], 6)}  (= $${f(s["cost_per_$1M_volume"], 2)} per $1M)   net cost $${f(s.net_cost)}   net P&L $${f(s.net_pnl)}`,
    `  maker fees $${f(s.maker_fees)}  taker fees $${f(s.taker_fees)}  funding $${f(s.funding)}  slippage $${f(s.slippage)}  inventory drift $${f(s.inventory_drift)}`,
    `  budget $${f(s.budget_used)}/$${f(s.budget_limit, 2)}  margin $${f(s.margin_used, 2)}  max DD $${f(s.max_drawdown)}  flattens ${s.flattens} (avg slip ${f(s.avg_flatten_slippage_bps, 2)} bps)  min liq dist ${f(s.min_liq_distance_pct, 1)}%`,
    `  $1M tier: ~${f(s["projected_days_to_$1M_tier"], 1)} days at this pace, ~$${f(s["projected_cost_to_$1M_tier"], 2)} total cost${s.stop_reason ? `   STOPPED: ${s.stop_reason}` : ""}`,
  ].join("\n");
}
