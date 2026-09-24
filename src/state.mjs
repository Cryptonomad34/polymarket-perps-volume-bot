// Persists what the bot last believed to logs/state-<mode>.json after every
// material change (atomic write: temp file + rename), so a crash or restart
// keeps today's budget usage, P&L components, coid nonce and stop reason.
// In live mode the exchange is still re-synced as the source of truth.
//
// Never stores secrets or signatures: save() refuses any key that looks like one.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FORBIDDEN = /(secret|private|signature|^sig$|preimage)/i;
const VERSION = 1;

export function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function emptyDaily(day) {
  return {
    day,
    grossVolume: 0,
    makerVolume: 0,
    takerVolume: 0,
    fills: 0,
    makerFees: 0,
    takerFees: 0,
    funding: 0,
    slippage: 0,
    realized: 0,
    unrealized: 0,
    unrealizedAtDayStart: null,
    equityAtDayStart: null, // live: account equity at the first reconcile of the UTC day
    equityBaselineAt: null,
    peakPnl: 0,
    maxDrawdown: 0,
    flattens: 0,
    flattenSlipBpsSum: 0,
    flattenSlipCount: 0,
    firstActivityAt: null,
  };
}

export function freshState(mode, now = Date.now()) {
  return {
    version: VERSION,
    mode,
    sessionId: crypto.randomBytes(8).toString("hex"),
    coidNonce: 0,
    daily: emptyDaily(utcDay(now)),
    disconnectsToday: 0,
    stop: null,
    positions: {}, // iid -> { size, entryPrice, openedAt }   (dry: authoritative; live: overwritten by exchange)
    openOrders: [], // snapshot for the log/recovery; live re-syncs from the exchange
    seenTradeIds: [],
    seenFundingIds: [],
    updatedAt: now,
  };
}

function assertNoSecrets(obj, where = "state") {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN.test(k)) throw new Error(`refusing to persist ${where}.${k}: looks like a secret`);
    assertNoSecrets(v, `${where}.${k}`);
  }
}

export function createStateStore({ dir, mode, log }) {
  const file = path.join(dir, `state-${mode}.json`);
  const tmp = `${file}.tmp`;

  function load(now = Date.now()) {
    if (!fs.existsSync(file)) {
      log.info("state: no previous state, starting fresh", { file });
      return freshState(mode, now);
    }
    let s;
    try {
      s = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      const bad = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, bad);
      log.error("state: file unreadable, moved aside and starting fresh", { moved: bad, error: e.message });
      return freshState(mode, now);
    }
    if (s.version !== VERSION || s.mode !== mode) {
      log.warn("state: incompatible state file, starting fresh", { version: s.version, mode: s.mode });
      return freshState(mode, now);
    }
    const today = utcDay(now);
    if (s.daily?.day !== today) {
      log.info("state: previous state is from another UTC day; daily counters reset", { was: s.daily?.day, today });
      s.daily = emptyDaily(today);
      s.disconnectsToday = 0;
      s.stop = null;
    }
    // Never reuse a coid: jump the nonce well past anything that may have been
    // sent after the last save.
    s.coidNonce = (s.coidNonce ?? 0) + 1000;
    log.info("state: restored", { day: s.daily.day, coidNonce: s.coidNonce, stop: s.stop?.reason ?? null, positions: s.positions });
    return s;
  }

  function save(state) {
    state.updatedAt = Date.now();
    state.seenTradeIds = state.seenTradeIds.slice(-2000);
    state.seenFundingIds = state.seenFundingIds.slice(-500);
    assertNoSecrets(state);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, file);
  }

  return { file, load, save };
}
