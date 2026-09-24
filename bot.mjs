#!/usr/bin/env node
// volume-bot entry point.
//
//   node bot.mjs            dry run (default): real market data, simulated fills, signs nothing
//   node bot.mjs --live     live, ONLY if config.json also says "mode": "live"
//   node bot.mjs --live --smoke   one-off live smoke test (see README)
//   --config <file>         config path (default ./config.json)
//   --clear-stop            clear today's stop reason (not allowed for the daily loss stop)
//
// Stop: Ctrl+C, SIGTERM, or create control/STOP. The bot cancels its open
// orders, saves state and a summary, and exits.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createApi } from "./src/api.mjs";
import { ConfigError, loadConfig } from "./src/config.mjs";
import { EnvError, loadCredentials } from "./src/env.mjs";
import { createEngine } from "./src/engine.mjs";
import { createLiveExec } from "./src/exec/live.mjs";
import { createSimExec } from "./src/exec/sim.mjs";
import { createLogger } from "./src/log.mjs";
import { createMarketData } from "./src/marketdata.mjs";
import { createReference } from "./src/reference.mjs";
import { createReporter } from "./src/report.mjs";
import { createSigner } from "./src/signing.mjs";
import { createStateStore } from "./src/state.mjs";
import { runSmokeTest } from "./src/smoke.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const CONTROL_DIR = path.join(HERE, "control");
const STOP_FILE = path.join(CONTROL_DIR, "STOP");
const LOCK_FILE = path.join(CONTROL_DIR, ".lock");

function parseArgs(argv) {
  const a = { live: false, smoke: false, clearStop: false, config: path.join(HERE, "config.json") };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--live") a.live = true;
    else if (k === "--smoke") a.smoke = true;
    else if (k === "--clear-stop") a.clearStop = true;
    else if (k === "--config") a.config = path.resolve(argv[++i]);
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function acquireLock(log) {
  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8"));
    if (pid && pid !== process.pid && pidAlive(pid)) {
      throw new Error(`another volume-bot is already running (pid ${pid}). Only one instance may trade this account.`);
    }
    log.warn("removing stale lock file", { pid });
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, "utf8")) === process.pid) fs.rmSync(LOCK_FILE);
  } catch {}
}

function buildInstruments(cfg, instruments, fees, log, feeTier = 0) {
  const insts = new Map();
  for (const symbol of cfg.markets) {
    const i = instruments.find((x) => x.symbol === symbol);
    if (!i) throw new Error(`instrument ${symbol} not listed by /v1/info/instruments`);
    const schedule = fees.fee_schedule.find((s) => s.category === i.category) ?? fees.fee_schedule[0];
    if (schedule.category !== i.category) log.info(`fee schedule has no "${i.category}" category; using "${schedule.category}" rates for ${symbol}`);
    const tier = schedule.tiers?.[feeTier] ?? schedule;
    insts.set(i.instrument_id, {
      iid: i.instrument_id,
      symbol,
      priceDecimals: i.price_decimals,
      quantityDecimals: i.quantity_decimals,
      minNotional: Number(i.min_notional),
      maxLeverage: i.max_leverage,
      riskTiers: i.risk_tiers ?? [],
      isolatedOnly: i.isolated_only,
      makerFee: Number(tier.maker_fee_rate),
      takerFee: Number(tier.taker_fee_rate),
    });
  }
  return insts;
}

// Leverage must fit the instrument's max AND the risk tier for our largest position.
function checkLeverage(cfg, inst) {
  const lev = cfg.leverage.value;
  if (lev > inst.maxLeverage) return `${inst.symbol}: leverage ${lev}x exceeds instrument max ${inst.maxLeverage}x`;
  const maxNotional = cfg.inventory.maxNotionalUsd + cfg.quote.notionalUsd;
  const tier = [...inst.riskTiers].sort((a, b) => Number(b.lower_bound) - Number(a.lower_bound)).find((t) => maxNotional >= Number(t.lower_bound));
  if (tier && lev > tier.max_leverage) return `${inst.symbol}: leverage ${lev}x exceeds risk-tier max ${tier.max_leverage}x at $${maxNotional}`;
  if (cfg.leverage.cross && inst.isolatedOnly) return `${inst.symbol}: instrument is isolated-only`;
  return null;
}

