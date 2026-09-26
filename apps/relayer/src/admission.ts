// Who may spend the relayer's gas, and how much of it.
//
// Validation and simulation stop intents that CANNOT land. They do nothing about a stream of
// intents that all land perfectly and drain the gas budget one cheap permit at a time — the caller
// gets real allowances, the relayer gets the bill. That is the hole this file closes.
//
// Three independent limits, because they fail differently:
//   key       who is allowed to ask at all
//   rate      how often any one owner may ask
//   budget    how much gas the relayer will spend on an owner before it stops
import type { Address } from "viem";

export type AdmissionConfig = {
  /** Accepted API keys. Empty set means open — allowed, but logged loudly at boot. */
  apiKeys: Set<string>;
  /** Max intents per owner per window. */
  maxIntentsPerWindow: number;
  windowMs: number;
  /** Max wei of gas the relayer will spend for one owner per window. */
  maxGasWeiPerWindow: bigint;
};

export function admissionFromEnv(env: Record<string, string | undefined> = process.env): AdmissionConfig {
  const keys = (env.RELAYER_API_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    apiKeys: new Set(keys),
    maxIntentsPerWindow: Number(env.RELAYER_MAX_INTENTS_PER_WINDOW ?? 20),
    windowMs: Number(env.RELAYER_WINDOW_MS ?? 60_000),
    maxGasWeiPerWindow: BigInt(env.RELAYER_MAX_GAS_WEI_PER_WINDOW ?? 10n ** 17n), // 0.1 ETH
  };
}

export type Decision = { ok: true } | { ok: false; code: string; message: string; status: number };

type Window = { started: number; intents: number; gasWei: bigint };

export class Admission {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly config: AdmissionConfig) {}

  get open(): boolean {
    return this.config.apiKeys.size === 0;
  }

  /**
   * Constant-time API key check.
   *
   * A plain `Set.has` on a secret leaks timing, and `===` on strings leaks the position of the first
   * differing byte. Neither matters much for a short-lived relayer key, but the correct comparison
   * costs nothing here, so there is no reason to take the flimsier one.
   */
  checkKey(presented: string | null): Decision {
    if (this.open) return { ok: true };
    if (!presented) {
      return { ok: false, status: 401, code: "no_api_key", message: "an API key is required" };
    }
    let matched = false;
    for (const key of this.config.apiKeys) matched = constantTimeEqual(key, presented) || matched;
    return matched
      ? { ok: true }
      : { ok: false, status: 401, code: "bad_api_key", message: "unrecognised API key" };
  }

  /**
   * Rate and budget, per owner.
   *
   * Keyed on the intent OWNER rather than on the API key or the socket, because the owner is the
   * only identity the signature actually proves. A key can be shared and an IP can be rotated; an
   * owner cannot submit an intent they did not sign.
   */
  checkOwner(owner: Address): Decision {
    const w = this.window(owner);
    if (w.intents >= this.config.maxIntentsPerWindow) {
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        message: `${owner} has submitted ${w.intents} intents in this window; limit is ${this.config.maxIntentsPerWindow}`,
      };
    }
    if (w.gasWei >= this.config.maxGasWeiPerWindow) {
      return {
        ok: false,
        status: 429,
        code: "gas_budget_exhausted",
        message: `gas budget for ${owner} is spent for this window`,
      };
    }
    return { ok: true };
  }

  /** Count an accepted intent against the owner's window. */
  recordIntent(owner: Address): void {
    this.window(owner).intents += 1;
  }

  /**
   * Charge gas actually spent back to the owner's budget.
   *
   * Charged AFTER the fact from the receipt rather than estimated up front: an estimate that is too
   * low lets the budget be overspent, and one that is too high refuses work the relayer could have
   * afforded. The cost of charging late is that one intent can overshoot the budget, never more.
   */
  chargeGas(owner: Address, wei: bigint): void {
    this.window(owner).gasWei += wei;
  }

  /** What an owner has left, for the status endpoint. */
  remaining(owner: Address): { intents: number; gasWei: string; resetsInMs: number } {
    const w = this.window(owner);
    return {
      intents: Math.max(0, this.config.maxIntentsPerWindow - w.intents),
      gasWei: (this.config.maxGasWeiPerWindow - w.gasWei).toString(),
      resetsInMs: Math.max(0, w.started + this.config.windowMs - Date.now()),
    };
  }

  private window(owner: Address): Window {
    const key = owner.toLowerCase();
    const now = Date.now();
    const existing = this.windows.get(key);
    if (existing && now - existing.started < this.config.windowMs) return existing;

    // Sweep expired windows while we are here, so a relayer facing many distinct owners does not
    // grow this map without bound.
    if (this.windows.size > 10_000) {
      for (const [k, v] of this.windows) if (now - v.started >= this.config.windowMs) this.windows.delete(k);
    }
    const fresh: Window = { started: now, intents: 0, gasWei: 0n };
    this.windows.set(key, fresh);
    return fresh;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
