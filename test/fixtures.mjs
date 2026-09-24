import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../src/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rawConfig = () => JSON.parse(fs.readFileSync(path.join(here, "..", "config.example.json"), "utf8"));

// The tuning knobs in config.example.json change as the bot is tuned. Tests
// assert behaviour, not tuning, so they run against fixed values; a test that
// cares about a knob overrides it itself.
const TEST_TUNING = {
  quote: { debounceMs: 300, minReplaceMs: 250, maxPlacesPerMinute: 300 },
  // The adverse filters are off in the live config (measured: backing off a
  // tick does not reduce toxicity) but the tests still cover the behaviour.
  adverse: { enabled: true },
  inventory: { maxNotionalUsd: 80, skewAtUsd: 80 }, // skew off unless a test asks for it
  flatten: { maxPositionAgeSec: 60, passiveSec: 15, extendSec: 10, maxHoldSec: 120 },
};

export const testConfig = (over = {}) => {
  const raw = rawConfig();
  const merged = { ...raw };
  for (const [section, values] of Object.entries(TEST_TUNING)) {
    if (section === "adverse") merged.quote = { ...merged.quote, adverse: { ...raw.quote.adverse, ...values } };
    else merged[section] = { ...raw[section], ...values };
  }
  for (const [section, values] of Object.entries(over)) merged[section] = { ...merged[section], ...values };
  return validateConfig(merged);
};

export const cfg = testConfig();

export const BTC = { iid: 6, symbol: "BTC-USD", priceDecimals: 1, quantityDecimals: 5, minNotional: 10, maxLeverage: 50, makerFee: 0.000125, takerFee: 0.0004 };
export const ETH = { iid: 7, symbol: "ETH-USD", priceDecimals: 2, quantityDecimals: 4, minNotional: 10, maxLeverage: 50, makerFee: 0.000125, takerFee: 0.0004 };
