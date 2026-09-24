// Market data over one WebSocket: bbo + book + trades per instrument, plus the
// private `fills` and `orders` channels in live mode.
//
// Observed behaviour (2026-09-22): `book::<iid>` pushes a full 20-level
// snapshot roughly every 100 ms even when unchanged, so it doubles as a
// heartbeat; `sq` is a global sequence, not per channel. A reconnect resyncs
// from REST before reporting the feed healthy again.
//
// Events: "book"(iid), "trade"(trade), "fill"(fill), "order"(order),
//         "disconnected"(reason), "restored"(), "error"(err)

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export const WS_URL = "wss://ws.perpetuals.polymarket.com/v1/ws";
const PING_MS = 20_000;
const IDLE_KILL_MS = 45_000;

const num = (x) => (x === undefined || x === null ? NaN : Number(x));

export function emptyBook() {
  return { bid: NaN, ask: NaN, bidQty: 0, askQty: 0, bids: [], asks: [], updatedAt: 0, exchTs: 0 };
}

export function mid(book) {
  return (book.bid + book.ask) / 2;
}

export function createMarketData({ api, iids, log, creds = null, url = WS_URL, WebSocketImpl = WebSocket }) {
  const ev = new EventEmitter();
  const books = new Map(iids.map((iid) => [iid, emptyBook()]));
  let ws = null;
  let pingTimer = null;
  let lastMsgAt = 0;
  let closing = false;
  let connected = false;
  let reconnectDelay = 1000;

  function applyLevels(iid, bids, asks, exchTs) {
    const b = books.get(iid);
    if (!b) return;
    b.bids = bids.map(([p, q]) => [num(p), num(q)]);
    b.asks = asks.map(([p, q]) => [num(p), num(q)]);
    if (b.bids.length) [b.bid, b.bidQty] = b.bids[0];
    if (b.asks.length) [b.ask, b.askQty] = b.asks[0];
    b.updatedAt = Date.now();
    b.exchTs = exchTs ?? b.exchTs;
    ev.emit("book", iid);
  }

  function applyBbo(iid, d, exchTs) {
    const b = books.get(iid);
    if (!b) return;
    b.bid = num(d.bp);
    b.bidQty = num(d.bq);
    b.ask = num(d.ap);
    b.askQty = num(d.aq);
    // Keep top level of the depth arrays consistent with the fresher BBO.
    if (b.bids.length && b.bids[0][0] !== b.bid) b.bids = [[b.bid, b.bidQty], ...b.bids.filter(([p]) => p < b.bid)];
    else if (b.bids.length) b.bids[0][1] = b.bidQty;
    if (b.asks.length && b.asks[0][0] !== b.ask) b.asks = [[b.ask, b.askQty], ...b.asks.filter(([p]) => p > b.ask)];
    else if (b.asks.length) b.asks[0][1] = b.askQty;
    b.updatedAt = Date.now();
    b.exchTs = exchTs ?? b.exchTs;
    ev.emit("book", iid);
  }

  async function resyncFromRest() {
    for (const iid of iids) {
      const snap = await api.book(iid, 10);
      applyLevels(iid, snap.bids ?? [], snap.asks ?? [], snap.timestamp);
    }
  }

  function onMessage(raw) {
    lastMsgAt = Date.now();
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const ch = m.ch;
    if (!ch) {
      if (m.data?.status === "err" || m.status === "err") log.warn("ws: request rejected", { error: m.data?.error ?? m.error });
      return;
    }
    const [name, idStr] = ch.split("::");
    const iid = idStr === undefined ? undefined : Number(idStr);
    switch (name) {
      case "book":
        applyLevels(iid, m.data?.b ?? [], m.data?.a ?? [], m.ts);
        break;
      case "bbo":
        applyBbo(iid, m.data ?? {}, m.ts);
        break;
      case "trades":
        for (const t of m.data ?? [])
          ev.emit("trade", { tid: t.tid, iid: t.iid ?? iid, takerBuy: t.side === "long", price: num(t.p), qty: num(t.qty), ts: t.ts });
        break;
      case "fills":
        for (const f of Array.isArray(m.data) ? m.data : [m.data])
          ev.emit("fill", {
            tradeId: f.tid,
            oid: f.oid,
            iid: f.iid,
            buy: f.side === "long",
            price: num(f.p),
            qty: num(f.qty),
            fee: num(f.fee),
            coid: f.coid,
            ts: f.ts,
            source: "ws",
          });
        break;
      case "orders":
        for (const o of Array.isArray(m.data) ? m.data : [m.data])
          ev.emit("order", { oid: o.oid, iid: o.iid, coid: o.coid, status: o.status, resting: num(o.rest), filled: num(o.fill), price: num(o.p), qty: num(o.qty) });
        break;
    }
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify(obj));
  }

  function connect() {
    ws = new WebSocketImpl(url);
    ws.on("open", async () => {
      reconnectDelay = 1000;
      lastMsgAt = Date.now();
      const chs = iids.flatMap((iid) => [`bbo::${iid}`, `book::${iid}`, `trades::${iid}`]);
      if (creds) {
        send({ req: "post", op: { type: "auth", args: creds.authArgs() } });
        chs.push("fills", "orders");
      }
      send({ req: "sub", chs });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (Date.now() - lastMsgAt > IDLE_KILL_MS) {
          log.warn("ws: no messages, terminating connection", { idleMs: Date.now() - lastMsgAt });
          ws.terminate();
          return;
        }
        send({ req: "post", op: { type: "ping" } });
      }, PING_MS);
      try {
        await resyncFromRest();
        connected = true;
        log.info("ws: connected and resynced", { iids });
        ev.emit("restored");
      } catch (e) {
        log.warn("ws: REST resync failed after connect", { error: e.message });
        ws.terminate();
      }
    });
    ws.on("message", onMessage);
    ws.on("error", (e) => log.warn("ws: error", { error: e.message }));
    ws.on("close", (code) => {
      clearInterval(pingTimer);
      const wasConnected = connected;
      connected = false;
      if (closing) return;
      if (wasConnected) ev.emit("disconnected", `ws closed (code ${code})`);
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      setTimeout(() => !closing && connect(), delay);
    });
  }

  return Object.assign(ev, {
    books,
    start() {
      closing = false;
      connect();
    },
    stop() {
      closing = true;
      clearInterval(pingTimer);
      if (ws) ws.close();
    },
    isConnected: () => connected,
    // A book is stale when nothing has updated it for `staleMs`.
    staleness(iid, now = Date.now()) {
      const b = books.get(iid);
      return b && b.updatedAt ? now - b.updatedAt : Infinity;
    },
  });
}
