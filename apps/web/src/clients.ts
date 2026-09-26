"use client";

import { useCallback, useEffect, useState } from "react";

import { RELAYER_URL } from "./config";

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

const apiKey = process.env.NEXT_PUBLIC_RELAYER_API_KEY ?? "";

const headers = (): HeadersInit => ({
  "content-type": "application/json",
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
});

/** The desk's own client list. Requires the desk's key when the relayer is not running open. */
export function useClients(refreshKey: number) {
  const [clients, setClients] = useState<ClientMandate[] | null | false>(null);

  useEffect(() => {
    let live = true;
    fetch(`${RELAYER_URL}/v1/clients`, { headers: headers() })
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
  const res = await fetch(`${RELAYER_URL}/v1/clients`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { client?: ClientMandate; error?: string };
  return res.ok ? { ok: true, client: body.client } : { ok: false, error: body.error ?? `HTTP ${res.status}` };
}

export async function revokeClient(token: string): Promise<boolean> {
  const res = await fetch(`${RELAYER_URL}/v1/clients/${token}/revoke`, { method: "POST", headers: headers() });
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
    fetch(`${RELAYER_URL}/v1/clients/${token}`)
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
  const res = await fetch(`${RELAYER_URL}/v1/clients/${token}/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner, intentId, ...terms }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error ?? `HTTP ${res.status}` };
}
