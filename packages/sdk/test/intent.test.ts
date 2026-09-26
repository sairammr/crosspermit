import { describe, expect, test } from "bun:test";
import { type Hex, privateKeyToAccount } from "viem/accounts";

import { approveEntry, buildUnbalancedTree, leafOf, lockEntry, processProof, transferEntry } from "../src/crosspermit.js";
import {
  type Intent,
  IntentError,
  fromWire,
  intentId,
  prepareIntent,
  toWire,
  validateIntent,
  verifySigner,
} from "../src/intent.js";

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const XP = "0x51cfFca7d52fafDC464E325618043f5f78Aa8648" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const ROUTER = "0x46C9fE6A6e0C3351b34730444891bef1b0C65d65" as const;
const NOW = 1_800_000_000;

/**
 * Assert on `IntentError.code`, not on the message. The code is the contract the relayer's HTTP
 * layer and the dashboard branch on; the message is prose and is allowed to be reworded.
 */
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof IntentError) return e.code;
    throw e;
  }
  throw new Error("expected a throw, got none");
};

const rejectCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof IntentError) return e.code;
    throw e;
  }
  throw new Error("expected a rejection, got none");
};

const threeChains = () =>
  prepareIntent({
    crossPermit: XP,
    owner: OWNER.address,
    now: NOW,
    ttl: 3600,
    salt: `0x${"11".repeat(32)}` as Hex,
    chains: [
      { chainId: 84532, permits: [approveEntry(USDC, ROUTER, 4_000_000n, NOW + 86_400)] },
      { chainId: 1301, permits: [approveEntry(USDC, ROUTER, 5_000_000n, NOW + 86_400)] },
      { chainId: 11155111, permits: [approveEntry(USDC, ROUTER, 6_000_000n, NOW + 86_400), lockEntry(USDC, ROUTER)] },
    ],
  });

const sign = async (intent: Omit<Intent, "signature">, typedData: Parameters<typeof OWNER.signTypedData>[0]) =>
  ({ ...intent, signature: await OWNER.signTypedData(typedData) }) as Intent;

describe("merkle", () => {
  test("every leaf's proof folds to the root, for every tree size 1..8", () => {
    for (let n = 1; n <= 8; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leafOf({ chainId: BigInt(i + 1), permits: [] }));
      const { root, proofs } = buildUnbalancedTree(leaves);
      expect(proofs).toHaveLength(n);
      leaves.forEach((leaf, i) => expect(processProof(leaf, proofs[i]!)).toBe(root));
    }
  });

  test("the last leaf carries the shortest proof, which is why the dearest chain goes last", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leafOf({ chainId: BigInt(i + 1), permits: [] }));
    const { proofs } = buildUnbalancedTree(leaves);
    expect(proofs[4]!.length).toBe(1);
    expect(proofs[0]!.length).toBeGreaterThan(1);
  });

  test("a different bundle gives a different leaf", () => {
    const a = leafOf({ chainId: 1n, permits: [transferEntry(USDC, ROUTER, 1n)] });
    const b = leafOf({ chainId: 1n, permits: [transferEntry(USDC, ROUTER, 2n)] });
    expect(a).not.toBe(b);
  });
});

