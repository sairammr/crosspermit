import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { type Intent, IntentError, approveEntry, prepareIntent } from "@crosspermit/sdk";
import type { Signer } from "@crosspermit/multibaas";

import type { ChainRuntime, RelayerConfig } from "../src/config.js";
import { Admission } from "../src/admission.js";
import { Relayer } from "../src/relayer.js";
import { Store } from "../src/store.js";

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const XP = "0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B" as Address;
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const ROUTER = "0xd72f799E1af27E0d95aB4B9658A277A7811Fbcd0" as Address;

/** Counts what the engine actually did, so a test can assert "submitted once", not "looked fine". */
type FakeChain = { simulations: number; sends: Hex[]; failSimulation?: string; failSend?: string };

function harness(chainIds: number[], opts: { crossPermit?: Address } = {}) {
  const fakes = new Map<number, FakeChain>();
  const chains = new Map<number, ChainRuntime>();

  for (const chainId of chainIds) {
    const fake: FakeChain = { simulations: 0, sends: [] };
    fakes.set(chainId, fake);

    const signer: Signer = {
      address: "0x9673afB923d556979E4dfe6854d8C6e2D9994Eb4" as Address,
      custody: "local",
      async send(tx) {
        if (fake.failSend) throw new Error(fake.failSend);
        const hash = `0x${(fake.sends.length + 1).toString(16).padStart(64, "0")}` as Hex;
        fake.sends.push(tx.data);
        return hash;
      },
    };

    const client = {
      async call() {
        fake.simulations++;
        if (fake.failSimulation) throw new Error(fake.failSimulation);
        return { data: "0x" as Hex };
      },
      async waitForTransactionReceipt() {
        return { status: "success" as const };
      },
      async verifyTypedData() {
        return false; // contract accounts are not part of these cases
      },
    } as unknown as PublicClient;

    chains.set(chainId, { chainId, name: `chain-${chainId}`, rpcUrl: "", client, signer, queue: Promise.resolve() });
  }

  const dbPath = join(tmpdir(), `cp-relayer-${crypto.randomUUID()}.sqlite`);
  const store = new Store(dbPath);
  const config: RelayerConfig = {
    port: 0,
    crossPermit: opts.crossPermit ?? XP,
    chains,
    treasury: { has: () => false, get: () => undefined, chains: () => [], describe: async () => [] } as never,
    account: null,
    dbPath,
    minSecondsLeft: 60,
  };
  return { relayer: new Relayer(config, store), store, fakes, dbPath };
}

const dbs: string[] = [];
afterEach(() => {
  for (const p of dbs.splice(0)) {
    try {
      rmSync(p, { force: true });
      rmSync(`${p}-wal`, { force: true });
      rmSync(`${p}-shm`, { force: true });
    } catch {
      // a leftover temp file is not worth failing a test over
    }
  }
});

async function signedIntent(chainIds: number[], crossPermit: Address = XP): Promise<Intent> {
  const now = Math.floor(Date.now() / 1000);
  const { intent, typedData } = prepareIntent({
    crossPermit,
    owner: OWNER.address,
    now,
    ttl: 3600,
    chains: chainIds.map((chainId) => ({
      chainId,
      permits: [approveEntry(TOKEN, ROUTER, 1_000_000n, now + 86_400)],
    })),
  });
  return { ...intent, signature: await OWNER.signTypedData(typedData) };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof IntentError) return e.code;
    throw e;
  }
  throw new Error("expected a rejection, got none");
};

describe("fan-out", () => {
  test("one signed intent submits exactly once per chain", async () => {
    const { relayer, fakes, dbPath } = harness([84532, 1301, 11155111]);
    dbs.push(dbPath);

    const res = await relayer.submit(await signedIntent([84532, 1301, 11155111]), { wait: true });
    expect(res.accepted).toBe(true);

    const status = relayer.status(res.id)!;
    expect(status.done).toBe(true);
    expect(status.ok).toBe(true);
    expect(status.legs).toHaveLength(3);
    for (const fake of fakes.values()) {
      expect(fake.sends).toHaveLength(1);
      expect(fake.simulations).toBe(1);
    }
  });

  test("each chain gets the calldata for ITS OWN leg, never another chain's", async () => {
    const { relayer, fakes, dbPath } = harness([84532, 1301]);
    dbs.push(dbPath);
    await relayer.submit(await signedIntent([84532, 1301]), { wait: true });

    const sent = [...fakes.values()].map((f) => f.sends[0]!);
    // Different chainIds produce different bundles and different proofs, so identical calldata on
    // two chains would mean a leg was sent to the wrong one — the mistake this asserts against.
    expect(sent[0]).not.toBe(sent[1]);
  });
});

describe("idempotency", () => {
  test("re-submitting the same signed intent does not broadcast again", async () => {
    const { relayer, fakes, dbPath } = harness([84532]);
    dbs.push(dbPath);
    const intent = await signedIntent([84532]);

    const first = await relayer.submit(intent, { wait: true });
    const second = await relayer.submit(intent, { wait: true });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(fakes.get(84532)!.sends).toHaveLength(1);
  });

  test("two concurrent submissions of the same intent still broadcast once", async () => {
    const { relayer, fakes, dbPath } = harness([84532]);
    dbs.push(dbPath);
    const intent = await signedIntent([84532]);

    const [a, b] = await Promise.all([relayer.submit(intent, { wait: true }), relayer.submit(intent, { wait: true })]);
    expect([a.accepted, b.accepted].filter(Boolean)).toHaveLength(1);
    expect(fakes.get(84532)!.sends).toHaveLength(1);
  });
});

