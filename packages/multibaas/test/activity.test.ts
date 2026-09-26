import { expect, test } from "bun:test";

import type { MultiBaas, MultiBaasEvent } from "../src/client.js";
import { type ActivityRow, activityOn } from "../src/treasury.js";

const OWNER = "0x9673afB923d556979E4dfe6854d8C6e2D9994Eb4";
const OTHER = "0x00000000000000000000000000000000000000ff";
const TOKEN = "0x974727EA649Ee0EfBB6A1b1A584614838B832cB3";
const SPENDER = "0x73ed10744987B65fAf6BD6FFdF1039Cb7eF97002";

const permit = (owner: string, amount: string, expiration: number, block = 1): MultiBaasEvent => ({
  event: {
    name: "Permit",
    signature: "Permit(address,address,address,uint160,uint48,uint48)",
    inputs: [
      { name: "owner", value: owner },
      { name: "token", value: TOKEN },
      { name: "spender", value: SPENDER },
      { name: "amount", value: amount },
      { name: "expiration", value: String(expiration) },
      { name: "timestamp", value: "1700" },
    ],
  },
  transaction: { txHash: `0x${block.toString(16).padStart(64, "0")}`, blockNumber: block, from: owner, txIndexInBlock: 0 },
});

/** A stub, because the decoding is the thing under test — not whether fetch works. */
const stub = (events: MultiBaasEvent[]) => ({ listAllEvents: async () => events }) as unknown as MultiBaas;

const kinds = (rows: ActivityRow[]) => rows.map((r) => r.kind);

test("a grant, a lock and a clear are told apart by their expiration and amount", async () => {
  const rows = await activityOn(
    stub([permit(OWNER, "5000000", 1790452828, 3), permit(OWNER, "0", 2, 2), permit(OWNER, "0", 1790452828, 1)]),
    84532,
    OWNER as `0x${string}`,
  );
  expect(kinds(rows)).toEqual(["granted", "locked", "cleared"]);
  expect(rows[0]!.amount).toBe(5_000_000n);
  expect(rows[0]!.chainId).toBe(84532);
});

test("another owner's events are not this client's history", async () => {
  const rows = await activityOn(stub([permit(OTHER, "5000000", 1790452828)]), 84532, OWNER as `0x${string}`);
  expect(rows).toHaveLength(0);
});

test("an event with the right name but the wrong arity is dropped, not decoded positionally", async () => {
  // MultiBaas's eventName filter is not exact: asking for Permit also returns NonceInvalidated,
  // whose two inputs would otherwise land a salt in the token column and a 1970 expiry in the row.
  const malformed: MultiBaasEvent = {
    event: {
      name: "Permit",
      signature: "Permit(address,bytes32)",
      inputs: [
        { name: "owner", value: OWNER },
        { name: "salt", value: "0xdead" },
      ],
    },
  };
  expect(await activityOn(stub([malformed]), 84532, OWNER as `0x${string}`)).toHaveLength(0);
});

test("a burned salt is carried as its own kind", async () => {
  const nonce: MultiBaasEvent = {
    event: {
      name: "NonceInvalidated",
      signature: "NonceInvalidated(address,bytes32)",
      inputs: [
        { name: "owner", value: OWNER },
        { name: "salt", value: "0xbeef" },
      ],
    },
  };
  const rows = await activityOn(stub([nonce]), 84532, OWNER as `0x${string}`);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe("cancelled");
  expect(rows[0]!.salt).toBe("0xbeef");
});

test("newest first by block, so the screen does not have to re-sort", async () => {
  const rows = await activityOn(
    stub([permit(OWNER, "1", 1790452828, 5), permit(OWNER, "2", 1790452828, 9)]),
    84532,
    OWNER as `0x${string}`,
  );
  expect(rows.map((r) => r.blockNumber)).toEqual([9, 5]);
});

test("an unreachable deployment reads as no history rather than throwing", async () => {
  const broken = { listAllEvents: async () => { throw new Error("502"); } } as unknown as MultiBaas;
  expect(await activityOn(broken, 84532, OWNER as `0x${string}`)).toEqual([]);
});