async function confirmLive({ creds, portfolio, insts, cfg, smoke }) {
  const lines = [
    "",
    "================ LIVE TRADING CONFIRMATION ================",
    `Account (owner) : ${creds.owner}`,
    `Proxy (signer)  : ${creds.proxy}   expires ${creds.expiresAtIso}`,
    `Equity          : $${Number(portfolio?.margin?.total_account_value ?? NaN).toFixed(2)}   available $${Number(portfolio?.margin?.available_order_margin ?? NaN).toFixed(2)}   fee tier ${portfolio?.fee_tier ?? "?"}`,
    `Markets         : ${[...insts.values()].map((i) => `${i.symbol} (maker ${(i.makerFee * 1e4).toFixed(2)} bps / taker ${(i.takerFee * 1e4).toFixed(2)} bps)`).join(", ")}`,
    `Leverage        : ${cfg.leverage.value}x ${cfg.leverage.cross ? "cross" : "isolated"}`,
    `Quote size      : $${cfg.quote.notionalUsd} per side    inventory cap $${cfg.inventory.maxNotionalUsd} per market`,
    `Daily cost cap  : $${cfg.budget.dailyCostUsd} (all-in cost: fees + funding + adverse price moves)    daily loss stop -$${cfg.risk.dailyLossUsd}`,
    `Auto-cancel     : ${cfg.autoCancel.enabled ? `armed ${cfg.autoCancel.aheadSec}s ahead, re-armed every ${cfg.autoCancel.rearmSec}s` : "DISABLED"}`,
  ];
  const held = (portfolio?.positions ?? []).filter((p) => insts.has(p.instrument_id) && Number(p.size));
  if (held.length) lines.push(`Existing positions on bot markets (the bot will manage and flatten these): ${held.map((p) => `${p.symbol} ${p.size}`).join(", ")}`);
  lines.push("Open orders on bot markets will be cancelled at start.");
  if (smoke) lines.push("SMOKE TEST: one $10 post-only order 3% from mid, then cancel; then a second one left for auto-cancel.");
  lines.push("===========================================================", "");
  process.stdout.write(lines.join("\n") + "\n");
  if (!process.stdin.isTTY) throw new Error("live mode needs an interactive terminal for the confirmation prompt");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "yes" to start live trading: ')).trim();
  rl.close();
  return answer === "yes";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).join("\n").replace(/^\/\/ ?/gm, "") + "\n");
    return 0;
  }

  const cfg = loadConfig(args.config);
  const log = createLogger({ dir: LOG_DIR, level: cfg.log.level });

  let mode = "dry";
  if (args.live && cfg.mode === "live") mode = "live";
  else if (args.live) log.warn('--live given but config.mode is "dry": starting in DRY RUN. Set "mode": "live" in config.json to trade.');
  else if (cfg.mode === "live") log.warn('config.mode is "live" but --live was not given: starting in DRY RUN.');
  if (args.smoke && mode !== "live") throw new Error("--smoke needs live mode (--live and config.mode = live)");
  log.info(`volume-bot starting in ${mode.toUpperCase()} mode`, { markets: cfg.markets, pid: process.pid });

  acquireLock(log);
  if (fs.existsSync(STOP_FILE)) {
    log.warn("control/STOP exists from a previous run; removing it");
    fs.rmSync(STOP_FILE);
  }

  let creds = null;
  let signer = null;
  if (mode === "live") {
    const envFile = process.env.PERPS_ENV_FILE ?? (cfg.envFile ? path.resolve(HERE, cfg.envFile) : null);
    creds = loadCredentials(envFile);
    signer = createSigner(creds.privateKey);
    log.info("credentials loaded", { owner: creds.owner, proxy: creds.proxy, expires: creds.expiresAtIso });
  }
  const api = createApi({ log, creds, signer });
  const offset = await api.syncTime();
  log.info("clock synced with exchange", { offsetMs: offset });

  const [instruments, fees] = await Promise.all([api.instruments(), api.fees()]);
  let portfolio = null;
  if (mode === "live") portfolio = await api.portfolio();
  const insts = buildInstruments(cfg, instruments, fees, log, portfolio?.fee_tier ?? 0);
  if (mode === "dry" && cfg.sim.useFeeOverride) {
    for (const inst of insts.values()) {
      inst.makerFee = cfg.sim.makerFeeBps / 10_000;
      inst.takerFee = cfg.sim.takerFeeBps / 10_000;
    }
    log.info("dry run uses fee override from config.sim", { makerBps: cfg.sim.makerFeeBps, takerBps: cfg.sim.takerFeeBps });
  }
  for (const inst of insts.values()) {
    const problem = checkLeverage(cfg, inst);
    if (problem) throw new Error(`leverage check failed: ${problem}`);
  }

  if (mode === "live") {
    if (!(await confirmLive({ creds, portfolio, insts, cfg, smoke: args.smoke }))) {
      log.warn("live start not confirmed; exiting without placing anything");
      return 0;
    }
    log.warn("LIVE trading confirmed by operator");
    // Exchange state is the source of truth: clear our markets before trading.
    for (const iid of insts.keys()) {
      const open = await api.openOrders(iid);
      if (open?.length) log.warn(`cancelling ${open.length} open order(s) on ${insts.get(iid).symbol} found at startup`, { coids: open.map((o) => o.client_order_id) });
      await api.cancelAll(iid);
    }
    const current = await api.config();
    for (const inst of insts.values()) {
      const c = (current ?? []).find((x) => x.instrument_id === inst.iid);
      if (c && c.leverage === cfg.leverage.value && c.cross === cfg.leverage.cross) {
        log.info(`${inst.symbol} already at ${c.leverage}x ${c.cross ? "cross" : "isolated"}`);
        continue;
      }
      const { data } = await api.updateLeverage(inst.iid, cfg.leverage.value, cfg.leverage.cross);
      log.info(`${inst.symbol} leverage set`, { leverage: data?.leverage, cross: data?.cross });
    }
  }

  const store = createStateStore({ dir: LOG_DIR, mode, log });
  const state = store.load();
  if (args.clearStop && state.stop) {
    if (state.stop.reason === "daily loss stop") throw new Error("the daily loss stop cannot be cleared by flag; it resets at 00:00 UTC");
    log.warn("clearing today's stop on operator request", { was: state.stop.reason });
    state.stop = null;
  }

  const md = createMarketData({ api, iids: [...insts.keys()], log, creds });
  const exec =
    mode === "live"
      ? createLiveExec({ api, insts, log, marketdata: md })
      : createSimExec({ insts, books: md.books, cfg, log, getPosition: (iid) => state.positions[iid] ?? { size: 0 } });
  const reporter = createReporter({ dir: LOG_DIR, mode });
  // Public Binance market data only: no account, no key, nothing signed. Its
  // job is to tell us when our quote has gone stale; see src/reference.mjs.
  const reference = createReference({
    cfg,
    markets: [...insts.entries()].map(([iid, inst]) => ({ iid, symbol: inst.symbol })),
    log,
    reporter,
  });
  const engine = createEngine({ cfg, mode, insts, api, md, exec, store, state, reporter, log, creds, reference });

  md.start();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("market data did not connect within 20s")), 20_000);
    md.once("restored", () => {
      clearTimeout(t);
      resolve();
    });
  });

  let exiting = false;
  const exit = async (reason, code = 0) => {
    if (exiting) return;
    exiting = true;
    try {
      await engine.shutdown(reason);
    } catch (e) {
      log.error("shutdown error", { error: e.message });
      code = code || 1;
    }
    md.stop();
    exec.stop?.();
    if (fs.existsSync(STOP_FILE)) fs.rmSync(STOP_FILE);
    releaseLock();
    log.info("exited", { reason });
    setTimeout(() => process.exit(code), 100);
  };
  process.on("SIGINT", () => exit("Ctrl+C"));
  process.on("SIGTERM", () => exit("SIGTERM"));
  process.on("uncaughtException", (e) => {
    log.error("uncaught exception", { error: e.message, stack: e.stack?.split("\n").slice(0, 5).join(" | ") });
    exit("uncaught exception", 1);
  });
  process.on("unhandledRejection", (e) => {
    log.error("unhandled rejection", { error: e?.message ?? String(e) });
  });
  setInterval(() => fs.existsSync(STOP_FILE) && exit("control/STOP file"), 1000).unref();

  if (args.smoke) {
    await runSmokeTest({ api, insts, md, log, cfg });
    releaseLock();
    return 0;
  }

  await engine.start();
  return null; // keep running
}

main()
  .then((code) => {
    if (code !== null && code !== undefined) {
      releaseLock();
      process.exit(code);
    }
  })
  .catch((e) => {
    const msg = e instanceof ConfigError || e instanceof EnvError ? e.message : `${e.message}`;
    process.stderr.write(`\nvolume-bot failed to start:\n${msg}\n`);
    releaseLock();
    process.exit(1);
  });
