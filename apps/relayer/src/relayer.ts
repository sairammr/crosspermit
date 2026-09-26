// The engine: one validated intent in, N chains submitted, events out.
//
// What the relayer can and cannot do, stated once so the code below can be read against it:
//
//   It can        pay gas, order its own submissions, and refuse to submit.
//   It cannot     change who receives a transfer, who gets an allowance, or how much — all of that
//                 is inside the bundle the owner signed, and the merkle proof binds every leg to
//                 that one signature.
//   It must not   be load-bearing. Every flow stays completable by the client alone; the relayer is
//                 a convenience for gas, never a dependency. That is what keeps it non-custodial.
import { type Hex, encodeFunctionData } from "viem";

import { type Intent, IntentError, crossPermitAbi, intentId, validateIntent, verifySigner } from "@crosspermit/sdk";

import type { ChainRuntime, RelayerConfig } from "./config.js";
import type { LegRow, Store } from "./store.js";

export type LegEvent = {
  intentId: string;
  chainId: number;
  status: LegRow["status"];
  txHash?: Hex;
  error?: string;
  explorer?: string;
};

type Listener = (e: LegEvent) => void;

export class Relayer {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly config: RelayerConfig,
    private readonly store: Store,
  ) {}

  on(id: string, fn: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(id, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  private emit(e: LegEvent) {
    for (const fn of this.listeners.get(e.intentId) ?? []) {
      try {
        fn(e);
      } catch {
        // A broken SSE subscriber must not take down a submission that is already in flight.
      }
    }
  }

  /**
   * Everything that can be decided without spending gas. Throws `IntentError` with a code the HTTP
   * layer maps to a 4xx — a bad intent is the client's problem, not a server error.
   */
  async validate(intent: Intent): Promise<void> {
    if (intent.crossPermit.toLowerCase() !== this.config.crossPermit.toLowerCase()) {
      throw new IntentError(
        "wrong_contract",
        `intent targets ${intent.crossPermit}, this relayer serves ${this.config.crossPermit}`,
      );
    }

    // Offline: proofs fold to the signed root, each bundle names its own chain, deadline has margin.
    validateIntent(intent, { minSecondsLeft: this.config.minSecondsLeft });

    const unserved = intent.legs.filter((l) => !this.config.chains.has(l.chainId)).map((l) => l.chainId);
    if (unserved.length) {
      // Refuse the whole intent rather than serving it partly. A caller who thinks all N chains are
      // covered and silently gets N-1 has a hole in their permission set and no way to notice.
      throw new IntentError("unserved_chain", `this relayer does not serve chain(s) ${unserved.join(", ")}`);
    }

    // Signature last: it is the only check that may need a network round trip (ERC-1271).
    const anyChain = this.config.chains.get(intent.legs[0]!.chainId)!;
    await verifySigner(intent, anyChain.client);
  }

  /** Calldata for one leg. Identical to what the client would send if it submitted the leg itself. */
  private calldata(intent: Intent, leg: Intent["legs"][number]): Hex {
    return encodeFunctionData({
      abi: crossPermitAbi,
      functionName: "permit",
      args: [intent.owner, intent.salt, intent.deadline, intent.timestamp, leg.bundle, leg.proof, intent.signature],
    });
  }

  /**
   * Accept an intent and start fanning it out.
   *
   * Returns `{ accepted: false }` for a replay, with the existing legs — the same signed intent
   * submitted twice must never produce two sets of transactions.
   */
  async submit(intent: Intent, opts: { wait?: boolean } = {}): Promise<{ id: string; accepted: boolean; legs: LegRow[] }> {
    await this.validate(intent);

    const id = intentId(intent);
    const accepted = this.store.create(
      {
        intentId: id,
        owner: intent.owner,
        root: intent.root,
        salt: intent.salt,
        deadline: intent.deadline,
        payload: JSON.stringify({ legs: intent.legs.map((l) => l.chainId) }),
        createdAt: Date.now(),
      },
      intent.legs.map((l) => l.chainId),
    );

    if (!accepted) return { id, accepted: false, legs: this.store.legs(id) };

    // Each chain runs on its own serialised queue, so legs proceed in parallel across chains while
    // never racing a nonce within one chain.
    const runs = intent.legs.map((leg) => {
      const chain = this.config.chains.get(leg.chainId)!;
      const run = chain.queue.then(() => this.runLeg(id, intent, leg, chain));
      // Swallow here so one chain's failure cannot reject the shared queue promise and strand the
      // legs queued behind it; the failure is already recorded on the leg row.
      chain.queue = run.catch(() => undefined);
      return run;
    });

    if (opts.wait) await Promise.allSettled(runs);
    return { id, accepted: true, legs: this.store.legs(id) };
  }

  private async runLeg(id: string, intent: Intent, leg: Intent["legs"][number], chain: ChainRuntime): Promise<void> {
    if (!this.store.claim(id, leg.chainId)) return; // another worker owns it
    const data = this.calldata(intent, leg);

    try {
      // Simulate before broadcast, always. A bundle that would revert — a burnt salt, a lock, a
      // deadline that passed while the intent sat in the queue — costs the relayer real gas and
      // returns the caller nothing. Rejecting here turns a paid failure into a free one.
      await chain.client.call({ account: chain.signer.address, to: intent.crossPermit, data });
    } catch (e) {
      const why = shortReason(e);
      this.store.finish(id, leg.chainId, "failed", null, `simulation reverted: ${why}`);
      this.emit({ intentId: id, chainId: leg.chainId, status: "failed", error: `simulation reverted: ${why}` });
      return;
    }

    let txHash: Hex;
    try {
      txHash = await chain.signer.send({ to: intent.crossPermit, data });
    } catch (e) {
      const why = shortReason(e);
      this.store.finish(id, leg.chainId, "failed", null, `submit failed: ${why}`);
      this.emit({ intentId: id, chainId: leg.chainId, status: "failed", error: `submit failed: ${why}` });
      return;
    }

    this.store.finish(id, leg.chainId, "submitted", txHash, null);
    this.emit({
      intentId: id,
      chainId: leg.chainId,
      status: "submitted",
      txHash,
      explorer: chain.explorer ? `${chain.explorer}/tx/${txHash}` : undefined,
    });

    try {
      const receipt = await chain.client.waitForTransactionReceipt({ hash: txHash });
      const ok = receipt.status === "success";
      this.store.finish(id, leg.chainId, ok ? "confirmed" : "failed", txHash, ok ? null : "transaction reverted");
      this.emit({
        intentId: id,
        chainId: leg.chainId,
        status: ok ? "confirmed" : "failed",
        txHash,
        ...(ok ? {} : { error: "transaction reverted" }),
        explorer: chain.explorer ? `${chain.explorer}/tx/${txHash}` : undefined,
      });
    } catch (e) {
      // The transaction is broadcast; we just could not watch it. Say exactly that — "failed" here
      // would be a lie that invites a resubmission of a permit that may well be landing.
      this.store.finish(id, leg.chainId, "submitted", txHash, `broadcast, but the receipt was not seen: ${shortReason(e)}`);
    }
  }

  status(id: string) {
    const intent = this.store.intent(id);
    if (!intent) return null;
    const legs = this.store.legs(id);
    const done = legs.every((l) => l.status === "confirmed" || l.status === "failed");
    return {
      intentId: id,
      owner: intent.owner,
      root: intent.root,
      deadline: intent.deadline,
      done,
      ok: done && legs.every((l) => l.status === "confirmed"),
      legs: legs.map((l) => ({
        ...l,
        explorer: l.txHash ? `${this.config.chains.get(l.chainId)?.explorer ?? ""}/tx/${l.txHash}` : undefined,
      })),
    };
  }
}

/** Revert reasons come back wrapped in several layers of viem error; take the useful line. */
function shortReason(e: unknown): string {
  const any = e as { shortMessage?: string; details?: string; message?: string };
  return (any?.shortMessage ?? any?.details ?? any?.message ?? String(e)).split("\n")[0]!.slice(0, 300);
}
