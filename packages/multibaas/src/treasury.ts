// CrossPermit on top of MultiBaas: the treasury control plane.
//
// The primitives here are the ones an institution actually asks for. Not "can you call a contract" —
// MultiBaas already does that — but: what authority is outstanding right now, to whom, on which
// chain; and can you show me the one signature that created it alongside every on-chain record it
// produced. That second question is what a risk committee asks, and answering it is the whole reason
// the control plane exists.
import type { Address, Hex } from "viem";

import { type EventQuery, type MultiBaasEvent, MultiBaas, type MultiBaasConfig, MultiBaasError } from "./client.js";

/**
 * The CrossPermit events worth indexing, by NAME — MultiBaas filters on the event name, not on the
 * full signature, and rejects a signature outright rather than ignoring it.
 */
export const CROSSPERMIT_EVENTS = {
  /** Every allowance grant, decrease, lock and unlock lands here. */
  permit: "Permit",
  /** NFT / multi-token variant, keyed by tokenKey rather than a clean address. */
  permitMultiToken: "PermitMultiToken",
  /** Direct lockdown, i.e. the owner calling the contract rather than signing for it. */
  lockdown: "Lockdown",
  /** A salt being burned, whether directly or through a signed cross-chain cancellation. */
  nonceInvalidated: "NonceInvalidated",
} as const;

/** The full signatures, for webhook subscriptions, which do take the signature form. */
export const CROSSPERMIT_EVENT_SIGNATURES = {
  permit: "Permit(address,address,address,uint160,uint48,uint48)",
  permitMultiToken: "PermitMultiToken(address,bytes32,address,uint160,uint48,uint48)",
  lockdown: "Lockdown(address,address,address)",
  nonceInvalidated: "NonceInvalidated(address,bytes32)",
} as const;

/**
 * One MultiBaas deployment serves one network, so a multichain treasury is a map keyed by chain id.
 *
 * Chains without a deployment are absent rather than broken: the relayer still serves them from its
 * own RPC and local signer, and `has()` is how a caller finds out which is which. Partial coverage is
 * the normal state — a free-tier account gets one deployment — and pretending otherwise would put a
 * gap in the audit trail that nobody was told about.
 */
export class Treasury {
  private readonly byChain = new Map<number, MultiBaas>();

  constructor(deployments: { chainId: number; config: MultiBaasConfig }[] = []) {
    for (const d of deployments) this.byChain.set(d.chainId, new MultiBaas(d.config));
  }

  /**
   * Build from the environment. `MULTIBAAS_URL`/`MULTIBAAS_API_KEY` cover the chain named by
   * `MULTIBAAS_CHAIN_ID`; additional chains use the suffixed form, e.g.
   * `MULTIBAAS_URL_84532` / `MULTIBAAS_API_KEY_84532`.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env, chainIds: number[] = []): Treasury {
    const out: { chainId: number; config: MultiBaasConfig }[] = [];

    const base = env.MULTIBAAS_URL?.trim();
    const baseKey = env.MULTIBAAS_API_KEY?.trim();
    const baseChain = Number(env.MULTIBAAS_CHAIN_ID ?? NaN);
    if (base && baseKey && Number.isFinite(baseChain)) {
      out.push({ chainId: baseChain, config: { url: base, apiKey: baseKey, chain: env.MULTIBAAS_CHAIN ?? "ethereum" } });
    }

    for (const id of chainIds) {
      const url = env[`MULTIBAAS_URL_${id}`]?.trim();
      const apiKey = env[`MULTIBAAS_API_KEY_${id}`]?.trim();
      if (url && apiKey && !out.some((o) => o.chainId === id)) {
        out.push({ chainId: id, config: { url, apiKey, chain: env[`MULTIBAAS_CHAIN_${id}`] ?? "ethereum" } });
      }
    }
    return new Treasury(out);
  }

  has = (chainId: number) => this.byChain.has(chainId);
  get = (chainId: number) => this.byChain.get(chainId);
  chains = () => [...this.byChain.keys()];

  /** One line per covered chain for the boot log, plus an explicit line about what is NOT covered. */
  async describe(allChainIds: number[]): Promise<string[]> {
    const lines: string[] = [];
    for (const [chainId, mb] of this.byChain) {
      lines.push(`  chain ${chainId}: ${await mb.describe().catch((e) => `unreachable (${e.message})`)}`);
    }
    const uncovered = allChainIds.filter((id) => !this.byChain.has(id));
    if (uncovered.length) lines.push(`  chains ${uncovered.join(", ")}: no MultiBaas deployment — local signer, no control-plane audit trail`);
    return lines;
  }

