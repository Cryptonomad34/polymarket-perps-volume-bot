// REST client for Polymarket Perps.
//
// Error classes (only Fatal counts toward the risk layer's 3-strikes stop):
//   RateLimited   429 / action_rate_limited / ip_rate_limited  -> back off, retry
//   Maintenance   cancel-only window, order_in_flight, auto_cancel_in_flight -> wait
//   Indeterminate 503 service_unavailable, 500 internal_error, timeouts: the
//                 request MAY have been applied. Mutations resend the exact same
//                 signed body, then the caller reconciles by client order id.
//   StaleState    reduce_only_invalid / position_not_found: our view of the
//                 position is behind the exchange's (a fill landed between the
//                 decision and the order). Benign: resync and re-decide.
//   Fatal         anything else
// Per-order rejections inside a successful batch response are classified the
// same way; a post-only order that would cross is `PostOnlyReject` (benign).
//
// Mutating operations available: createOrders, cancelOrdersCOID, cancelOrders,
// cancelAll, autoCancel, updateLeverage. Nothing that moves funds.

import { commands } from "./signing.mjs";

export const BASE_URL = "https://api.perpetuals.polymarket.com";

export class ApiError extends Error {
  constructor(kind, message, { status, code, retryAfterMs, body } = {}) {
    super(message);
    this.kind = kind; // "RateLimited" | "Maintenance" | "Indeterminate" | "Fatal" | "PostOnlyReject" | "StaleState"
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

const RATE_LIMIT = /rate.?limit|too many requests/i;
const MAINTENANCE = /cancel.?only|order_in_flight|auto_cancel_in_flight|maintenance|exchange (is )?(paused|halted)/i;
const INDETERMINATE = /service_unavailable|internal_error/i;
const POST_ONLY = /post.?only|would (cross|take|match|lock)/i;
// The order was valid when we decided it, but the position moved underneath us.
const STALE_STATE = /reduce_only_invalid|position_not_found|no_open_position/i;

export function classifyError(status, code) {
  const c = String(code ?? "");
  if (status === 429 || RATE_LIMIT.test(c)) return "RateLimited";
  if (MAINTENANCE.test(c)) return "Maintenance";
  if (status === 503 || status === 502 || status === 504 || INDETERMINATE.test(c) || (status === 500 && !c)) return "Indeterminate";
  if (POST_ONLY.test(c)) return "PostOnlyReject";
  if (STALE_STATE.test(c)) return "StaleState";
  return "Fatal";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApi({ baseUrl = BASE_URL, log, creds = null, signer = null, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let clockOffsetMs = 0;
  const rate = { remaining: Infinity, resetAt: 0 };
  const now = () => Date.now() + clockOffsetMs;

  async function raw(method, path, { query, body, auth = false } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!creds) throw new ApiError("Fatal", "authenticated call without credentials");
      Object.assign(headers, creds.authHeaders());
    }

    // Respect the server's own rate-limit hint before sending.
    if (rate.remaining <= 1 && rate.resetAt > Date.now()) await sleep(rate.resetAt - Date.now());

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      throw new ApiError("Indeterminate", `${method} ${path}: network error (${e.name === "AbortError" ? "timeout" : e.message})`, { code: "network" });
    } finally {
      clearTimeout(timer);
    }

    const remaining = res.headers.get("poly-ratelimit-remaining");
    const reset = res.headers.get("poly-ratelimit-reset");
    if (remaining !== null && /^-?\d+$/.test(remaining)) rate.remaining = Number(remaining);
    if (reset !== null && /^\d+$/.test(reset)) rate.resetAt = Date.now() + Number(reset) * 1000;

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }

    const bodyErr = data && !Array.isArray(data) && data.status === "err" ? data.error : null;
    if (!res.ok || bodyErr) {
      const code = bodyErr ?? data?.error ?? `http_${res.status}`;
      const retryAfter = res.headers.get("retry-after");
      throw new ApiError(classifyError(res.status, code), `${method} ${path}: ${res.status} ${code}`, {
        status: res.status,
        code,
        retryAfterMs: retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined,
        body: data,
      });
    }
    return data;
  }

