"use client";

import { useCallback, useEffect, useState } from "react";

import { DESK_API } from "./config";

export type ClientStatus = "awaiting" | "active" | "revoked";

export type ClientMandate = {
  token: string;
  name: string;
  mandate: string;
  /** Per-chain cap in the token's base units, "" until the client sets it. A string, because it can exceed 2^53. */
  capUnits: string;
  /** Hours the allowance lives once signed; 0 until the client sets it. */
  ttlHours: number;
  /** Chains the grant covers; empty until the client picks them. */
  chainIds: number[];
  owner: string | null;
  intentId: string | null;
  createdAt: number;
  linkedAt: number | null;
  revokedAt: number | null;
  status: ClientStatus;
};

/**
 * No key. The desk layer holds the relayer's, and answers these from the signed-in manager's session
 * — so the book this returns is that manager's book rather than every manager's.
 */
const headers = (): HeadersInit => ({ "content-type": "application/json" });

/** The desk's own client list. Requires the desk's key when the relayer is not running open. */
export function useClients(refreshKey: number) {
  const [clients, setClients] = useState<ClientMandate[] | null | false>(null);

  useEffect(() => {
    let live = true;
    fetch(`${DESK_API}/clients`, { headers: headers() })
      .then(async (r) => (r.ok ? ((await r.json()).clients as ClientMandate[]) : false))
      .then((d) => live && setClients(d))
      .catch(() => live && setClients(false));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  return clients;
}

/**
 * Open a link for one client.
 *
 * The desk names the client and nothing else: which token, how much and for how long are the
 * client's to choose on the page, and are written back by `linkMandate` when they sign.
 */
export async function createClient(input: {
  name: string;
  mandate?: string;
}): Promise<{ ok: boolean; client?: ClientMandate; error?: string }> {
  const res = await fetch(`${DESK_API}/clients`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { client?: ClientMandate; error?: string };
  return res.ok ? { ok: true, client: body.client } : { ok: false, error: body.error ?? `HTTP ${res.status}` };
}

export async function revokeClient(token: string): Promise<boolean> {
  const res = await fetch(`${DESK_API}/clients/${token}/revoke`, { method: "POST", headers: headers() });
  return res.ok;
}

/**
 * One mandate, read by whoever opened the link.
 *
 * Distinguishes "still loading", "no such link" and "the relayer is unreachable", because a client
 * staring at an empty page needs to know which of those happened before they decide whether to
 * trust the next screen with a signature.
 */
export function useMandate(token: string | undefined) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ok"; client: ClientMandate } | { kind: "missing" } | { kind: "offline" }
  >({ kind: "loading" });

  const load = useCallback(() => {
    if (!token) return;
    setState({ kind: "loading" });
    fetch(`${DESK_API}/clients/${token}`)
      .then(async (r) => {
        if (r.status === 404) return setState({ kind: "missing" });
        if (!r.ok) return setState({ kind: "offline" });
        setState({ kind: "ok", client: ((await r.json()) as { client: ClientMandate }).client });
      })
      .catch(() => setState({ kind: "offline" }));
  }, [token]);

  useEffect(load, [load]);

  return { state, reload: load };
}

/**
 * Bind the owner who signed, and the terms they chose.
 *
 * The relayer checks the intent is really theirs before it accepts, and records the cap, expiry
 * and chains from this call — so the desk's ledger shows what was granted, not what was asked for.
 */
export async function linkMandate(
  token: string,
  owner: string,
  intentId: string,
  terms: { capUnits: string; ttlHours: number; chainIds: number[] },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${DESK_API}/clients/${token}/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner, intentId, ...terms }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error ?? `HTTP ${res.status}` };
}

/**
 * Whether the desk layer itself is configured, as opposed to the relayer being quiet.
 *
 * Every read in this app folds a failure into `false`, and every screen renders that as "the
 * control plane is silent". That is right when the relayer does not answer and wrong — misleading,
 * and expensively so — when the desk refused before it ever placed the call. A serverless host
 * with no `TURSO_DATABASE_URL` answers 503 `not_configured` to everything, and the app blamed the
 * relayer for a database that was never reachable.
 *
 * The desk already writes a precise, actionable sentence for this case. This hook does nothing but
 * carry it to the screen. Any other failure is left alone: it is the relayer's story to tell, and
 * the existing panels already tell it.
 */
export function useDeskHealth(): { kind: "checking" } | { kind: "ok" } | { kind: "misconfigured"; message: string } {
  const [state, setState] = useState<{ kind: "checking" } | { kind: "ok" } | { kind: "misconfigured"; message: string }>({
    kind: "checking",
  });

  useEffect(() => {
    let live = true;
    fetch(`${DESK_API}/chains`, { headers: headers() })
      .then(async (r) => {
        if (r.ok) return { kind: "ok" as const };
        const body = (await r.json().catch(() => null)) as { code?: string; error?: string } | null;
        return body?.code === "not_configured"
          ? { kind: "misconfigured" as const, message: body.error ?? "The desk layer is not configured." }
          : { kind: "ok" as const };
      })
      .then((s) => live && setState(s))
      .catch(() => live && setState({ kind: "ok" }));
    return () => {
      live = false;
    };
  }, []);

  return state;
}
