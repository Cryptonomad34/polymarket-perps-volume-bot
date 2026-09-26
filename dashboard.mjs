#!/usr/bin/env node
// Read-only performance dashboard for volume-bot.
//
//   node dashboard.mjs                 -> http://localhost:5174 (mode from config.json)
//   node dashboard.mjs --mode dry      force dry or live data
//   node dashboard.mjs --logs <dir>    read another logs folder (e.g. runs/run2-filters-on-25min)
//   node dashboard.mjs --port 5174
//
// It never places, cancels or signs anything. It reads the bot's files in
// logs/ (state, fills, quotes, summaries) and, in live mode, read-only account
// endpoints (portfolio, open orders) with the proxy credentials.
// Listens on 127.0.0.1 only; secrets are never sent to the browser.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./src/api.mjs";
import { loadConfig } from "./src/config.mjs";
import { loadCredentials, resolveCredentialsFile } from "./src/env.mjs";
import { computeSummary } from "./src/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { port: 5174, logs: path.join(HERE, "logs"), mode: null, config: path.join(HERE, "config.json") };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--port") a.port = Number(argv[++i]);
    else if (k === "--logs") a.logs = path.resolve(argv[++i]);
    else if (k === "--mode") a.mode = argv[++i];
    else if (k === "--config") a.config = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${k}`);
  }
  if (a.mode && !["dry", "live"].includes(a.mode)) throw new Error('--mode must be "dry" or "live"');
  return a;
}

// ---------- CSV (cached by mtime/size) ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [head, ...body] = rows;
  return head ? body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]]))) : [];
}

// quotes.csv grows by megabytes a day and only its last few minutes are ever
// used, so it is read from the end instead of being parsed in full each poll.
function readCsvTail(file, maxBytes = 1_000_000) {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  if (size <= maxBytes) return parseCsv(fs.readFileSync(file, "utf8"));
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, Math.min(4096, size), 0);
    const header = head.toString("utf8").split("\n")[0];
    const tail = Buffer.alloc(maxBytes);
    fs.readSync(fd, tail, 0, maxBytes, size - maxBytes);
    // The first line of the tail is almost certainly cut in half: drop it.
    const body = tail.toString("utf8").split("\n").slice(1).join("\n");
    return parseCsv(`${header}\n${body}`);
  } finally {
    fs.closeSync(fd);
  }
}

const csvCache = new Map();
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const st = fs.statSync(file);
  const hit = csvCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows;
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  csvCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rows });
  return rows;
}

const n = (x) => (x === "" || x === undefined || x === null ? null : Number(x));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function botProcess(logsDir) {
  const lock = path.join(logsDir, "..", "control", ".lock");
  if (!fs.existsSync(lock)) return { running: false };
  const pid = Number(fs.readFileSync(lock, "utf8"));
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (e) {
    return { running: e.code === "EPERM", pid };
  }
}

// Last error/warning lines from today's log file.
function recentAlerts(logsDir, limit = 8) {
  if (!fs.existsSync(logsDir)) return [];
  const files = fs.readdirSync(logsDir).filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  const last = files.at(-1);
  if (!last) return [];
  const file = path.join(logsDir, last);
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  const len = Math.min(size, 400_000);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const out = [];
  for (const line of buf.toString("utf8").split("\n").reverse()) {
    if (!line.includes('"level":"warn"') && !line.includes('"level":"error"')) continue;
    try {
      const r = JSON.parse(line);
      out.push({ ts: r.ts, level: r.level, msg: String(r.msg).split("\n")[0] });
    } catch {}
    if (out.length >= limit) break;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.config);
  const mode = args.mode ?? cfg.mode ?? "live";

  let creds = null;
  if (mode === "live") {
    const envFile = resolveCredentialsFile({ envVar: process.env.PERPS_ENV_FILE, cfgEnvFile: cfg.envFile, baseDir: HERE, now: 0 });
    try {
      creds = loadCredentials(envFile, { requireHoursLeft: 0 });
    } catch (e) {
      console.warn(`live account data unavailable: ${e.message}`);
    }
  }
  const api = createApi({ log: { info() {}, warn() {}, error() {}, debug() {} }, creds, timeoutMs: 6000 });

  const instruments = await api.instruments();
  const insts = cfg.markets.map((sym) => instruments.find((i) => i.symbol === sym)).filter(Boolean);
  const iids = insts.map((i) => i.instrument_id);
  const symOf = Object.fromEntries(insts.map((i) => [i.instrument_id, i.symbol]));

  // Exchange reads are cached briefly so several open tabs don't multiply requests.
  let exCache = { at: 0, data: null };
  async function exchangeData() {
    if (Date.now() - exCache.at < 5000 && exCache.data) return exCache.data;
    const out = { bbo: {}, account: null, openOrders: null, error: null };
    try {
      const bbo = await api.bbo();
      for (const b of bbo) if (iids.includes(b.instrument_id)) out.bbo[b.instrument_id] = { bid: n(b.bid_price), ask: n(b.ask_price), bidQty: n(b.bid_quantity), askQty: n(b.ask_quantity) };
      if (creds) {
        const [pf, ...open] = await Promise.all([api.portfolio(), ...iids.map((iid) => api.openOrders(iid))]);
        out.account = {
          owner: creds.owner,
          proxy: creds.proxy,
          proxyExpires: creds.expiresAtIso,
          equity: n(pf?.margin?.total_account_value),
          available: n(pf?.margin?.available_order_margin),
          marginUsed: n(pf?.margin?.total_initial_margin),
          withdrawable: n(pf?.withdrawable),
          feeTier: pf?.fee_tier,
          inLiquidation: Boolean(pf?.in_liquidation),
          positions: (pf?.positions ?? [])
            .filter((p) => iids.includes(p.instrument_id))
            .map((p) => ({ iid: p.instrument_id, symbol: symOf[p.instrument_id], size: n(p.size), entry: n(p.entry_price), liq: n(p.liquidation_price), upnl: n(p.unrealized_pnl), funding: n(p.cumulative_funding), leverage: p.leverage })),
        };
        out.openOrders = open.flat().filter(Boolean).map((o) => ({ iid: o.instrument_id, symbol: symOf[o.instrument_id], side: o.buy ? "buy" : "sell", price: n(o.price), qty: n(o.resting_quantity ?? o.quantity), coid: o.client_order_id, ro: o.ro }));
      }
    } catch (e) {
      out.error = e.message;
    }
    exCache = { at: Date.now(), data: out };
    return out;
  }

  async function data() {
    const state = readJson(path.join(args.logs, `state-${mode}.json`));
    const fills = readCsv(path.join(args.logs, "fills.csv")).filter((r) => r.mode === mode);
    const quotes = readCsvTail(path.join(args.logs, "quotes.csv")).filter((r) => r.mode === mode);
    const summaries = readCsv(path.join(args.logs, "summary.csv")).filter((r) => r.mode === mode);
    const ex = await exchangeData();

    // Cumulative realized P&L net of fees, fill by fill.
    let cum = 0;
    let volume = 0;
    const curve = fills.map((f) => {
      cum += (n(f.realized_pnl) ?? 0) - (n(f.fee) ?? 0);
      volume += n(f.notional) ?? 0;
      return [Date.parse(f.ts), cum];
    });
    const step = Math.max(1, Math.floor(curve.length / 400));
    const curveThin = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);

    // Lifetime: exact volume/fees/realized from fills.csv, and per-day cost
    // from the last summary row of each past day plus today from state.
    const byDay = new Map();
    for (const s of summaries) {
      const day = s.day || String(s.ts).slice(0, 10);
      const prev = byDay.get(day);
      if (!prev || Date.parse(s.ts) >= Date.parse(prev.ts)) byDay.set(day, s);
    }
    if (state?.daily?.day) byDay.delete(state.daily.day); // today comes from live state below
    const past = [...byDay.values()];
    const lifetime = {
      days: past.length + (state?.daily?.grossVolume > 0 ? 1 : 0),
      volume: past.reduce((a, s) => a + (n(s.gross_volume) ?? 0), 0) + (state?.daily?.grossVolume ?? 0),
      netCost: past.reduce((a, s) => a + (n(s.net_cost) ?? 0), 0),
      netPnl: past.reduce((a, s) => a + (n(s.net_pnl) ?? 0), 0),
      makerFees: past.reduce((a, s) => a + (n(s.maker_fees) ?? 0), 0) + (state?.daily?.makerFees ?? 0),
      takerFees: past.reduce((a, s) => a + (n(s.taker_fees) ?? 0), 0) + (state?.daily?.takerFees ?? 0),
      funding: past.reduce((a, s) => a + (n(s.funding) ?? 0), 0) + (state?.daily?.funding ?? 0),
      fills: fills.length,
      firstDay: past.length ? past.map((s) => s.day).sort()[0] : (state?.daily?.day ?? null),
    };

    const today = state?.daily ?? null;
    const summary = today
      ? computeSummary(today, {
          now: Date.now(),
          mode,
          marginUsed: ex.account?.marginUsed ?? NaN,
          minLiqDistancePct: NaN,
          budgetLimit: cfg.budget.dailyCostUsd,
          stopReason: state?.stop?.reason,
        })
      : null;

    // Quote activity in the last 15 minutes.
    const since = Date.now() - 15 * 60_000;
    const recentQ = quotes.filter((q) => Date.parse(q.ts) >= since);
    const backoffs = {};
    for (const q of recentQ) if (q.action === "place" && q.reason?.startsWith("back off")) backoffs[q.reason.slice(10)] = (backoffs[q.reason.slice(10)] ?? 0) + 1;

    const openOrders =
      ex.openOrders ??
      (state?.openOrders ?? []).filter((o) => o.status !== "done").map((o) => ({ iid: o.iid, symbol: symOf[o.iid], side: o.side, price: o.price, qty: o.qty - (o.filled ?? 0), coid: o.coid, ro: o.intent?.startsWith("flatten") }));

    const positions =
      ex.account?.positions ??
      Object.entries(state?.positions ?? {})
        .filter(([, p]) => p.size)
        .map(([iid, p]) => {
          const b = ex.bbo[iid];
          const mid = b ? (b.bid + b.ask) / 2 : null;
          return { iid: Number(iid), symbol: symOf[iid], size: p.size, entry: p.entryPrice, upnl: mid ? (mid - p.entryPrice) * p.size : null, liq: null };
        });

    return {
      now: Date.now(),
      mode,
      logsDir: args.logs,
      bot: { ...botProcess(args.logs), stateUpdatedAt: state?.updatedAt ?? null, stop: state?.stop ?? null, disconnectsToday: state?.disconnectsToday ?? 0 },
      config: {
        markets: cfg.markets,
        leverage: cfg.leverage,
        quoteUsd: cfg.quote.notionalUsd,
        capUsd: cfg.inventory.maxNotionalUsd,
        dailyLossUsd: cfg.risk.dailyLossUsd,
        dailyCostUsd: cfg.budget.dailyCostUsd,
        adverse: cfg.quote.adverse.enabled,
      },
      account: ex.account ? { ...ex.account, equityAtDayStart: state?.daily?.equityAtDayStart ?? null, equityBaselineAt: state?.daily?.equityBaselineAt ?? null } : null,
      exchangeError: ex.error,
      bbo: Object.fromEntries(Object.entries(ex.bbo).map(([iid, b]) => [symOf[iid], b])),
      today: summary,
      lifetime: {
        ...lifetime,
        netCost: lifetime.netCost + (summary?.net_cost ?? 0),
        netPnl: lifetime.netPnl + (summary?.net_pnl ?? 0),
        costPer1M: lifetime.volume > 0 ? ((lifetime.netCost + (summary?.net_cost ?? 0)) / lifetime.volume) * 1e6 : null,
      },
      depositedUsd: cfg.depositedUsd ?? null,
      allTime: {
        fills: fills.length,
        volume,
        maker: fills.filter((f) => f.liquidity === "maker").length,
        taker: fills.filter((f) => f.liquidity === "taker").length,
        netRealized: cum,
        fees: fills.reduce((a, f) => a + (n(f.fee) ?? 0), 0),
        firstTs: fills[0]?.ts ?? null,
      },
      curve: curveThin,
      summaries: summaries.slice(-48).map((s) => ({ ts: s.ts, volume: n(s.gross_volume), netPnl: n(s.net_pnl), costPer1M: n(s["cost_per_$1M_volume"]) })),
      openOrders,
      positions,
      recentFills: fills.slice(-40).reverse().map((f) => ({ ts: f.ts, symbol: f.symbol, side: f.side, qty: n(f.qty), price: n(f.price), liquidity: f.liquidity, intent: f.intent, fee: n(f.fee), pnl: n(f.realized_pnl), slipBps: n(f.slippage_bps) })),
      activity: { places15m: recentQ.filter((q) => q.action === "place").length, cancels15m: recentQ.filter((q) => q.action === "cancel").length, rejects15m: recentQ.filter((q) => q.action === "reject").length, backoffs },
      alerts: recentAlerts(args.logs),
    };
  }

  const page = () => fs.readFileSync(path.join(HERE, "dashboard", "index.html"));
  const allowedHosts = new Set([`127.0.0.1:${args.port}`, `localhost:${args.port}`]);

  const server = http.createServer(async (req, res) => {
    if (!allowedHosts.has(req.headers.host) || req.method !== "GET") {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
          "cache-control": "no-store",
        });
        res.end(page());
      } else if (url.pathname === "/api/data") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(await data()));
      } else res.writeHead(404).end("Not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(args.port, "127.0.0.1", () => {
    console.log(`volume-bot dashboard (${mode} data, ${args.logs}) -> http://localhost:${args.port}`);
    console.log("Read-only: places nothing, signs nothing. Ctrl+C to stop.");
  });
}

main().catch((e) => {
  console.error(`dashboard failed to start: ${e.message}`);
  process.exit(1);
});