describe("refusing to spend gas", () => {
  test("a bundle that would revert is never broadcast", async () => {
    const { relayer, fakes, dbPath } = harness([84532]);
    dbs.push(dbPath);
    fakes.get(84532)!.failSimulation = "NonceAlreadyUsed";

    const res = await relayer.submit(await signedIntent([84532]), { wait: true });
    expect(fakes.get(84532)!.sends).toHaveLength(0);
    expect(relayer.status(res.id)!.legs[0]!.status).toBe("failed");
    expect(relayer.status(res.id)!.legs[0]!.error).toContain("simulation reverted");
  });

  test("an intent for an unserved chain is refused whole, not served in part", async () => {
    const { relayer, fakes, dbPath } = harness([84532]);
    dbs.push(dbPath);
    // 1301 is in the intent but not in this relayer's chain set.
    expect(await codeOf(relayer.submit(await signedIntent([84532, 1301])))).toBe("unserved_chain");
    expect(fakes.get(84532)!.sends).toHaveLength(0);
  });

  test("an intent for another CrossPermit deployment is refused", async () => {
    const { relayer, dbPath } = harness([84532]);
    dbs.push(dbPath);
    const other = "0x51cfFca7d52fafDC464E325618043f5f78Aa8648" as Address;
    expect(await codeOf(relayer.submit(await signedIntent([84532], other)))).toBe("wrong_contract");
  });

  test("a tampered bundle is refused before any simulation", async () => {
    const { relayer, fakes, dbPath } = harness([84532]);
    dbs.push(dbPath);
    const intent = await signedIntent([84532]);
    const leg = intent.legs[0]!;
    const tampered: Intent = {
      ...intent,
      legs: [{ ...leg, bundle: { ...leg.bundle, permits: [{ ...leg.bundle.permits[0]!, amountDelta: 10n ** 12n }] } }],
    };
    expect(await codeOf(relayer.submit(tampered))).toBe("bad_proof");
    expect(fakes.get(84532)!.simulations).toBe(0);
  });

  test("someone else's signature is refused", async () => {
    const { relayer, fakes, dbPath } = harness([84532]);
    dbs.push(dbPath);
    const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const now = Math.floor(Date.now() / 1000);
    const { intent, typedData } = prepareIntent({
      crossPermit: XP,
      owner: OWNER.address,
      now,
      chains: [{ chainId: 84532, permits: [approveEntry(TOKEN, ROUTER, 1n, now + 3600)] }],
    });
    const forged: Intent = { ...intent, signature: await other.signTypedData(typedData) };

    expect(await codeOf(relayer.submit(forged))).toBe("bad_signature");
    expect(fakes.get(84532)!.sends).toHaveLength(0);
  });
});

describe("events", () => {
  test("every leg emits, and the stream reaches a terminal state", async () => {
    const { relayer, dbPath } = harness([84532, 1301]);
    dbs.push(dbPath);
    const intent = await signedIntent([84532, 1301]);

    const seen: string[] = [];
    const id = (await relayer.submit(intent, { wait: false })).id;
    relayer.on(id, (e) => seen.push(`${e.chainId}:${e.status}`));

    // Let the queued legs drain.
    for (let i = 0; i < 50 && !relayer.status(id)?.done; i++) await new Promise((r) => setTimeout(r, 20));

    expect(relayer.status(id)!.done).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("admission", () => {
  const cfg = () => ({
    apiKeys: new Set(["good-key"]),
    maxIntentsPerWindow: 3,
    windowMs: 60_000,
    maxGasWeiPerWindow: 1_000n,
  });

  test("an open relayer accepts anyone, and says so", () => {
    const a = new Admission({ ...cfg(), apiKeys: new Set() });
    expect(a.open).toBe(true);
    expect(a.checkKey(null).ok).toBe(true);
  });

  test("a keyed relayer refuses a missing or wrong key", () => {
    const a = new Admission(cfg());
    expect(a.open).toBe(false);
    expect(a.checkKey(null)).toMatchObject({ ok: false, code: "no_api_key", status: 401 });
    expect(a.checkKey("nope")).toMatchObject({ ok: false, code: "bad_api_key", status: 401 });
    expect(a.checkKey("good-key").ok).toBe(true);
    // Same length as the real key, so this fails on content rather than on the length short-circuit.
    expect(a.checkKey("good-kez")).toMatchObject({ ok: false, code: "bad_api_key" });
  });

  test("rate limits per owner, and limits are independent between owners", () => {
    const a = new Admission(cfg());
    const alice = "0x1111111111111111111111111111111111111111" as Address;
    const bob = "0x2222222222222222222222222222222222222222" as Address;

    for (let i = 0; i < 3; i++) {
      expect(a.checkOwner(alice).ok).toBe(true);
      a.recordIntent(alice);
    }
    expect(a.checkOwner(alice)).toMatchObject({ ok: false, code: "rate_limited", status: 429 });
    // Bob is untouched by Alice's flood — otherwise one caller could deny service to everyone.
    expect(a.checkOwner(bob).ok).toBe(true);
  });

  test("an exhausted gas budget stops further intents", () => {
    const a = new Admission(cfg());
    const alice = "0x1111111111111111111111111111111111111111" as Address;
    expect(a.checkOwner(alice).ok).toBe(true);
    a.chargeGas(alice, 1_500n);
    expect(a.checkOwner(alice)).toMatchObject({ ok: false, code: "gas_budget_exhausted" });
  });

  test("the window rolls over", () => {
    const a = new Admission({ ...cfg(), windowMs: 1 });
    const alice = "0x1111111111111111111111111111111111111111" as Address;
    for (let i = 0; i < 3; i++) a.recordIntent(alice);
    expect(a.checkOwner(alice).ok).toBe(false);
    Bun.sleepSync(5);
    expect(a.checkOwner(alice).ok).toBe(true);
  });
});
