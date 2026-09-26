// Setup tool: create or revoke Polymarket Perps proxy credentials for the bot.
// Run it with `npm run setup` and open http://localhost:5173.
//
// - The proxy private key is generated HERE (Node), never sent to the browser.
// - Your main wallet (Rabby, MetaMask, ...) only signs EIP-712 messages in the browser.
// - Server binds to 127.0.0.1 only, so nothing on your network can reach it.
//
// Signing formats mirror the official @polymarket/client SDK (v0.10.0):
//   createProxy -> CreateProxy{addr, exp, salt, ts}
//   deleteProxy -> Op{data = keccak256(msgpack(["deleteProxy", [proxy]])), salt, ts}

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { encode } from "@msgpack/msgpack";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress, keccak256, recoverTypedDataAddress } from "viem";

const API = "https://api.perpetuals.polymarket.com";
const CHAIN_ID = 137;
const PORT = 5173;
const HOST = "127.0.0.1";

const here = path.dirname(fileURLToPath(import.meta.url));
// Saved next to the bot, where it looks for them automatically.
const credsDir = path.join(here, "..", "credentials");

const MAX_DAYS = 30;

// Pending requests awaiting a wallet signature, keyed by a random id.
// Entries expire so unused proxy keys don't linger in memory.
const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 20;

function addPending(entry) {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  if (pending.size >= MAX_PENDING) throw new Error("Too many unfinished requests. Restart the tool.");
  const id = crypto.randomUUID();
  pending.set(id, { ...entry, createdAt: now });
  return id;
}

function takePending(id, kind) {
  const p = pending.get(id);
  pending.delete(id);
  if (!p || p.kind !== kind || Date.now() - p.createdAt > PENDING_TTL_MS) {
    throw new Error("Unknown or expired request. Start again.");
  }
  return p;
}

const domain = { name: "Polymarket", version: "1", chainId: CHAIN_ID };
const domainType = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
];

function randomSalt() {
  return crypto.randomBytes(4).readUInt32BE(0);
}

function createProxyTypedData({ proxy, exp, salt, ts }) {
  return {
    domain,
    primaryType: "CreateProxy",
    types: {
      CreateProxy: [
        { name: "addr", type: "address" },
        { name: "exp", type: "uint64" },
        { name: "salt", type: "uint64" },
        { name: "ts", type: "uint64" },
      ],
    },
    message: { addr: proxy, exp, salt, ts },
  };
}

function opTypedData({ op, salt, ts }) {
  return {
    domain,
    primaryType: "Op",
    types: {
      Op: [
        { name: "data", type: "bytes32" },
        { name: "salt", type: "uint64" },
        { name: "ts", type: "uint64" },
      ],
    },
    message: { data: keccak256(encode(op)), salt, ts },
  };
}

// Wallets want EIP712Domain listed for eth_signTypedData_v4.
function forWallet(td) {
  return { ...td, types: { EIP712Domain: domainType, ...td.types } };
}

async function recoverSigner(td, signature) {
  return recoverTypedDataAddress({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: Object.fromEntries(
      Object.entries(td.message).map(([k, v]) => [k, typeof v === "number" ? BigInt(v) : v]),
    ),
    signature,
  });
}

