// MultiBaas (Curvegrid) REST client.
//
// A thin typed wrapper over `/api/v0`, not the generated SDK: the surface CrossPermit needs is about
// fifteen endpoints, and the generated client drags in axios plus thirty-odd transitive packages
// whose signatures shift between releases. `fetch` is already here.
//
// One MultiBaas deployment serves ONE network, so a multichain treasury keeps one `MultiBaas` per
// chain id. `Treasury` in treasury.ts holds that map; nothing below knows about more than one chain.
export type MultiBaasConfig = {
  /** Deployment URL, e.g. https://<id>.multibaas.com — no trailing /api/v0. */
  url: string;
  apiKey: string;
  /** MultiBaas's own alias for the deployment's chain. "ethereum" for every EVM deployment. */
  chain?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
};

/** Read config from the environment. Returns null when unset — the caller then runs local-only. */
export function multibaasFromEnv(env: Record<string, string | undefined> = process.env): MultiBaasConfig | null {
  const url = env.MULTIBAAS_URL?.trim();
  const apiKey = env.MULTIBAAS_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), apiKey, chain: env.MULTIBAAS_CHAIN?.trim() || "ethereum" };
}

export class MultiBaasError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "MultiBaasError";
  }
}

type Envelope<T> = { status: number; message: string; result: T };

