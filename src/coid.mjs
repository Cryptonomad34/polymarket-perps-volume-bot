// Deterministic client order ids: sha256(sessionId|iid|intent|nonce)[0:32].
// The nonce comes from persisted state and only ever increases, so a restart
// never reuses a coid, and a retried request (same coid) can't create a
// second order.

import crypto from "node:crypto";

export const INTENTS = ["quote-bid", "quote-ask", "flatten-post", "flatten-ioc", "smoke"];

export function makeCoid({ sessionId, iid, intent, nonce }) {
  if (!INTENTS.includes(intent)) throw new Error(`unknown order intent: ${intent}`);
  const hex = crypto.createHash("sha256").update(`${sessionId}|${iid}|${intent}|${nonce}`).digest("hex").slice(0, 32);
  // The API rejects an all-zero coid; sha256 makes that practically impossible, but be explicit.
  return /^0+$/.test(hex) ? "0".repeat(31) + "1" : hex;
}