  // Reads: retry rate limits and indeterminate failures with backoff.
  async function read(path, opts = {}, { tries = 4 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await raw("GET", path, opts);
      } catch (e) {
        const retryable = e.kind === "RateLimited" || e.kind === "Indeterminate" || e.kind === "Maintenance";
        if (!retryable || attempt >= tries - 1) throw e;
        await sleep(e.retryAfterMs ?? Math.min(250 * 2 ** attempt, 5000));
      }
    }
  }

  // Signed mutation. Rate limits: back off and retry (the request was not
  // admitted). Indeterminate: resend the *exact same* body. Returns
  // { data } or throws ApiError; `indeterminate: true` on the error means
  // the caller must reconcile before assuming anything.
  async function mutate(method, path, command, { expMs = 4000, tries = 3 } = {}) {
    if (!signer) throw new ApiError("Fatal", "signed call without a signer (dry run?)");
    let body = await signer.sign(command, { ts: now(), exp: now() + expMs });
    let lastErr;
    for (let attempt = 0; attempt < tries + 2; attempt++) {
      try {
        return { data: await raw(method, path, { body }) };
      } catch (e) {
        lastErr = e;
        if (e.kind === "RateLimited") {
          await sleep(e.retryAfterMs ?? Math.min(250 * 2 ** attempt, 10_000));
          body = await signer.sign(command, { ts: now(), exp: now() + expMs }); // not admitted: fresh ts is safe
          continue;
        }
        if (e.kind === "Indeterminate" && attempt < tries) {
          await sleep(e.retryAfterMs ?? 200 * 2 ** attempt);
          continue; // same body: same salt/ts/sig/coid, cannot create a second order
        }
        if (e.kind === "Indeterminate") e.indeterminate = true;
        throw e;
      }
    }
    throw lastErr;
  }

  return {
    now,
    rate,
    get clockOffsetMs() {
      return clockOffsetMs;
    },

    async syncTime() {
      const t0 = Date.now();
      const { time } = await read("/v1/info/time");
      const t1 = Date.now();
      clockOffsetMs = Math.round(time - (t0 + t1) / 2);
      return clockOffsetMs;
    },

    // ---- public ----
    instruments: () => read("/v1/info/instruments"),
    fees: () => read("/v1/info/fees"),
    tickers: () => read("/v1/info/tickers"),
    bbo: () => read("/v1/info/bbo"),
    book: (iid, depth = 10) => read("/v1/info/book", { query: { instrument_id: iid, depth } }),

    // ---- private reads ----
    portfolio: () => read("/v1/account/portfolio", { auth: true }),
    openOrders: (iid) => read("/v1/account/open-orders", { auth: true, query: { instrument_id: iid } }),
    autoCancelStatus: () => read("/v1/account/auto-cancel", { auth: true }),
    config: () => read("/v1/account/config", { auth: true }),
    async fills({ start, instrumentId } = {}) {
      const out = [];
      let cursor;
      for (let page = 0; page < 50; page++) {
        const r = await read("/v1/account/fills", { auth: true, query: { start_timestamp: start, instrument_id: instrumentId, cursor, sort: "asc" } });
        out.push(...(r?.data ?? []));
        if (!r?.more || !r.cursor) break;
        cursor = r.cursor;
      }
      return out;
    },
    async funding({ start, end } = {}) {
      const r = await read("/v1/account/funding", { auth: true, query: { start_timestamp: start, end_timestamp: end } });
      return r?.data ?? [];
    },

    // ---- signed mutations ----
    createOrders: (orders, opts) => mutate("POST", "/v1/trade/orders", commands.createOrders(orders), opts),
    cancelOrdersCOID: (coids) => mutate("DELETE", "/v1/trade/orders-coid", commands.cancelOrdersCOID(coids)),
    cancelOrders: (oids) => mutate("DELETE", "/v1/trade/orders", commands.cancelOrders(oids)),
    cancelAll: (iid) => mutate("DELETE", "/v1/trade/orders/all", commands.cancelAll(iid)),
    autoCancel: (time) => mutate("PATCH", "/v1/trade/auto-cancel", commands.autoCancel(time)),
    updateLeverage: (iid, lev, cross) => mutate("PATCH", "/v1/trade/leverage", commands.updateLeverage(iid, lev, cross)),
  };
}

// Classify one element of a batch response (createOrders / cancel).
export function itemError(item) {
  if (!item || item.status !== "err") return null;
  return new ApiError(classifyError(200, item.error), item.error, { code: item.error, body: item });
}
