// Fair value for strategy.mode "fair" (pure).
//
// Profitable makers never treat their own venue's best bid/ask as the price.
// They price from the fastest markets and only then look at the local book.
// Here that is:
//
//   refFair   median over the reference venues (Binance, Bybit, OKX) of
//             venueMid * (1 + that venue's usual basis to Polymarket)
//             - see src/reference.mjs
//   micro     Polymarket's microprice: the mid pulled toward the side with
//             less size, which is the side about to give way
//   fair      refFair + imbalanceWeight * (micro - mid)
//
// Inventory is handled here too, by shifting fair value rather than by
// stopping a side: long moves fair value down, so the ask gets closer to the
// market (the exit fills sooner, as a maker) and the bid moves further away
// (adding is less likely), while both sides keep quoting.
//
// fairValue() -> { ok: true, fair, refFair, micro, mid, skewBps } or
//                { ok: false, reason } when there is nothing trustworthy to
//                price from. Callers then quote only to reduce a position.

export function microprice(book) {
  const { bid, ask, bidQty, askQty } = book;
  const mid = (bid + ask) / 2;
  if (!(bidQty > 0) || !(askQty > 0)) return mid;
  // A big bid and a small ask means buyers are about to lift the ask: the
  // fair price is closer to the ask. Hence each price is weighted by the
  // OTHER side's size.
  return (bid * askQty + ask * bidQty) / (bidQty + askQty);
}

export function fairValue({ ref, book, position, cfg }) {
  const f = cfg.fair;
  if (!ref?.ok) return { ok: false, reason: `reference ${ref?.reason ?? "off"}` };
  if (!(ref.refFair > 0)) return { ok: false, reason: "reference has no fair price" };
  if (!(book?.bid > 0) || !(book.ask > book.bid)) return { ok: false, reason: "book unusable" };

  const mid = (book.bid + book.ask) / 2;
  const micro = microprice(book);
  let fair = ref.refFair + f.imbalanceWeight * (micro - mid);

  // A reference this far from Polymarket is broken (a bad basis average, a
  // wrong symbol, a venue halted), not an opportunity. Refuse to price off it.
  const devBps = (Math.abs(fair - mid) / mid) * 1e4;
  if (devBps > f.maxDeviationBps) return { ok: false, reason: `fair value ${devBps.toFixed(1)} bps from Polymarket mid` };

  const inv = Math.max(-1, Math.min(1, (position?.notional ?? 0) / cfg.inventory.maxNotionalUsd));
  const skewBps = -f.skewBps * inv;
  fair *= 1 + skewBps / 1e4;
  return { ok: true, fair, refFair: ref.refFair, micro, mid, skewBps };
}