async function callApi(method, pathname, { json, headers } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Polymarket API ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

// ---------- handlers ----------

async function prepareCreate({ owner, days, label }) {
  if (!isAddress(owner)) throw new Error("Invalid wallet address.");
  const d = Number(days);
  if (!(d > 0 && d <= MAX_DAYS)) throw new Error(`Days must be between 1 and ${MAX_DAYS}.`);

  const privateKey = generatePrivateKey();
  const proxy = privateKeyToAccount(privateKey).address; // checksummed
  const ts = Date.now();
  const exp = ts + Math.round(d * 24 * 60 * 60 * 1000);
  const salt = randomSalt();
  const td = createProxyTypedData({ proxy, exp, salt, ts });

  const id = addPending({
    kind: "create",
    owner: getAddress(owner),
    privateKey,
    proxy,
    exp,
    salt,
    ts,
    td,
    label: label ? String(label).slice(0, 64) : undefined,
  });
  return { id, proxy, expiresAt: exp, typedData: forWallet(td) };
}

async function submitCreate({ id, signature }) {
  const p = takePending(id, "create");

  const signer = await recoverSigner(p.td, signature);
  if (getAddress(signer) !== p.owner) {
    throw new Error(`Signature is from ${signer}, not ${p.owner}. Nothing was sent.`);
  }

  const body = {
    op: { type: "createProxy", args: { owner: p.owner, proxy: p.proxy, expiry: p.exp } },
    sig: signature,
    salt: p.salt,
    ts: p.ts,
  };
  if (p.label) body.label = p.label;

  const res = await callApi("POST", "/v1/account/proxy", { json: body });
  // The secret is written into a .env file, so reject anything that could inject extra lines.
  if (typeof res.secret !== "string" || !/^[A-Za-z0-9_\-+/=.:]{8,512}$/.test(res.secret)) {
    throw new Error("Polymarket returned a secret in an unexpected format. Nothing was saved.");
  }

  const creds = {
    owner: p.owner,
    proxy: p.proxy,
    privateKey: p.privateKey,
    secret: res.secret,
    expiresAt: p.exp,
    expiresAtIso: new Date(p.exp).toISOString(),
  };

  // Single copy of the key on disk, in credentials/ (git-ignored).
  fs.mkdirSync(credsDir, { recursive: true });
  const envFile = path.join(credsDir, `proxy-${p.proxy}.env`);
  fs.writeFileSync(
    envFile,
    [
      `# Polymarket Perps proxy credentials for volume-bot. Keep this file private. Expires ${creds.expiresAtIso}`,
      `# This proxy can trade but cannot withdraw. Revoke it anytime with: npm run setup`,
      `POLYMARKET_WALLET_ADDRESS=${creds.owner}`,
      `PERPS_PROXY_ADDRESS=${creds.proxy}`,
      `PERPS_PROXY_PRIVATE_KEY=${creds.privateKey}`,
      `PERPS_PROXY_SECRET=${creds.secret}`,
      `PERPS_PROXY_EXPIRES_AT=${creds.expiresAt}`,
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );

  // Confirm the API recognises the new credentials.
  let verified = false;
  let verifyError = null;
  try {
    const info = await callApi("GET", "/v1/account/credentials", {
      headers: { "POLYMARKET-PROXY": creds.proxy, "POLYMARKET-SECRET": creds.secret },
    });
    verified =
      !!info?.address &&
      getAddress(info.address) === p.owner &&
      Array.isArray(info.keys) &&
      info.keys.some((k) => k.proxy && getAddress(k.proxy) === p.proxy);
  } catch (e) {
    verifyError = e.message;
  }

  return {
    proxy: creds.proxy,
    expiresAt: creds.expiresAtIso,
    files: [envFile],
    verified,
    verifyError,
  };
}

async function prepareDelete({ owner, proxy }) {
  if (!isAddress(owner)) throw new Error("Invalid wallet address.");
  if (!isAddress(proxy)) throw new Error("Invalid proxy address.");
  const proxyAddr = getAddress(proxy);
  const op = ["deleteProxy", [proxyAddr]];
  const ts = Date.now();
  const salt = randomSalt();
  const td = opTypedData({ op, salt, ts });

  const id = addPending({ kind: "delete", owner: getAddress(owner), proxy: proxyAddr, salt, ts, td });
  return { id, typedData: forWallet(td) };
}

async function submitDelete({ id, signature }) {
  const p = takePending(id, "delete");

  const signer = await recoverSigner(p.td, signature);
  if (getAddress(signer) !== p.owner) {
    throw new Error(`Signature is from ${signer}, not ${p.owner}. Nothing was sent.`);
  }

  const res = await callApi("DELETE", "/v1/account/proxy", {
    json: {
      op: { type: "deleteProxy", args: { proxy: p.proxy } },
      sig: signature,
      salt: p.salt,
      ts: p.ts,
    },
  });
  if (res.status !== "ok") throw new Error(`Revoke rejected: ${JSON.stringify(res)}`);

  // The revoked key is now useless; mark its file so it is not used by mistake.
  const f = path.join(credsDir, `proxy-${p.proxy}.env`);
  if (fs.existsSync(f)) fs.renameSync(f, path.join(credsDir, `proxy-${p.proxy}.REVOKED.env`));
  return { proxy: p.proxy, revoked: true };
}

// Lists active proxies using any saved, non-expired credential file.
async function listProxies() {
  if (!fs.existsSync(credsDir)) return { saved: [], active: null };
  const saved = fs
    .readdirSync(credsDir)
    .filter((f) => /^proxy-0x[0-9a-fA-F]{40}\.env$/.test(f))
    .map((f) => {
      const env = Object.fromEntries(
        fs
          .readFileSync(path.join(credsDir, f), "utf8")
          .split(/\r?\n/)
          .filter((l) => l && !l.startsWith("#") && l.includes("="))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      return {
        owner: env.POLYMARKET_WALLET_ADDRESS,
        proxy: env.PERPS_PROXY_ADDRESS,
        secret: env.PERPS_PROXY_SECRET,
        expiresAt: Number(env.PERPS_PROXY_EXPIRES_AT),
      };
    });

  const usable = saved.find((c) => c.expiresAt > Date.now());
  let active = null;
  let error = null;
  if (usable) {
    try {
      active = await callApi("GET", "/v1/account/credentials", {
        headers: { "POLYMARKET-PROXY": usable.proxy, "POLYMARKET-SECRET": usable.secret },
      });
    } catch (e) {
      error = e.message;
    }
  }
  return {
    saved: saved.map(({ secret, ...rest }) => ({ ...rest, expiresAtIso: new Date(rest.expiresAt).toISOString() })),
    active,
    error,
  };
}

// ---------- http ----------

const routes = {
  "POST /api/create/prepare": prepareCreate,
  "POST /api/create/submit": submitCreate,
  "POST /api/delete/prepare": prepareDelete,
  "POST /api/delete/submit": submitDelete,
  "GET /api/proxies": listProxies,
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Only accept requests addressed to this local server (blocks DNS-rebinding).
  if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // No external scripts, no framing by other sites (click-jacking a signing flow).
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(path.join(here, "index.html")));
    return;
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    res.writeHead(404).end("Not found");
    return;
  }

  // Reject cross-site POSTs from other pages open in your browser.
  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
      res.writeHead(403).end("Forbidden origin");
      return;
    }
  }

  try {
    const body = req.method === "POST" ? await readJson(req) : {};
    const result = await handler(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nvolume-bot setup running at http://localhost:${PORT}`);
  console.log("Open it in the browser where your wallet extension is installed. Press Ctrl+C to stop.\n");
});