  /**
   * Register CrossPermit's ABI and link it to the deployed address, which is what starts event
   * indexing. Until this runs, every primitive below returns nothing — not because there is no
   * activity, but because nothing is being decoded. Idempotent: re-registering is a no-op.
   */
  async registerCrossPermit(a: {
    chainId: number;
    address: Address;
    abi: unknown;
    /** Creation bytecode. MultiBaas stores it NOT NULL, so registration fails without it. */
    bin: string;
    label?: string;
    startingBlock?: string;
  }) {
    const mb = this.byChain.get(a.chainId);
    if (!mb) throw new Error(`no MultiBaas deployment configured for chain ${a.chainId}`);
    const label = a.label ?? "crosspermit";

    // 409 means the label+version pair is already registered, which is success for our purposes.
    const existing = await mb.listContracts().catch(() => []);
    if (!existing.some((c) => c.label === label)) {
      await mb.createContract(label, {
        label,
        contractName: "CrossPermit",
        version: "1.0",
        // A JSON string, not an object: MultiBaas parses this field itself.
        rawAbi: typeof a.abi === "string" ? a.abi : JSON.stringify(a.abi),
        // MUST keep the 0x prefix. Without it MultiBaas answers "unable to parse JSON", which
        // reads like a malformed body rather than one bad field — worth an hour if you hit it cold.
        bin: a.bin.startsWith("0x") ? a.bin : `0x${a.bin}`,
      }).catch((e) => {
        if (e instanceof MultiBaasError && e.status === 409) return undefined;
        throw e;
      });
    }
    // Both of these are no-ops when they already exist, which is what makes registration idempotent.
    await mb.setAddress(label, a.address).catch(() => undefined);
    await mb.linkAddressContract(label, label, a.startingBlock ?? "latest").catch(() => undefined);
    return { chainId: a.chainId, label, address: a.address };
  }

