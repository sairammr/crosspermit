// The relayer, as seen from here. The only thing in the process that holds the API key.
//
// That is the whole of item 2's fix: the key stops being `NEXT_PUBLIC_*`. A browser can no longer
// present it, because a browser never has it.

export const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:8787";
const KEY = process.env.RELAYER_API_KEY ?? "";

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`relayer answered ${status}`);
  }
}

/**
 * One call upstream. Throws `UpstreamError` on a 4xx/5xx so a route can pass the relayer's own
 * refusal through instead of inventing one — a client told "bad proof" by the relayer should read
 * that, not a generic 502 from a proxy.
 */
export async function call<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; withKey?: boolean } = {},
): Promise<T> {
  const res = await fetch(`${RELAYER_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.withKey !== false && KEY ? { authorization: `Bearer ${KEY}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch((e) => {
    throw new UpstreamError(502, { error: `relayer unreachable: ${e instanceof Error ? e.message : String(e)}`, code: "upstream_down" });
  });

  const text = await res.text();
  const body = text ? ((): unknown => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw new UpstreamError(res.status, body);
  return body as T;
}

export type Mandate = {
  token: string;
  name: string;
  mandate: string;
  capUnits: string;
  ttlHours: number;
  chainIds: number[];
  owner: string | null;
  intentId: string | null;
  createdAt: number;
  linkedAt: number | null;
  revokedAt: number | null;
  status: "awaiting" | "active" | "revoked";
};

export type LedgerRow = { chainId: number; token: string; spender: string; amount: string; expiration?: number };

export const mandate = (token: string) => call<{ client: Mandate }>(`/v1/clients/${token}`).then((r) => r.client);
export const treasury = (owner: string) =>
  call<{ owner: string; covered: number[]; uncovered: number[]; rows: LedgerRow[] }>(`/v1/treasury/${owner}`);

/** Which chains the relayer serves, for display. It does not publish router addresses — see `config.ts`. */
export const chains = () =>
  call<{ crossPermit: string; chains: { chainId: number; name: string; explorer: string }[] }>("/v1/chains");