/** Every field that comes back is untrusted input, addresses included. Nothing here is a capability. */
export class MultiBaas {
  readonly chain: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(cfg: MultiBaasConfig) {
    this.url = cfg.url.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.chain = cfg.chain ?? "ethereum";
    this.timeoutMs = cfg.timeoutMs ?? 20_000;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/api/v0${path}`, {
        method,
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        // A 404 from the ingress is plain text, not JSON. Report the status, not a parse error.
        throw new MultiBaasError(res.status, path, `${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
      }

      const env = parsed as Envelope<T> | undefined;
      if (!res.ok) {
        throw new MultiBaasError(res.status, path, `${method} ${path}: ${env?.message ?? res.statusText}`, parsed);
      }
      return env!.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private get = <T>(p: string) => this.request<T>("GET", p);
  private post = <T>(p: string, b?: unknown) => this.request<T>("POST", p, b ?? {});
  private put = <T>(p: string, b?: unknown) => this.request<T>("PUT", p, b ?? {});
  private del = <T>(p: string) => this.request<T>("DELETE", p);

  private q(params: Record<string, string | number | boolean | undefined>): string {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : "";
  }

  // ---------- identity ----------

  /** Who this API key acts as, and which groups it belongs to. Log it at boot — see `describe`. */
  currentUser = () => this.get<{ id: number; email: string; name: string; groups: { name: string }[] }>("/currentuser");

  /** One line for the boot log, so nobody has to guess which deployment or identity is in play. */
  async describe(): Promise<string> {
    const [user, status] = await Promise.all([this.currentUser(), this.chainStatus()]);
    const groups = user.groups?.map((g) => g.name).join(",") ?? "?";
    return `${this.url} as ${user.email} [${groups}] on chainId ${status.chainID} @ block ${status.blockNumber}`;
  }

  // ---------- chain ----------

  chainStatus = () =>
    this.get<{ chainID: number; networkID: number; blockNumber: number; version: string; baseFee: string }>(
      `/chains/${this.chain}/status`,
    );

  block = (idOrHash: string | number) => this.get<Record<string, unknown>>(`/chains/${this.chain}/blocks/${idOrHash}`);
  transaction = (hash: string) => this.get<Record<string, unknown>>(`/chains/${this.chain}/transactions/${hash}`);
  receipt = (hash: string) => this.get<Record<string, unknown>>(`/chains/${this.chain}/transactions/${hash}/receipt`);

  /**
   * Broadcast a transaction this process already signed.
   *
   * This is the seam that keeps a local-key deployment on the same code path as a Cloud Wallet one:
   * sign wherever the key lives, submit through MultiBaas either way, so the transaction lands in
   * the same audit trail regardless of custody.
   */
  submitSignedTransaction = (signedTx: string) =>
    this.post<{ tx: { hash: string } } | { hash: string }>(`/chains/${this.chain}/submit`, { signedTx });

  // ---------- contracts ----------

  listContracts = () => this.get<{ label: string; contractName: string; version: string }[]>("/contracts");
  getContract = (label: string, version = "latest") => this.get<Record<string, unknown>>(`/contracts/${label}/${version}`);

  /**
   * Register an ABI so MultiBaas can decode this contract's calls and index its events.
   *
   * For CrossPermit this is what turns raw logs into a queryable allowance ledger: once the ABI is
   * known, `Permit` and `Lockdown` become rows an auditor can filter, not calldata to decode by hand.
   */
  createContract = (label: string, body: ContractRegistration) =>
    this.post<Record<string, unknown>>(`/contracts/${label}`, body);

  deleteContract = (label: string) => this.del<unknown>(`/contracts/${label}`);

  /**
   * Point a registered ABI at a deployed address, which is what starts event indexing for it.
   *
   * `startingBlock` accepts "latest", an absolute block number, or a relative one such as "-10000".
   * It is the difference between a ledger that begins today and one that backfills history, so it is
   * a deliberate argument rather than a default.
   */
  linkAddressContract = (addressOrAlias: string, contract: string, startingBlock?: string, version?: string) =>
    this.post<Record<string, unknown>>(`/chains/${this.chain}/addresses/${addressOrAlias}/contracts`, {
      label: contract,
      ...(version === undefined ? {} : { version }),
      ...(startingBlock === undefined ? {} : { startingBlock }),
    });

  unlinkAddressContract = (addressOrAlias: string, contract: string) =>
    this.del<unknown>(`/chains/${this.chain}/addresses/${addressOrAlias}/contracts/${contract}`);

  /**
   * Call a contract method. `signAndSubmit: false` is a read; `true` signs with the configured
   * signer and broadcasts, which is the Cloud Wallet path.
   */
  callMethod = (
    addressOrAlias: string,
    contract: string,
    method: string,
    args: unknown[],
    opts: { from?: string; signAndSubmit?: boolean; signer?: string; value?: string; nonce?: number } = {},
  ) =>
    this.post<{ output?: unknown; tx?: Record<string, unknown>; submitted?: boolean }>(
      `/chains/${this.chain}/addresses/${addressOrAlias}/contracts/${contract}/methods/${method}`,
      { args, ...opts },
    );

  // ---------- addresses ----------

  listAddresses = () => this.get<{ alias: string; address: string; label?: string }[]>(`/chains/${this.chain}/addresses`);
  getAddress = (addressOrAlias: string) =>
    this.get<{ alias: string; address: string }>(`/chains/${this.chain}/addresses/${addressOrAlias}`);
  setAddress = (alias: string, address: string) =>
    this.post<{ alias: string; address: string }>(`/chains/${this.chain}/addresses`, { alias, address });
  deleteAddress = (addressOrAlias: string) => this.del<unknown>(`/chains/${this.chain}/addresses/${addressOrAlias}`);

  // ---------- events ----------

  /**
   * Indexed events. Filter by `contractLabel` + `eventName`; there is no `eventSignature` parameter,
   * and passing one is rejected as "invalid request" rather than ignored.
   */
  listEvents = (f: {
    contractAddress?: string;
    contractLabel?: string;
    eventName?: string;
    blockNumber?: number;
    txHash?: string;
    limit?: number;
    offset?: number;
  } = {}) => this.get<MultiBaasEvent[]>(`/events${this.q(f)}`);

  /** Returns a bare number, not an object. */
  eventCount = (f: { contractAddress?: string; contractLabel?: string; eventName?: string } = {}) =>
    this.get<number>(`/events/count${this.q(f)}`);

  /** MultiBaas rejects `limit` above this outright, so paging is mandatory rather than optional. */
  static readonly MAX_EVENT_LIMIT = 50;

  /**
   * Page through events up to `max`.
   *
   * A silently truncated event list is worse than a slow one here: the allowance ledger is built by
   * folding these rows, so a missing page reads as authority that was never granted.
   */
  async listAllEvents(
    f: { contractAddress?: string; contractLabel?: string; eventName?: string; txHash?: string } = {},
    max = 1000,
  ): Promise<MultiBaasEvent[]> {
    const out: MultiBaasEvent[] = [];
    for (let offset = 0; out.length < max; offset += MultiBaas.MAX_EVENT_LIMIT) {
      const limit = Math.min(MultiBaas.MAX_EVENT_LIMIT, max - out.length);
      const page = await this.listEvents({ ...f, limit, offset });
      out.push(...page);
      if (page.length < limit) break;
    }
    return out;
  }

  // ---------- event queries ----------
  //
  // Saved SQL-ish views over indexed events. This is how the treasury ledger and the dashboard read
  // the same numbers: one query definition, queried by both, rather than two hand-rolled reducers
  // that can disagree.

  listQueries = () => this.get<{ label: string }[]>("/queries");
  getQuery = (label: string) => this.get<Record<string, unknown>>(`/queries/${label}`);
  setQuery = (label: string, query: EventQuery) => this.put<Record<string, unknown>>(`/queries/${label}`, query);
  deleteQuery = (label: string) => this.del<unknown>(`/queries/${label}`);
  runQuery = (label: string, opts: { limit?: number; offset?: number } = {}) =>
    this.get<{ rows: Record<string, unknown>[] }>(`/queries/${label}/results${this.q(opts)}`);
  runArbitraryQuery = (query: EventQuery, opts: { limit?: number; offset?: number } = {}) =>
    this.post<{ rows: Record<string, unknown>[] }>(`/queries${this.q(opts)}`, query);

  // ---------- transaction manager ----------
  //
  // TXM tracks a wallet's transactions, reports their status and resubmits when they stall. For a
  // relayer that is the difference between "submitted" and "landed": a stuck nonce blocks the whole
  // per-chain queue behind it.

  listWalletTransactions = (address: string, f: { hash?: string; nonce?: number; status?: string; limit?: number; offset?: number } = {}) =>
    this.get<TxmTransaction[]>(`/chains/${this.chain}/txm/${address}${this.q(f)}`);

  countWalletTransactions = (address: string) => this.get<{ count: number }>(`/chains/${this.chain}/txm/${address}/count`);

  /** Replace a stuck transaction at `nonce` with a higher-fee one. */
  speedUpTransaction = (address: string, nonce: number, gasPrice: string) =>
    this.post<Record<string, unknown>>(`/chains/${this.chain}/txm/${address}/tx/${nonce}/speedup`, { gasPrice });

  /** Overwrite `nonce` with a no-op, to unblock everything queued behind it. */
  cancelTransaction = (address: string, nonce: number, gasPrice: string) =>
    this.post<Record<string, unknown>>(`/chains/${this.chain}/txm/${address}/tx/${nonce}/cancel`, { gasPrice });

  // ---------- cloud wallets / HSM ----------

  listHsmConfigs = () => this.get<Record<string, unknown>[]>(`/chains/${this.chain}/hsm/config`);
  listHsmWallets = () => this.get<{ address: string; keyName?: string }[]>(`/chains/${this.chain}/hsm/key`);

  /** Sign arbitrary data with a Cloud Wallet key. The private key never leaves the HSM. */
  signData = (address: string, data: string) =>
    this.post<{ signature: string }>(`/chains/${this.chain}/hsm/sign`, { address, data });

  signAndSubmitTransaction = (tx: Record<string, unknown>) =>
    this.post<{ hash: string }>(`/chains/${this.chain}/hsm/submit`, tx);

  setLocalNonce = (address: string, nonce: number) =>
    this.post<unknown>(`/chains/${this.chain}/hsm/nonce/${address}`, { nonce });

  // ---------- webhooks ----------

  listWebhooks = () => this.get<{ id: number; url: string; subscriptions: string[] }[]>("/webhooks");
  createWebhook = (url: string, subscriptions: string[]) =>
    this.post<{ id: number; secret?: string }>("/webhooks", { url, subscriptions });
  deleteWebhook = (id: number) => this.del<unknown>(`/webhooks/${id}`);
  listWebhookEvents = (limit = 50) => this.get<Record<string, unknown>[]>(`/webhooks/events${this.q({ limit })}`);
}

/**
 * Contract registration payload. `rawAbi` is the ABI as a JSON STRING, not as an object — MultiBaas
 * rejects the parsed form, and the error it returns ("unable to parse JSON") points at the request
 * body rather than at this field, which is worth a comment.
 */
export type ContractRegistration = {
  label: string;
  contractName: string;
  version: string;
  rawAbi: string;
  bin?: string;
  userDoc?: string;
  developerDoc?: string;
  metadata?: string;
  isFavorite?: boolean;
};

export type MultiBaasEvent = {
  event: { name: string; signature: string; inputs: { name: string; value: unknown }[] };
  triggeredAt?: string;
  transaction?: { txHash: string; blockNumber: number; from: string; txIndexInBlock: number };
  contract?: { address: string; label: string };
};

export type TxmTransaction = {
  hash?: string;
  nonce: number;
  status: string;
  from?: string;
  to?: string;
  gasPrice?: string;
};

export type EventQuery = {
  events: {
    select: { name: string; type: string; alias: string; aggregator?: string; inputIndex?: number }[];
    eventName: string;
    filter?: Record<string, unknown>;
  }[];
  groupBy?: string;
  orderBy?: string;
};

/**
 * Verify a MultiBaas webhook before parsing its body.
 *
 * Order matters: parse after verifying, never before. The signature is HMAC-SHA256 over
 * `timestamp + body`, and the comparison is constant-time — a `===` on hex strings leaks the
 * position of the first differing byte, which is enough to forge a signature given enough tries.
 * The timestamp window is what stops a captured-and-replayed valid delivery.
 */
export async function verifyWebhook(a: {
  secret: string;
  signature: string;
  timestamp: string;
  rawBody: string;
  now?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const now = a.now ?? Math.floor(Date.now() / 1000);
  const ts = Number(a.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (a.toleranceSeconds ?? 300)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(a.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${a.timestamp}${a.rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const got = a.signature.replace(/^sha256=/, "").toLowerCase();
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
