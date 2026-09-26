// A CrossPermit *intent*: one signature, every chain, in one JSON object.
//
// This is the wire contract between the dApp, the relayer and the dashboard. Everything the relayer
// needs to submit on N chains is here, and everything here was covered by the single signature —
// so the relayer's only privilege is paying gas.
import {
  type Address,
  type Hex,
  type PublicClient,
  hashTypedData,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
} from "viem";

import {
  type ChainPermits,
  type Entry,
  buildUnbalancedTree,
  leafOf,
  processProof,
  randomSalt,
} from "./crosspermit.js";

/** One chain's share of an intent: the bundle that applies there, and its proof against the root. */
export type Leg = { chainId: number; bundle: ChainPermits; proof: Hex[] };

export type Intent = {
  /** The CrossPermit address — identical on every chain, which is what makes the signature port. */
  crossPermit: Address;
  owner: Address;
  salt: Hex;
  deadline: number;
  timestamp: number;
  root: Hex;
  signature: Hex;
  legs: Leg[];
};

/** EIP-712 domain and types, in one place. `chainId: 1` is pinned deliberately — see `signRoot`. */
export const intentTypedData = (crossPermit: Address, message: Omit<Intent, "crossPermit" | "signature" | "legs">) =>
  ({
    domain: { name: "CrossPermit", version: "1", chainId: 1, verifyingContract: crossPermit },
    types: {
      CrossPermit: [
        { name: "owner", type: "address" },
        { name: "salt", type: "bytes32" },
        { name: "deadline", type: "uint48" },
        { name: "timestamp", type: "uint48" },
        { name: "merkleRoot", type: "bytes32" },
      ],
    },
    primaryType: "CrossPermit" as const,
    message: {
      owner: message.owner,
      salt: message.salt,
      deadline: message.deadline,
      timestamp: message.timestamp,
      merkleRoot: message.root,
    },
  }) as const;

/**
 * Stable id for an intent, used for idempotency and as the dashboard's audit key.
 *
 * Keyed on the signed fields only — (owner, salt, root) — so a resubmission of the same signed
 * intent collides with the first one and is answered from state instead of broadcast again. The
 * signature is excluded on purpose: ECDSA is malleable, so two byte-different signatures can
 * authorise the identical permission and must not become two intents.
 */
export const intentId = (i: Pick<Intent, "owner" | "salt" | "root">): Hex =>
  keccak256(`0x${[i.owner, i.salt, i.root].map((h) => h.slice(2).toLowerCase()).join("")}` as Hex);

export class IntentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntentError";
  }
}

/**
 * Every check that does not need an RPC. Run this before spending a single wei of gas: a relayer
 * that forwards unvalidated intents burns its own balance and can be griefed into insolvency.
 *
 * Throws `IntentError` on the first failure so the caller can surface a reason, not just a boolean.
 * Deliberately NOT checked here, because both need a chain: the ERC-1271 branch of signature
 * recovery (`verifySigner`) and whether the bundle would actually revert (simulate before submit).
 */
export function validateIntent(i: Intent, opts: { now?: number; minSecondsLeft?: number } = {}): void {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const margin = opts.minSecondsLeft ?? 60;

  if (!isAddress(i.crossPermit)) throw new IntentError("bad_address", `crossPermit ${i.crossPermit} is not an address`);
  if (!isAddress(i.owner)) throw new IntentError("bad_address", `owner ${i.owner} is not an address`);
  if (i.legs.length === 0) throw new IntentError("no_legs", "an intent with no chains does nothing");

  // Margin, not just `> now`: an intent that expires while it is in the mempool wastes the gas of
  // every chain that had not landed yet.
  if (i.deadline <= now + margin) {
    throw new IntentError("expired", `deadline ${i.deadline} is within ${margin}s of now (${now})`);
  }

  const seen = new Set<number>();
  for (const leg of i.legs) {
    if (seen.has(leg.chainId)) throw new IntentError("duplicate_chain", `chain ${leg.chainId} appears twice`);
    seen.add(leg.chainId);

    // The bundle carries its own chainId and the contract rebuilds the leaf from it, so a leg whose
    // bundle names a different chain can never verify there. Catching it here turns a guaranteed
    // on-chain revert into a rejected request.
    if (BigInt(leg.chainId) !== leg.bundle.chainId) {
      throw new IntentError(
        "chain_mismatch",
        `leg addressed to chain ${leg.chainId} carries a bundle for chain ${leg.bundle.chainId}`,
      );
    }
    if (leg.bundle.permits.length === 0) {
      throw new IntentError("empty_bundle", `chain ${leg.chainId} has an empty bundle; CrossPermit rejects those`);
    }

    // The leaf is recomputed from the bundle, never taken from the payload. Then the proof must fold
    // it into exactly the root that was signed — that is the whole authorisation check, offline.
    //
    // Encoding is inside the try because this is a trust boundary: a malformed tokenKey or proof
    // node makes viem throw, and an unhandled throw here surfaces to an HTTP caller as a 500. A
    // caller that sent bad bytes deserves a 4xx telling them so, not a server error.
    let folded: Hex;
    try {
      folded = processProof(leafOf(leg.bundle), leg.proof);
    } catch (e) {
      throw new IntentError(
        "malformed",
        `chain ${leg.chainId}: bundle or proof could not be encoded (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`,
      );
    }
    if (folded.toLowerCase() !== i.root.toLowerCase()) {
      throw new IntentError("bad_proof", `chain ${leg.chainId}: proof folds to ${folded}, signed root is ${i.root}`);
    }
  }
}

