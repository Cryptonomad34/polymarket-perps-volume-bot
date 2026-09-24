// Risk limits (pure). evaluate() turns a snapshot of the bot's state into
// either { ok, cancelIids, canOpen } or a stop. Every stop means: cancel
// this bot's orders, flatten, stop trading until 00:00 UTC, log why.

export function netPnl(d) {
  // Trading P&L (realized + unrealized, marked to mid) minus fees and funding.
  return d.realized + d.unrealized - d.makerFees - d.takerFees - d.funding;
}

export function costUsed(d) {
  // The daily cost budget: the all-in cost of trading today, i.e.
  // fees + funding + slippage + inventory drift = fees + funding - trading P&L
  // (= -net P&L). Fees alone can round to zero with maker rebates, while the
  // real cost is the position moving against us after fills.
  return d.makerFees + d.takerFees + d.funding - (d.realized + d.unrealized);
}

export function autoCancelHeadroomLow({ triggered, dailyLimit }) {
  if (!Number.isFinite(triggered) || !Number.isFinite(dailyLimit) || dailyLimit <= 0) return false;
  const remaining = dailyLimit - triggered;
  return remaining <= Math.max(2, Math.ceil(dailyLimit * 0.1));
}

/**
 * @param {object} s
 * @param {number} s.now
 * @param {object} s.cfg
 * @param {object} s.daily        {realized, unrealized, makerFees, takerFees, funding, slippage}
 * @param {number} s.consecutiveFatal
 * @param {object} s.feed         {connected, downSince, disconnectsToday}
 * @param {object} s.stale        { [iid]: { staleMs, staleSince } }
 * @param {object} s.autoCancel   {enabled, triggered, dailyLimit, fatalError}
 * @param {boolean} s.live
 */
export function evaluate(s) {
  const r = s.cfg.risk;
  const stop = (reason, detail = {}) => ({ ok: false, stop: { reason, ...detail }, cancelIids: "all", canOpen: false });

  const pnl = netPnl(s.daily);
  if (pnl <= -r.dailyLossUsd) return stop("daily loss stop", { pnl: round(pnl), limit: -r.dailyLossUsd });

  if (s.consecutiveFatal >= r.maxConsecutiveErrors)
    return stop("consecutive API errors", { count: s.consecutiveFatal, limit: r.maxConsecutiveErrors });

  if (s.feed.disconnectsToday > r.maxDisconnectsPerDay)
    return stop("too many WebSocket disconnects today", { count: s.feed.disconnectsToday, limit: r.maxDisconnectsPerDay });

  if (!s.feed.connected && s.feed.downSince && s.now - s.feed.downSince > r.reconnectGraceSec * 1000)
    return stop("WebSocket not restored in time", { downForSec: Math.round((s.now - s.feed.downSince) / 1000), graceSec: r.reconnectGraceSec });

  const cancelIids = [];
  for (const [iid, st] of Object.entries(s.stale)) {
    if (st.staleMs <= r.staleMs) continue;
    cancelIids.push(Number(iid));
    if (st.staleSince && s.now - st.staleSince > r.staleGraceSec * 1000)
      return stop("market data stale", { iid: Number(iid), staleForSec: Math.round((s.now - st.staleSince) / 1000), graceSec: r.staleGraceSec });
  }

  if (s.live && s.autoCancel?.enabled) {
    if (s.autoCancel.fatalError) return stop("auto-cancel could not be armed", { error: s.autoCancel.fatalError });
    if (autoCancelHeadroomLow(s.autoCancel))
      return stop("auto-cancel daily fire limit nearly used", { triggered: s.autoCancel.triggered, dailyLimit: s.autoCancel.dailyLimit });
  }

  const feedDown = !s.feed.connected;
  return {
    ok: true,
    stop: null,
    cancelIids: feedDown ? "all" : cancelIids,
    canOpen: costUsed(s.daily) < s.cfg.budget.dailyCostUsd,
  };
}

const round = (x) => Math.round(x * 100) / 100;
