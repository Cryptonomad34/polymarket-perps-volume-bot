#!/usr/bin/env node
// Records Polymarket's own index price alongside the order book, so we can
// measure whether the index LEADS the book.
//
// Why this exists: every fill markets out at -2.14 bps, meaning the price
// moves against us right after we trade. If the index (an external reference
// Polymarket publishes) moves before the book does, then the index tells us
// which side is about to be picked off, and we can stop quoting it.
//
// Two sources, one file:
//   idx rows - REST /v1/info/tickers. The payload carries its own `timestamp`,
//              which only advances every ~1.8 s, so we poll faster than that
//              and drop repeats. `recvTs` is when WE saw it: that, not the
//              exchange stamp, is what a live bot could have acted on.
//   bbo rows - the same websocket feed the bot trades off.
//
// Usage: node tools/record-index.mjs [--minutes 60] [--out logs/index.csv]

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const MINUTES = Number(opt("minutes", "60"));
const OUT = opt("out", "logs/index.csv");
const SYMBOLS = { 6: "BTC-USD", 7: "ETH-USD" };
const IIDS = Object.keys(SYMBOLS).map(Number);
const POLL_MS = 400;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const fresh = !fs.existsSync(OUT) || fs.statSync(OUT).size === 0;
const out = fs.createWriteStream(OUT, { flags: "a" });
if (fresh) out.write("recvTs,src,iid,exchTs,index,mark,bid,ask\n");

let idxRows = 0;
let bboRows = 0;
const lastExchTs = new Map();

// ---- index poller -------------------------------------------------------
async function pollOnce() {
  const res = await fetch("https://api.perpetuals.polymarket.com/v1/info/tickers");
  const recvTs = Date.now();
  const data = await res.json();
  for (const t of data) {
    const iid = t.instrument_id;
    if (!SYMBOLS[iid]) continue;
    // The endpoint serves the same snapshot for ~1.8 s; only keep new ones.
    if (lastExchTs.get(iid) === t.timestamp) continue;
    lastExchTs.set(iid, t.timestamp);
    out.write(`${recvTs},idx,${iid},${t.timestamp},${t.index_price},${t.mark_price},,\n`);
    idxRows++;
  }
}

async function pollLoop() {
  while (Date.now() < stopAt) {
    try {
      await pollOnce();
    } catch (e) {
      process.stderr.write(`poll error: ${e.message}\n`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---- book feed ----------------------------------------------------------
let ws = null;
let closing = false;
function connect() {
  ws = new WebSocket("wss://ws.perpetuals.polymarket.com/v1/ws");
  ws.on("open", () => ws.send(JSON.stringify({ req: "sub", chs: IIDS.map((i) => `bbo::${i}`) })));
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m.ch?.startsWith("bbo::")) return;
    const iid = Number(m.ch.split("::")[1]);
    const d = m.data ?? {};
    if (!d.bp || !d.ap) return;
    out.write(`${Date.now()},bbo,${iid},${m.ts ?? ""},,,${d.bp},${d.ap}\n`);
    bboRows++;
  });
  ws.on("close", () => {
    if (!closing) setTimeout(connect, 1000);
  });
  ws.on("error", (e) => process.stderr.write(`ws error: ${e.message}\n`));
}

// ---- run ----------------------------------------------------------------
const stopAt = Date.now() + MINUTES * 60_000;
connect();
pollLoop();

const tick = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] idx=${idxRows} bbo=${bboRows} ${Math.round((stopAt - Date.now()) / 60000)}min left\n`);
}, 60_000);

setTimeout(() => {
  closing = true;
  clearInterval(tick);
  ws?.close();
  out.end(() => {
    process.stderr.write(`done: ${idxRows} index rows, ${bboRows} bbo rows -> ${OUT}\n`);
    process.exit(0);
  });
}, MINUTES * 60_000);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    closing = true;
    ws?.close();
    out.end(() => process.exit(0));
  });
}