/**
 * Who signed it. EOAs recover locally; contract accounts (Safe, 7702 delegate, any ERC-4337 wallet)
 * need the chain, so pass a client to cover them.
 *
 * Any chain will do for the ERC-1271 call in principle — the domain is chain-agnostic — but the
 * *account* is not deployed on every chain, so use the chain the caller actually cares about.
 */
export async function verifySigner(i: Intent, client?: PublicClient): Promise<void> {
  const typed = intentTypedData(i.crossPermit, i);

  const recovered = await recoverTypedDataAddress({ ...typed, signature: i.signature }).catch(() => null);
  if (recovered && recovered.toLowerCase() === i.owner.toLowerCase()) return;

  if (!client) {
    throw new IntentError(
      "bad_signature",
      `signature recovers to ${recovered ?? "nothing"}, not owner ${i.owner}` +
        " (no client given, so a contract account could not be checked)",
    );
  }

  const ok = await client.verifyTypedData({ ...typed, address: i.owner, signature: i.signature }).catch(() => false);
  if (!ok) throw new IntentError("bad_signature", `${i.owner} did not sign ${hashTypedData(typed)}`);
}

// ---------- Wire format ----------
//
// `bigint` does not survive JSON, and silently coercing to `number` would round a `uint160` amount.
// The wire form is therefore all-strings, and the converters are the only place that knows it.

export type WireEntry = { modeOrExpiration: number; tokenKey: Hex; account: Address; amountDelta: string };
export type WireLeg = { chainId: number; permits: WireEntry[]; proof: Hex[] };
export type WireIntent = Omit<Intent, "legs"> & { legs: WireLeg[] };

export const toWire = (i: Intent): WireIntent => ({
  ...i,
  legs: i.legs.map((l) => ({
    chainId: l.chainId,
    proof: l.proof,
    permits: l.bundle.permits.map((p) => ({ ...p, amountDelta: p.amountDelta.toString() })),
  })),
});

/**
 * Parse an intent off the wire. Shape-checks as it goes, because this is a trust boundary: the
 * relayer's HTTP handler and the dashboard both feed it whatever arrived.
 *
 * Note it rebuilds `bundle.chainId` from the leg rather than reading it from the payload. That
 * removes one way to express a contradiction; `validateIntent` still checks the rest.
 */
export function fromWire(raw: unknown): Intent {
  const o = raw as WireIntent;
  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string") throw new IntentError("malformed", `${name} must be a string, got ${typeof v}`);
    return v;
  };
  const int = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      throw new IntentError("malformed", `${name} must be a non-negative safe integer, got ${String(v)}`);
    }
    return v;
  };
  if (!o || typeof o !== "object") throw new IntentError("malformed", "intent must be an object");
  if (!Array.isArray(o.legs) || o.legs.length === 0) throw new IntentError("malformed", "legs must be a non-empty array");

  return {
    crossPermit: str(o.crossPermit, "crossPermit") as Address,
    owner: str(o.owner, "owner") as Address,
    salt: str(o.salt, "salt") as Hex,
    deadline: int(o.deadline, "deadline"),
    timestamp: int(o.timestamp, "timestamp"),
    root: str(o.root, "root") as Hex,
    signature: str(o.signature, "signature") as Hex,
    legs: o.legs.map((l, n) => {
      if (!Array.isArray(l?.permits)) throw new IntentError("malformed", `legs[${n}].permits must be an array`);
      if (!Array.isArray(l?.proof)) throw new IntentError("malformed", `legs[${n}].proof must be an array`);
      const chainId = int(l.chainId, `legs[${n}].chainId`);
      const permits: Entry[] = l.permits.map((p, m) => ({
        modeOrExpiration: int(p?.modeOrExpiration, `legs[${n}].permits[${m}].modeOrExpiration`),
        tokenKey: str(p?.tokenKey, `legs[${n}].permits[${m}].tokenKey`) as Hex,
        account: str(p?.account, `legs[${n}].permits[${m}].account`) as Address,
        amountDelta: BigInt(str(p?.amountDelta, `legs[${n}].permits[${m}].amountDelta`)),
      }));
      return { chainId, proof: l.proof.map((h, m) => str(h, `legs[${n}].proof[${m}]`) as Hex), bundle: { chainId: BigInt(chainId), permits } };
    }),
  };
}

// ---------- Building one ----------

/**
 * Turn per-chain permit entries into an unsigned intent plus the exact payload to sign.
 *
 * Leaf order is the caller's, and it matters: the tree is left-leaning, so the LAST leaf sits one
 * hop from the root and carries the shortest proof. Put the most expensive chain last.
 */
export function prepareIntent(a: {
  crossPermit: Address;
  owner: Address;
  chains: { chainId: number; permits: Entry[] }[];
  /** Seconds the signature stays valid. */
  ttl?: number;
  salt?: Hex;
  now?: number;
}): { intent: Omit<Intent, "signature">; typedData: ReturnType<typeof intentTypedData> } {
  if (a.chains.length === 0) throw new IntentError("no_legs", "an intent needs at least one chain");

  const now = a.now ?? Math.floor(Date.now() / 1000);
  const bundles = a.chains.map((c) => ({ chainId: BigInt(c.chainId), permits: c.permits }));
  const { root, proofs } = buildUnbalancedTree(bundles.map(leafOf));

  const intent: Omit<Intent, "signature"> = {
    crossPermit: a.crossPermit,
    owner: a.owner,
    salt: a.salt ?? randomSalt(),
    deadline: now + (a.ttl ?? 3600),
    timestamp: now,
    root,
    legs: a.chains.map((c, i) => ({ chainId: c.chainId, bundle: bundles[i]!, proof: proofs[i]! })),
  };

  return { intent, typedData: intentTypedData(intent.crossPermit, intent) };
}
