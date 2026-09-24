// Price/quantity rounding for Perps order rules (pure functions).
// Rules from /v1/info/instruments and the order errors reference:
//   - at most `price_decimals` / `quantity_decimals` decimal places
//   - at most 5 significant figures in price and in quantity
//   - order notional >= `min_notional`
// Values stay as JS numbers internally; strings are produced only at the edge.

const SIG_FIGS = 5;
const EPS = 1e-9;

function magnitude(x) {
  return Math.floor(Math.log10(Math.abs(x)));
}

// Smallest valid increment for a value of this size.
export function stepAt(value, decimals) {
  const byDecimals = 10 ** -decimals;
  if (!(value > 0)) return byDecimals;
  const bySigFigs = 10 ** (magnitude(value) - (SIG_FIGS - 1));
  return Math.max(byDecimals, bySigFigs);
}

function decimalsOf(step) {
  return Math.max(0, -Math.floor(Math.log10(step) + EPS));
}

function snap(value, step, mode) {
  const n = value / step;
  const k = mode === "down" ? Math.floor(n + EPS) : mode === "up" ? Math.ceil(n - EPS) : Math.round(n);
  return Number((k * step).toFixed(decimalsOf(step)));
}

// Bids round down, asks round up, so rounding never makes a quote more aggressive.
export function roundPrice(price, decimals, side) {
  const mode = side === "buy" ? "down" : side === "sell" ? "up" : "nearest";
  let p = snap(price, stepAt(price, decimals), mode);
  // Crossing a power of ten changes the step; snap once more at the new size.
  p = snap(p, stepAt(p, decimals), mode);
  return p;
}

export function tickAt(price, decimals) {
  return stepAt(price, decimals);
}

export function roundQty(qty, decimals) {
  if (!(qty > 0)) return 0;
  let q = snap(qty, stepAt(qty, decimals), "down");
  q = snap(q, stepAt(q, decimals), "down");
  return q;
}

// Quantity for a target notional, bumped up (by whole steps) to reach min notional.
export function qtyForNotional(notional, price, decimals, minNotional) {
  let q = roundQty(notional / price, decimals);
  let guard = 0;
  while (q * price < minNotional - EPS && guard++ < 1000) {
    q = Number((q + stepAt(q || notional / price, decimals)).toFixed(decimals));
  }
  return q;
}

export function toDecimalString(x) {
  if (!Number.isFinite(x)) throw new Error(`not a finite number: ${x}`);
  let s = x.toFixed(12);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

export function sigFigs(str) {
  const digits = str.replace("-", "").replace(".", "").replace(/^0+/, "");
  return str.includes(".") ? digits.length : digits.replace(/0+$/, "").length;
}
