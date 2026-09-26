"use client";

/**
 * The desk's own identity, proven with a signature.
 *
 * Connecting a wallet shows an address; it does not prove the visitor holds the key. This is the
 * second step: the layer issues a nonce, the wallet signs the exact text, the layer recovers it and
 * opens a session. Until that happens the dashboard can read nothing that belongs to a desk — which
 * is the point, because the API key that used to stand in for this shipped in the client bundle.
 *
 * The signature costs no gas, names no spender and authorises no transfer. It is not a writ.
 */

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { DESK_API } from "./config";

export type Manager = { address: string; name: string; createdAt: number };

export type Session = {
  address: Address;
  manager: Manager;
  desks: { chainId: number; desk: Address }[];
  clients: number;
  routers: Record<number, Address>;
};

/** Same-origin, so the cookie rides along without this code ever touching it. */
async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${DESK_API}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/**
 * Who this browser is, as far as the layer is concerned.
 *
 * Three states, kept apart because they mean different things to the person reading the screen:
 * loading, no session (sign in), and the layer being unreachable (nothing is wrong with your key).
 */
export function useSession(refreshKey = 0) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "none" } | { kind: "ok"; session: Session } | { kind: "offline" }>({
    kind: "loading",
  });

  const load = useCallback(() => {
    let live = true;
    fetch(`${DESK_API}/auth/me`)
      .then(async (r) => {
        if (!live) return;
        if (r.status === 401) return setState({ kind: "none" });
        if (!r.ok) return setState({ kind: "offline" });
        setState({ kind: "ok", session: (await r.json()) as Session });
      })
      .catch(() => live && setState({ kind: "offline" }));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const cancel = load();
    return cancel;
  }, [load, refreshKey]);

  return { state, reload: load };
}

/**
 * The handshake. `sign` is the wallet's `signMessage`, passed in so this module needs no wagmi.
 *
 * The message is never composed here: it is whatever the layer handed out, signed verbatim. The
 * layer rebuilds it from what it stored and refuses anything that does not reproduce.
 */
export async function proveOwnership(address: Address, sign: (message: string) => Promise<string>): Promise<Session> {
  const { nonce, message } = await api<{ nonce: string; message: string }>("/auth/nonce", {
    method: "POST",
    body: { address },
  });
  const signature = await sign(message);
  await api("/auth/verify", { method: "POST", body: { address, nonce, signature } });
  return api<Session>("/auth/me");
}

export const endSession = () => api("/auth/signout", { method: "POST" });

export const setDeskName = (name: string) => api<Session>("/auth/me", { method: "PUT", body: { name } });

/** Claim a LiquidityDesk deployment. Refused with `desk_shared` if another manager registered it. */
export const registerDesk = (chainId: number, desk: Address) =>
  api<{ chainId: number; desk: Address }>(`/desks/${chainId}`, { method: "PUT", body: { desk } });

// ---------------------------------------------------------------- scope check

export type ScopedRow = {
  chainId: number;
  token: Address;
  spender: Address;
  amount: string;
  expiration?: number;
  kind: "mine" | "router" | "other_desk" | "unknown";
  label: string;
  manager?: string;
};

export type ScopeCheck = {
  status: string;
  owner: Address | null;
  covered?: number[];
  uncovered?: number[];
  rows: ScopedRow[];
  foreign: ScopedRow[];
  ok: boolean;
};

/**
 * Every allowance one client signed, with its spender named from this manager's point of view.
 *
 * The row that matters is the one the dashboard cannot attribute: a spender that is neither a desk
 * registered here nor a router the platform publishes. Those are counted, never relabelled.
 */
export function useScopeCheck(token: string | undefined, refreshKey = 0) {
  const [state, setState] = useState<ScopeCheck | null | false>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    setState(null);
    api<ScopeCheck>(`/clients/${token}/scope-check`)
      .then((d) => live && setState(d))
      .catch(() => live && setState(false));
    return () => {
      live = false;
    };
  }, [token, refreshKey]);

  return state;
}
