// Loads the proxy credentials created by `npm run setup` (setup/server.mjs). The returned object
// hides the private key and secret from JSON.stringify, util.inspect and
// string conversion, so an accidental log line can't leak them.

import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const DAY_MS = 24 * 60 * 60 * 1000;

export class EnvError extends Error {}

export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// Which credentials file to use: PERPS_ENV_FILE, then config.envFile, then the
// newest unexpired credentials/proxy-0x....env written by `npm run setup`.
export function resolveCredentialsFile({ envVar, cfgEnvFile, baseDir, now = Date.now() }) {
  if (envVar) return envVar;
  if (cfgEnvFile) return path.resolve(baseDir, cfgEnvFile);
  const dir = path.join(baseDir, "credentials");
  if (!fs.existsSync(dir)) return null;
  const found = fs
    .readdirSync(dir)
    .filter((f) => /^proxy-0x[0-9a-fA-F]{40}\.env$/.test(f))
    .map((f) => {
      const file = path.join(dir, f);
      return { file, expiresAt: Number(parseEnvFile(fs.readFileSync(file, "utf8")).PERPS_PROXY_EXPIRES_AT) };
    })
    .filter((c) => c.expiresAt > now)
    .sort((a, b) => b.expiresAt - a.expiresAt);
  return found[0]?.file ?? null;
}

export function loadCredentials(file, { now = Date.now(), requireHoursLeft = 24 } = {}) {
  if (!file) throw new EnvError("No credentials found. Run `npm run setup` to create them, or set PERPS_ENV_FILE / config.envFile.");
  if (!fs.existsSync(file)) throw new EnvError(`Credentials file not found: ${file}`);
  const env = parseEnvFile(fs.readFileSync(file, "utf8"));

  const need = ["POLYMARKET_WALLET_ADDRESS", "PERPS_PROXY_ADDRESS", "PERPS_PROXY_PRIVATE_KEY", "PERPS_PROXY_SECRET", "PERPS_PROXY_EXPIRES_AT"];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new EnvError(`Credentials file is missing: ${missing.join(", ")}`);

  if (!isAddress(env.POLYMARKET_WALLET_ADDRESS)) throw new EnvError("POLYMARKET_WALLET_ADDRESS is not a valid address");
  if (!isAddress(env.PERPS_PROXY_ADDRESS)) throw new EnvError("PERPS_PROXY_ADDRESS is not a valid address");
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.PERPS_PROXY_PRIVATE_KEY)) throw new EnvError("PERPS_PROXY_PRIVATE_KEY is malformed");

  const derived = privateKeyToAccount(env.PERPS_PROXY_PRIVATE_KEY).address;
  if (getAddress(derived) !== getAddress(env.PERPS_PROXY_ADDRESS)) {
    throw new EnvError("PERPS_PROXY_PRIVATE_KEY does not belong to PERPS_PROXY_ADDRESS");
  }

  const expiresAt = Number(env.PERPS_PROXY_EXPIRES_AT);
  if (!Number.isFinite(expiresAt)) throw new EnvError("PERPS_PROXY_EXPIRES_AT is not a timestamp");
  const hoursLeft = (expiresAt - now) / 3_600_000;
  if (expiresAt - now < requireHoursLeft * 3_600_000) {
    throw new EnvError(
      `Proxy expires ${new Date(expiresAt).toISOString()} (${hoursLeft.toFixed(1)} h left); need at least ${requireHoursLeft} h. Create a new proxy with: npm run setup`,
    );
  }

  return makeCredentials({
    owner: getAddress(env.POLYMARKET_WALLET_ADDRESS),
    proxy: getAddress(env.PERPS_PROXY_ADDRESS),
    privateKey: env.PERPS_PROXY_PRIVATE_KEY,
    secret: env.PERPS_PROXY_SECRET,
    expiresAt,
  });
}

// Secrets live in a closure; only accessor functions reach them.
export function makeCredentials({ owner, proxy, privateKey, secret, expiresAt }) {
  const pub = { owner, proxy, expiresAt, expiresAtIso: new Date(expiresAt).toISOString() };
  const creds = {
    ...pub,
    privateKey: () => privateKey,
    authHeaders: () => ({ "POLYMARKET-PROXY": proxy, "POLYMARKET-SECRET": secret }),
    authArgs: () => ({ proxy, secret }),
    toJSON: () => pub,
    toString: () => `Credentials(${proxy})`,
    [inspect.custom]: () => `Credentials(${JSON.stringify(pub)})`,
  };
  return Object.freeze(creds);
}

export { DAY_MS };
