// EIP-712 signing for Perps trading commands with the proxy key.
//
// Mirrors @polymarket/client@0.10.0 exactly (see test/signing-match.mjs):
//   Op{ data: keccak256(msgpack(stripUndefined(opArray))), salt: uint64, ts: uint64 }
//   domain { name: "Polymarket", version: "1", chainId: 137 }
// Domain, Op type and salt handling follow proxy-tool/server.mjs, which is
// proven against the live API for deleteProxy.
//
// Only trading/risk commands exist here. There is deliberately no withdraw,
// transfer or margin-adjustment encoding.

import crypto from "node:crypto";
import { encode } from "@msgpack/msgpack";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CHAIN_ID = 137;
const domain = { name: "Polymarket", version: "1", chainId: CHAIN_ID };
const opTypes = {
  Op: [
    { name: "data", type: "bytes32" },
    { name: "salt", type: "uint64" },
    { name: "ts", type: "uint64" },
  ],
};

export function randomSalt() {
  return crypto.randomBytes(4).readUInt32BE(0);
}

// SDK `fi`: drop undefined entries from arrays, recursively.
export function stripUndefined(v) {
  return Array.isArray(v) ? v.filter((x) => x !== undefined).map(stripUndefined) : v;
}

export function opDigestData(opArray) {
  return keccak256(encode(stripUndefined(opArray)));
}

export function opTypedData({ opArray, salt, ts }) {
  return {
    domain,
    types: opTypes,
    primaryType: "Op",
    message: { data: opDigestData(opArray), salt: BigInt(salt), ts: BigInt(ts) },
  };
}

// ---- command encoders: return { array, json } like SDK Xo/Fr ----

// order = { iid, buy, price, qty, tif, postOnly, reduceOnly, coid }
function orderArray(o) {
  return [o.iid, o.buy, o.price, o.qty, o.tif, o.postOnly ?? false, o.reduceOnly === true ? true : undefined, o.coid, undefined];
}

function orderJson(o) {
  const r = { iid: o.iid, buy: o.buy, po: o.postOnly ?? false, qty: o.qty };
  if (o.tif !== undefined) r.tif = o.tif;
  if (o.reduceOnly) r.ro = true;
  if (o.price !== undefined) r.p = o.price;
  if (o.coid !== undefined) r.c = o.coid;
  return r;
}

export const commands = {
  createOrders: (orders) => ({
    array: ["createOrders", orders.map(orderArray)],
    json: { type: "createOrders", args: orders.map(orderJson) },
  }),
  cancelOrders: (oids) => ({
    array: ["cancelOrders", oids],
    json: { type: "cancelOrders", args: oids },
  }),
  cancelOrdersCOID: (coids) => ({
    array: ["cancelOrdersCOID", coids],
    json: { type: "cancelOrdersCOID", args: coids },
  }),
  cancelAll: (iid) => ({
    array: ["cancelAll", iid === undefined ? [] : [iid]],
    json: { type: "cancelAll", args: iid === undefined ? {} : { iid } },
  }),
  autoCancel: (time) => ({
    array: ["autoCancel", [time]],
    json: { type: "autoCancel", args: { time } },
  }),
  updateLeverage: (iid, lev, cross) => ({
    array: ["updateLeverage", [iid, lev, cross]],
    json: { type: "updateLeverage", args: { cross, iid, lev } },
  }),
};

export function createSigner(privateKeyFn) {
  const account = privateKeyToAccount(privateKeyFn());
  return {
    address: account.address,
    // Returns the full request body. `exp` is not covered by the signature (as in the SDK).
    async sign(command, { ts, salt = randomSalt(), exp } = {}) {
      const sig = await account.signTypedData(opTypedData({ opArray: command.array, salt, ts }));
      const body = { op: command.json, sig, salt, ts };
      if (exp !== undefined) body.exp = exp;
      return body;
    },
  };
}