  /**
   * The outstanding-authority view: for one owner, every (token, spender) pair and the last state
   * the chain recorded for it.
   *
   * Derived from `Permit` events rather than by reading storage, because storage answers "what is it
   * now" while the ledger has to answer "how did it get there" — and the event carries the
   * `timestamp` the owner signed, which is the ordering CrossPermit itself uses.
   *
   * Events are written by chains and decoded by MultiBaas: data, never instructions.
   */
  async allowanceLedger(chainId: number, owner: Address, limit = 500, label = "crosspermit"): Promise<AllowanceRow[]> {
    const mb = this.byChain.get(chainId);
    if (!mb) return [];

    const events = await mb.listAllEvents({ contractLabel: label, eventName: CROSSPERMIT_EVENTS.permit }, limit);
    const rows = new Map<string, AllowanceRow>();

    for (const e of events) {
      // The server-side eventName filter is not exact — asking for "Permit" also returns
      // NonceInvalidated, which has two inputs rather than six. Decoded positionally, its salt
      // lands in the token column and its missing fields become a zero allowance dated 1970.
      // A phantom row on a treasury screen is worse than a missing one, so the name and the shape
      // are both checked here rather than trusted from the query.
      if (e.event?.name !== CROSSPERMIT_EVENTS.permit) continue;
      if ((e.event?.inputs?.length ?? 0) !== 6) continue;

      const v = indexInputs(e);
      const evOwner = String(v.owner ?? v[0] ?? "");
      if (evOwner.toLowerCase() !== owner.toLowerCase()) continue;

      const token = String(v.token ?? v[1] ?? "");
      const spender = String(v.spender ?? v[2] ?? "");
      const key = `${token}:${spender}`.toLowerCase();
      const timestamp = Number(v.timestamp ?? v[5] ?? 0);

      // Last writer by the SIGNED timestamp, not by block order. Two chains can apply the same
      // signature in either order, and a later block carrying an older signature must not win.
      const prev = rows.get(key);
      if (prev && prev.timestamp > timestamp) continue;

      const expiration = Number(v.expiration ?? v[4] ?? 0);
      rows.set(key, {
        chainId,
        owner: evOwner as Address,
        token: token as Address,
        spender: spender as Address,
        amount: BigInt(String(v.amount ?? v[3] ?? 0)),
        expiration,
        timestamp,
        state: expiration === LOCKED_SENTINEL ? "locked" : expiration === 0 ? "unbounded" : "active",
        txHash: e.transaction?.txHash as Hex | undefined,
        blockNumber: e.transaction?.blockNumber,
      });
    }
    return [...rows.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  /** The same view across every covered chain — what a treasurer means by "our exposure". */
  async allowanceLedgerAllChains(owner: Address): Promise<AllowanceRow[]> {
    const per = await Promise.all(this.chains().map((id) => this.allowanceLedger(id, owner)));
    return per.flat();
  }

  /**
   * One signature, expanded into every on-chain record it produced.
   *
   * This is the screen that sells the product to a risk committee: an institution that signed once
   * can show the auditor the N transactions that signature authorised, on N chains, without
   * reconciling N separate approval logs.
   */
  async auditIntent(a: { owner: Address; txHashes: Partial<Record<number, Hex>> }): Promise<IntentAuditRow[]> {
    const out: IntentAuditRow[] = [];
    for (const [chainIdStr, txHash] of Object.entries(a.txHashes)) {
      const chainId = Number(chainIdStr);
      const mb = this.byChain.get(chainId);
      if (!txHash) continue;
      if (!mb) {
        out.push({ chainId, txHash, indexed: false, events: [], note: "no MultiBaas deployment for this chain" });
        continue;
      }
      const events = await mb.listAllEvents({ txHash }, 100).catch(() => []);
      out.push({ chainId, txHash, indexed: true, events: events.map(summarise) });
    }
    return out;
  }

  /**
   * Subscribe to CrossPermit activity. The receiving endpoint MUST verify the HMAC before parsing
   * the body — see `verifyWebhook`.
   */
  async watchCrossPermit(chainId: number, url: string, events: string[] = Object.values(CROSSPERMIT_EVENT_SIGNATURES)) {
    const mb = this.byChain.get(chainId);
    if (!mb) throw new Error(`no MultiBaas deployment configured for chain ${chainId}`);
    return mb.createWebhook(url, events);
  }

  /**
   * A saved event query for the dashboard, so the UI and the ledger above read one definition rather
   * than two reducers that can drift apart.
   */
  async installAllowanceQuery(chainId: number, label = "crosspermit_allowances") {
    const mb = this.byChain.get(chainId);
    if (!mb) throw new Error(`no MultiBaas deployment configured for chain ${chainId}`);
    const query: EventQuery = {
      events: [
        {
          eventName: CROSSPERMIT_EVENT_SIGNATURES.permit,
          select: [
            { name: "owner", type: "input", alias: "owner", inputIndex: 0 },
            { name: "token", type: "input", alias: "token", inputIndex: 1 },
            { name: "spender", type: "input", alias: "spender", inputIndex: 2 },
            { name: "amount", type: "input", alias: "amount", inputIndex: 3 },
            { name: "expiration", type: "input", alias: "expiration", inputIndex: 4 },
            { name: "timestamp", type: "input", alias: "signed_at", inputIndex: 5 },
            { name: "triggered_at", type: "event_field", alias: "seen_at" },
          ],
        },
      ],
      orderBy: "signed_at DESC",
    };
    return mb.setQuery(label, query);
  }
}

/** `AllowanceLedger.LOCKED_ALLOWANCE` — the expiration value CrossPermit uses to mean "locked". */
export const LOCKED_SENTINEL = 2;

export type AllowanceRow = {
  chainId: number;
  owner: Address;
  token: Address;
  spender: Address;
  amount: bigint;
  expiration: number;
  /** The timestamp the OWNER signed, which is the ordering CrossPermit applies. */
  timestamp: number;
  state: "active" | "locked" | "unbounded";
  txHash?: Hex;
  blockNumber?: number;
};

export type IntentAuditRow = {
  chainId: number;
  txHash: Hex;
  indexed: boolean;
  events: { name: string; values: Record<string, unknown> }[];
  note?: string;
};

/** MultiBaas returns event inputs as a positional array with names; index it both ways. */
function indexInputs(e: MultiBaasEvent): Record<string | number, unknown> {
  const out: Record<string | number, unknown> = {};
  e.event?.inputs?.forEach((input, i) => {
    out[i] = input.value;
    if (input.name) out[input.name] = input.value;
  });
  return out;
}

const summarise = (e: MultiBaasEvent) => ({ name: e.event?.name ?? "unknown", values: indexInputs(e) });