describe("prepareIntent + validateIntent", () => {
  test("a freshly prepared, freshly signed intent validates", async () => {
    const { intent, typedData } = threeChains();
    const signed = await sign(intent, typedData);
    validateIntent(signed, { now: NOW });
    await verifySigner(signed);
  });

  test("a bundle swapped between legs breaks its proof", () => {
    const { intent } = threeChains();
    const tampered = {
      ...intent,
      signature: "0x" as Hex,
      legs: [{ ...intent.legs[0]!, bundle: intent.legs[1]!.bundle }, ...intent.legs.slice(1)],
    };
    // chain_mismatch fires first: the swapped bundle names chain 1301 while the leg is chain 84532.
    expect(["chain_mismatch", "bad_proof"]).toContain(codeOf(() => validateIntent(tampered, { now: NOW })));
  });

  test("an edited amount breaks the proof even with the chainId left alone", () => {
    const { intent } = threeChains();
    const leg = intent.legs[2]!;
    const permits = [{ ...leg.bundle.permits[0]!, amountDelta: 999_000_000n }, ...leg.bundle.permits.slice(1)];
    const tampered: Intent = {
      ...intent,
      signature: "0x",
      legs: [...intent.legs.slice(0, 2), { ...leg, bundle: { ...leg.bundle, permits } }],
    };
    expect(codeOf(() => validateIntent(tampered, { now: NOW }))).toBe("bad_proof");
  });

  test("a deadline inside the margin is refused before any gas is spent", async () => {
    const { intent, typedData } = threeChains();
    const signed = await sign(intent, typedData);
    expect(codeOf(() => validateIntent(signed, { now: signed.deadline - 30 }))).toBe("expired");
    validateIntent(signed, { now: signed.deadline - 120 });
  });

  test("the same chain twice is refused", () => {
    const { intent } = threeChains();
    const dup: Intent = { ...intent, signature: "0x", legs: [intent.legs[0]!, intent.legs[0]!] };
    expect(codeOf(() => validateIntent(dup, { now: NOW }))).toBe("duplicate_chain");
  });

  test("an empty bundle is refused, because CrossPermit reverts on one", () => {
    const empty = prepareIntent({ crossPermit: XP, owner: OWNER.address, now: NOW, chains: [{ chainId: 1, permits: [] }] });
    expect(codeOf(() => validateIntent({ ...empty.intent, signature: "0x" }, { now: NOW }))).toBe("empty_bundle");
  });

  test("someone else's signature does not pass as the owner's", async () => {
    const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const { intent, typedData } = threeChains();
    const signed: Intent = { ...intent, signature: await other.signTypedData(typedData) };
    validateIntent(signed, { now: NOW });
    expect(await rejectCode(verifySigner(signed))).toBe("bad_signature");
  });
});

describe("wire format", () => {
  test("round-trips, keeping uint160 amounts exact", async () => {
    const max160 = (1n << 160n) - 1n;
    const { intent, typedData } = prepareIntent({
      crossPermit: XP,
      owner: OWNER.address,
      now: NOW,
      salt: `0x${"22".repeat(32)}` as Hex,
      chains: [{ chainId: 8453, permits: [approveEntry(USDC, ROUTER, max160, NOW + 600)] }],
    });
    const signed = await sign(intent, typedData);

    const back = fromWire(JSON.parse(JSON.stringify(toWire(signed))));
    expect(back.legs[0]!.bundle.permits[0]!.amountDelta).toBe(max160);
    expect(back.root).toBe(signed.root);
    validateIntent(back, { now: NOW });
    await verifySigner(back);
  });

  test("rejects malformed input instead of coercing it", () => {
    expect(codeOf(() => fromWire({ legs: [] }))).toBe("malformed");
    expect(codeOf(() => fromWire({ owner: 1, legs: [{ chainId: 1, permits: [], proof: [] }] }))).toBe("malformed");
    expect(
      codeOf(() =>
        fromWire({
          crossPermit: XP,
          owner: OWNER.address,
          salt: "0x11",
          deadline: -1,
          timestamp: NOW,
          root: "0x00",
          signature: "0x",
          legs: [{ chainId: 1, permits: [], proof: [] }],
        }),
      ),
    ).toBe("malformed");
  });
});

describe("intentId", () => {
  test("is stable across signature malleability, and distinct per root", async () => {
    const { intent, typedData } = threeChains();
    const signed = await sign(intent, typedData);
    const id = intentId(signed);
    expect(intentId({ ...signed, signature: "0xdead" })).toBe(id);
    expect(intentId({ ...signed, root: `0x${"33".repeat(32)}` })).not.toBe(id);
    expect(intentId({ ...signed, owner: ROUTER })).not.toBe(id);
  });
});
