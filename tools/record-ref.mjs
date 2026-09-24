#!/usr/bin/env node
// Records three price feeds side by side so we can measure which one moves
// first.
//
// Why: every maker fill markets out at -2.14 bps, about two standard
// deviations of a 5-second move. Fills that bad are not bad luck; someone is
// taking our quote because they already know the price has moved. The only
// question that matters is whether we can see what they see, in time.
//
//   pm   Polymarket best bid/ask - the book we actually quote into (websocket)
//   idx  Polymarket index price  - REST /v1/info/tickers, refreshes every ~1.8s
//   bin  Binance USD-M futures best bid/ask (websocket), the deepest and
//        fastest BTC/ETH price there is. Public data, no account, no key.
//
// Every row carries the time WE received it, because that - not the exchange
// stamp - is what a live bot could have acted on.
//
// Usage: node tools/record-ref.mjs [--minutes 180] [--out logs/ref.csv]

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const MINUTES = Number(opt("minutes", "180"));
const OUT = opt("out", "logs/ref.csv");
const POLL_MS = 400; // faster than the ~1.8s index refresh, so we see each one promptly
const BIN_THROTTLE_MS = 50; // Binance pushes far faster than we need

// Polymarket instrument id -> Binance stream symbol
const MARKETS = [
  { iid: 6, symbol: "BTC-USD", binance: "btcusdt" },
  { iid: 7, symbol: "ETH-USD", binance: "ethusdt" },
];
const BY_IID = new Map(MARKETS.map((m) => [m.iid, m]));
const BY_BINANCE = new Map(MARKETS.map((m) => [m.binance, m]));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const fresh = !fs.existsSync(OUT) || fs.statSync(OUT).size === 0;
const out = fs.createWriteStream(OUT, { flags: "a" });
if (fresh) out.write("recvTs,src,iid,exchTs,bid,ask\n");

const counts = { pm: 0, idx: 0, bin: 0 };
const stopAt = Date.now() + MINUTES * 60_000;
let closing = false;

// ---- Polymarket index (REST) -------------------------------------------
const lastExchTs = new Map();
async function pollLoop() {
  while (!closing && Date.now() < stopAt) {
    try {
      const res = await fetch("https://api.perpetuals.polymarket.com/v1/info/tickers");
      const recvTs = Date.now();
      for (const t of await res.json()) {
        if (!BY_IID.has(t.instrument_id)) continue;
        // The endpoint serves the same snapshot for ~1.8s; keep only new ones.
        if (lastExchTs.get(t.instrument_id) === t.timestamp) continue;
        lastExchTs.set(t.instrument_id, t.timestamp);
        // index has no two sides; carry it in both columns so the reader is uniform.
        out.write(`${recvTs},idx,${t.instrument_id},${t.timestamp},${t.index_price},${t.index_price}\n`);
        counts.idx++;
      }
    } catch (e) {
      process.stderr.write(`idx poll: ${e.message}\n`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---- Polymarket book (websocket) ---------------------------------------
let pmWs = null;
function connectPm() {
  pmWs = new WebSocket("wss://ws.perpetuals.polymarket.com/v1/ws");
  pmWs.on("open", () => pmWs.send(JSON.stringify({ req: "sub", chs: MARKETS.map((m) => `bbo::${m.iid}`) })));
  pmWs.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m.ch?.startsWith("bbo::")) return;
    const d = m.data ?? {};
    if (!d.bp || !d.ap) return;
    out.write(`${Date.now()},pm,${Number(m.ch.split("::")[1])},${m.ts ?? ""},${d.bp},${d.ap}\n`);
    counts.pm++;
  });
  pmWs.on("close", () => !closing && setTimeout(connectPm, 1000));
  pmWs.on("error", (e) => process.stderr.write(`pm ws: ${e.message}\n`));
}

// ---- Binance futures book (websocket) ----------------------------------
let binWs = null;
const lastBinWrite = new Map();
function connectBin() {
  const streams = MARKETS.map((m) => `${m.binance}@bookTicker`).join("/");
  binWs = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  binWs.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const d = m.data;
    if (!d?.s) return;
    const mk = BY_BINANCE.get(d.s.toLowerCase());
    if (!mk) return;
    const now = Date.now();
    if (now - (lastBinWrite.get(mk.iid) ?? 0) < BIN_THROTTLE_MS) return;
    lastBinWrite.set(mk.iid, now);
    // T is Binance's own transaction time: the lead we are trying to measure.
    out.write(`${now},bin,${mk.iid},${d.T ?? d.E ?? ""},${d.b},${d.a}\n`);
    counts.bin++;
  });
  binWs.on("close", () => !closing && setTimeout(connectBin, 1000));
  binWs.on("error", (e) => process.stderr.write(`bin ws: ${e.message}\n`));
}

// ---- run ----------------------------------------------------------------
connectPm();
connectBin();
pollLoop();

const tick = setInterval(() => {
  const left = Math.round((stopAt - Date.now()) / 60000);
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] pm=${counts.pm} idx=${counts.idx} bin=${counts.bin}  ${left}min left\n`);
}, 60_000);

function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(tick);
  pmWs?.close();
  binWs?.close();
  out.end(() => {
    process.stderr.write(`done: pm=${counts.pm} idx=${counts.idx} bin=${counts.bin} -> ${OUT}\n`);
    process.exit(0);
  });
}
setTimeout(shutdown, MINUTES * 60_000);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, shutdown);
