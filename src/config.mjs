// Schema validation for config.json. Fails fast with a specific message
// instead of letting a bad value crash deep inside the strategy.

import fs from "node:fs";

const num = (min, max, { int = false } = {}) => ({ type: "number", min, max, int });
const bool = () => ({ type: "boolean" });
const oneOf = (...values) => ({ type: "enum", values });
// A whole section that may be left out of config.json (older configs keep
// loading); when present, every field in it is checked as usual.
const optionalSection = (fields) => ({ type: "section", fields, optional: true });
const REFERENCE_VENUES = ["binance", "bybit", "okx"];

// Every field is required; config.example.json documents each one.
export const SCHEMA = {
  mode: oneOf("dry", "live"),
  depositedUsd: { ...num(0, 10_000_000), optional: true }, // what you funded the Perps account with; dashboard only
  markets: { type: "markets" },
  envFile: { type: "string", optional: true },
  quote: {
    notionalUsd: num(10, 40),
    debounceMs: num(0, 10_000, { int: true }),
    minReplaceMs: num(50, 60_000, { int: true }),
    maxPlacesPerMinute: num(1, 2_000, { int: true }),
    adverse: {
      enabled: bool(),
      minQueueUsd: num(0, 1_000_000),
      imbalance: num(0.5, 1),
      flowWindowMs: num(500, 60_000, { int: true }),
      flowRatio: num(0.5, 1),
      minFlowUsd: num(0, 1_000_000),
      inventoryBackoff: bool(),
      backoffTicks: num(1, 10, { int: true }),
      holdMs: num(0, 60_000, { int: true }),
    },
  },
  // External reference price (Binance USD-M futures, public data, no account).
  // See src/reference.mjs. "observe" measures the signal without acting on it.
  reference: {
    mode: oneOf("off", "observe", "gate"),
    basisHalfLifeSec: num(10, 3_600),
    warmupSec: num(10, 3_600),
    staleMs: num(200, 60_000, { int: true }),
    gateBps: num(0.1, 50),
    // Which external venues feed the reference. Default ["binance"]. With
    // several, the signal is the median across the fresh ones.
    venues: { type: "venues", optional: true },
  },
  // "join" (default): join the best bid/ask (src/strategy.mjs).
  // "fair": quote a resting ladder around a fair value (src/ladder.mjs).
  strategy: optionalSection({
    mode: oneOf("join", "fair"),
  }),
  // Settings for strategy.mode "fair". All distances are bps of fair value.
  fair: optionalSection({
    edgeBps: num(0.1, 50), // level 0 sits this far from fair value
    levels: num(1, 5, { int: true }), // resting orders per side
    levelStepBps: num(0.1, 50), // extra distance for each deeper level
    cancelEdgeBps: num(0, 50), // pull an order once fair value is this close to it
    maxDistanceBps: num(1, 200), // pull an order this far from fair value (it has no chance)
    imbalanceWeight: num(0, 1), // share of the microprice-vs-mid gap added to fair value
    skewBps: num(0, 50), // fair value shift at a full inventory.maxNotionalUsd position
    maxDeviationBps: num(1, 200), // distrust a fair value this far from Polymarket's mid
  }),
  inventory: {
    maxNotionalUsd: num(10, 80),
    // Above this, the side that would grow the position stops quoting and the
    // reducing side works the whole position off at the best price (maker).
    skewAtUsd: num(10, 80),
  },
  flatten: {
    maxPositionAgeSec: num(5, 600),
    passiveSec: num(1, 120),
    extendSec: num(0, 120),
    maxHoldSec: num(10, 300),
    iocSlippageBps: num(0.5, 50),
    iocRetryMs: num(250, 30_000, { int: true }),
    liqDistancePct: num(1, 50),
  },
  budget: {
    dailyCostUsd: num(0.01, 1_000),
  },
  risk: {
    dailyLossUsd: num(0.01, 1_000),
    maxConsecutiveErrors: num(1, 20, { int: true }),
    staleMs: num(1_000, 60_000, { int: true }),
    staleGraceSec: num(1, 300),
    reconnectGraceSec: num(1, 300),
    maxDisconnectsPerDay: num(0, 100, { int: true }),
  },
  leverage: {
    value: num(1, 50, { int: true }),
    cross: bool(),
  },
  autoCancel: {
    enabled: bool(),
    aheadSec: num(5, 60),
    rearmSec: num(1, 30),
    pollSec: num(10, 600),
  },
  sim: {
    latencyMs: num(0, 5_000, { int: true }),
    startingEquityUsd: num(10, 1_000_000),
    // Dry run only: use these rates instead of the published fee schedule
    // (e.g. the rates your live fills actually show). Negative = rebate.
    useFeeOverride: bool(),
    makerFeeBps: num(-10, 10),
    takerFeeBps: num(-10, 20),
  },
  report: {
    summaryEveryMin: num(1, 1_440),
  },
  log: {
    level: oneOf("debug", "info", "warn", "error"),
  },
};

// Markets the bot has been checked against: tick/quantity rounding verified
// against /v1/info/instruments, leverage cap at or above config.leverage.value,
// and a Binance futures symbol in src/reference.mjs so the reference price
// works. Listing one here permits it; `markets` in config.json selects it.
//
// BTC-USD and ETH-USD are the tightest books on the venue (rank 78 and 84 of
// 89 by earn/volatility) and lose money by construction. BNB-USD quotes ~5 bps
// against similar volatility and trades more often - see tools/venue-scan.mjs.
const ALLOWED_MARKETS = ["BTC-USD", "ETH-USD", "BNB-USD"];

function check(schema, value, where, errors) {
  if (schema.type === undefined) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${where} must be an object`);
      return;
    }
    for (const key of Object.keys(value)) {
      if (!(key in schema)) errors.push(`${where}.${key} is not a known setting`);
    }
    for (const [key, sub] of Object.entries(schema)) {
      const v = value[key];
      if (v === undefined) {
        if (!sub.optional) errors.push(`${where}.${key} is missing`);
        continue;
      }
      check(sub, v, `${where}.${key}`, errors);
    }
    return;
  }
  switch (schema.type) {
    case "section":
      check(schema.fields, value, where, errors);
      break;
    case "venues":
      if (!Array.isArray(value) || value.length === 0) errors.push(`${where} must be a non-empty list`);
      else for (const v of value) if (!REFERENCE_VENUES.includes(v)) errors.push(`${where} contains "${v}"; only ${REFERENCE_VENUES.join(", ")} are supported`);
      if (Array.isArray(value) && new Set(value).size !== value.length) errors.push(`${where} contains duplicates`);
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${where} must be a number (got ${JSON.stringify(value)})`);
      else if (schema.int && !Number.isInteger(value)) errors.push(`${where} must be a whole number (got ${value})`);
      else if (value < schema.min) errors.push(`${where} must be ≥ ${schema.min} (got ${value})`);
      else if (value > schema.max) errors.push(`${where} must be ≤ ${schema.max} (got ${value})`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${where} must be true or false (got ${JSON.stringify(value)})`);
      break;
    case "string":
      if (typeof value !== "string" || !value) errors.push(`${where} must be a non-empty string`);
      break;
    case "enum":
      if (!schema.values.includes(value)) errors.push(`${where} must be one of ${schema.values.map((v) => `"${v}"`).join(", ")} (got ${JSON.stringify(value)})`);
      break;
    case "markets":
      if (!Array.isArray(value) || value.length === 0) errors.push(`${where} must be a non-empty list`);
      else
        for (const m of value)
          if (!ALLOWED_MARKETS.includes(m)) errors.push(`${where} contains "${m}"; only ${ALLOWED_MARKETS.join(", ")} are supported`);
      if (Array.isArray(value) && new Set(value).size !== value.length) errors.push(`${where} contains duplicates`);
      break;
  }
}

// Cross-field rules that a per-field range can't express.
function crossChecks(c, errors) {
  if (c.flatten?.maxHoldSec < c.flatten?.passiveSec + c.flatten?.extendSec)
    errors.push(`config.flatten.maxHoldSec (${c.flatten.maxHoldSec}) must be ≥ passiveSec + extendSec (${c.flatten.passiveSec + c.flatten.extendSec})`);
  if (c.autoCancel?.rearmSec >= c.autoCancel?.aheadSec)
    errors.push(`config.autoCancel.rearmSec (${c.autoCancel.rearmSec}) must be < aheadSec (${c.autoCancel.aheadSec}) or the switch fires between re-arms`);
  if (c.quote?.notionalUsd > c.inventory?.maxNotionalUsd)
    errors.push(`config.quote.notionalUsd (${c.quote.notionalUsd}) must be ≤ inventory.maxNotionalUsd (${c.inventory.maxNotionalUsd})`);
  if (c.reference?.mode !== "off" && c.reference?.warmupSec * 1000 < c.reference?.staleMs)
    errors.push(`config.reference.warmupSec (${c.reference.warmupSec}s) must exceed staleMs (${c.reference.staleMs}ms) or the feed is judged warm before it is judged live`);
  if (c.strategy?.mode === "fair") {
    if (!c.fair) errors.push(`config.fair is missing; strategy.mode "fair" needs it (see config.example.json)`);
    if (c.reference?.mode !== "gate") errors.push(`strategy.mode "fair" prices every order from the reference, so config.reference.mode must be "gate" (got "${c.reference?.mode}")`);
  }
  if (c.fair && c.fair.cancelEdgeBps >= c.fair.edgeBps)
    errors.push(`config.fair.cancelEdgeBps (${c.fair.cancelEdgeBps}) must be < edgeBps (${c.fair.edgeBps}), or a freshly placed order is already "unsafe" and gets pulled at once`);
  if (c.fair && c.fair.maxDistanceBps <= c.fair.edgeBps + (c.fair.levels - 1) * c.fair.levelStepBps)
    errors.push(`config.fair.maxDistanceBps (${c.fair.maxDistanceBps}) must exceed the deepest level (edgeBps + (levels-1) x levelStepBps = ${c.fair.edgeBps + (c.fair.levels - 1) * c.fair.levelStepBps}), or deep orders are pulled as soon as they are placed`);
  if (c.inventory?.skewAtUsd > c.inventory?.maxNotionalUsd)
    errors.push(`config.inventory.skewAtUsd (${c.inventory.skewAtUsd}) must be ≤ maxNotionalUsd (${c.inventory.maxNotionalUsd}) or the skew never engages before the cap`);
}

export class ConfigError extends Error {
  constructor(errors) {
    super(`Invalid config:\n  - ${errors.join("\n  - ")}`);
    this.errors = errors;
  }
}

export function validateConfig(raw) {
  const errors = [];
  check(SCHEMA, raw, "config", errors);
  if (!errors.length) crossChecks(raw, errors);
  if (errors.length) throw new ConfigError(errors);
  return deepFreeze(structuredClone(raw));
}

export function loadConfig(file) {
  if (!fs.existsSync(file)) {
    throw new ConfigError([`${file} not found. Copy config.example.json to config.json and edit it.`]);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError([`${file} is not valid JSON: ${e.message}`]);
  }
  return validateConfig(raw);
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}
