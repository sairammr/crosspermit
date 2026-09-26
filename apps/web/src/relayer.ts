"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";

import { DESK_API } from "./config";

export type LegStatus = "pending" | "submitting" | "submitted" | "confirmed" | "failed";

export type Leg = {
  chainId: number;
  status: LegStatus;
  txHash: Hex | null;
  error: string | null;
  attempts: number;
  explorer?: string;
};

export type IntentStatus = {
  intentId: string;
  owner: string;
  root: string;
  deadline: number;
  done: boolean;
  ok: boolean;
  legs: Leg[];
};

export type ChainRow = {
  chainId: number;
  name: string;
  explorer?: string;
  signer: string;
  custody: string;
  auditTrail: "multibaas" | "none";
};

/**
 * No key, and nothing points at the relayer any more.
 *
 * Every call here goes to the desk layer on this app's own origin. It holds the relayer's key, gates
 * the reads that belong to somebody (`/treasury`, `/activity`) on the session, and streams the open
 * ones straight through — including the SSE below, which is why that works unchanged.
 */
const headers = (): HeadersInit => ({ "content-type": "application/json" });

/** What the relayer serves, and with whose key. Null while loading, false when unreachable. */
export function useRelayerChains() {
  const [state, setState] = useState<{ crossPermit: string; chains: ChainRow[] } | null | false>(null);

  useEffect(() => {
    let live = true;
    fetch(`${DESK_API}/chains`)
      // A refusal is `false`, not its body: an error object spread in here reaches the UI as a
      // `chains` field that is missing, and every consumer reads `.chains.length`.
      .then(async (r) => (r.ok ? ((await r.json()) as { crossPermit: string; chains: ChainRow[] }) : false))
      .then((d) => live && setState(d))
      .catch(() => live && setState(false));
    return () => {
      live = false;
    };
  }, []);

  return state;
}

export async function postIntent(wire: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${DESK_API}/intents`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(wire),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * Live per-leg progress over SSE.
 *
 * The relayer replays the current status as a `snapshot` before any subscription, so a UI that
 * connects a moment after a fast chain landed still sees it. Without that, the screen would hang on
 * a leg that had already finished.
 */
export function useIntentStream(intentId: string | null) {
  const [status, setStatus] = useState<IntentStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!intentId) {
      setStatus(null);
      return;
    }
    const es = new EventSource(`${DESK_API}/intents/${intentId}/sse`);
    source.current = es;

    const onSnapshot = (e: MessageEvent) => setStatus(JSON.parse(e.data) as IntentStatus);
    const onDone = (e: MessageEvent) => {
      setStatus(JSON.parse(e.data) as IntentStatus);
      es.close();
      setConnected(false);
    };
    // A `leg` event carries one leg, not the whole intent, so refetch the snapshot rather than
    // trying to merge partial state — the authoritative answer is one request away.
    const onLeg = () => {
      fetch(`${DESK_API}/intents/${intentId}`)
        .then((r) => r.json())
        .then(setStatus)
        .catch(() => undefined);
    };

    es.addEventListener("snapshot", onSnapshot);
    es.addEventListener("leg", onLeg);
    es.addEventListener("done", onDone);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      source.current = null;
      setConnected(false);
    };
  }, [intentId]);

  const refresh = useCallback(() => {
    if (!intentId) return;
    fetch(`${DESK_API}/intents/${intentId}`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => undefined);
  }, [intentId]);

  return { status, connected, refresh };
}

export function useRecentIntents(refreshKey: number) {
  const [intents, setIntents] = useState<{ intentId: string; owner: string; root: string; createdAt: number }[]>([]);
  // A refusal is not an empty list. This route needs a session and, upstream, the relayer's key; a
  // 401 body parsed as JSON has no `intents`, so the old `d.intents ?? []` rendered "0 signatures
  // fanned out" and looked like a quiet Tuesday rather than a broken proxy.
  useEffect(() => {
    let live = true;
    fetch(`${DESK_API}/intents?limit=25`)
      .then(async (r) => (r.ok ? ((await r.json()) as { intents?: typeof intents }) : false))
      .then((d) => { if (live) setIntents(d === false ? [] : (d.intents ?? [])); })
      .catch(() => { if (live) setIntents([]); });
    return () => { live = false; };
  }, [refreshKey]);
  return intents;
}

export type AllowanceRow = {
  chainId: number;
  chainName: string;
  token: string;
  spender: string;
  amount: string;
  expiration: number;
  timestamp: number;
  state: "active" | "locked" | "unbounded";
  explorer?: string;
};

export type TreasuryView = {
  owner: string;
  covered: number[];
  uncovered: number[];
  rows: AllowanceRow[];
  error?: string;
};

/**
 * Outstanding authority, from the MultiBaas event ledger via the relayer.
 *
 * `uncovered` is part of the payload rather than something the UI infers: a chain absent from the
 * rows because nothing indexes it looks identical to a chain with no outstanding authority, and a
 * treasury screen must never let those two read the same.
 *
 * A refusal is `false`, never a half-filled view. A 401 or a 502 spread into a `TreasuryView` would
 * render as "0.00 USDC outstanding", which is the one answer a treasury screen must never invent.
 */
export function useTreasury(owner: string | undefined, refreshKey: number) {
  const [view, setView] = useState<TreasuryView | null | false>(null);

  useEffect(() => {
    if (!owner) {
      setView(null);
      return;
    }
    let live = true;
    setView(null);
    fetch(`${DESK_API}/treasury/${owner}`)
      .then(async (r) => (r.ok ? ((await r.json()) as TreasuryView) : false))
      .then((d) => live && setView(d))
      .catch(() => live && setView(false));
    return () => {
      live = false;
    };
  }, [owner, refreshKey]);

  return view;
}

export type ActivityRow = {
  chainId: number;
  chainName: string;
  kind: "granted" | "locked" | "cleared" | "cancelled";
  name: string;
  owner: string;
  token?: string;
  spender?: string;
  amount?: string;
  expiration?: number;
  timestamp?: number;
  salt?: string;
  at?: string;
  txHash?: string;
  blockNumber?: number;
  explorer?: string;
};

export type ActivityView = { owner: string; covered: number[]; uncovered: number[]; rows: ActivityRow[] };

/**
 * Everything the control plane recorded for one owner, newest first.
 *
 * Distinct from `useTreasury` on purpose: that one answers "what authority stands now", this one
 * answers "what happened" — and it is the only record of a grant that has since expired, because
 * an expired allowance leaves no storage behind to read.
 */
export function useActivity(owner: string | undefined, refreshKey: number) {
  const [view, setView] = useState<ActivityView | null | false>(null);

  useEffect(() => {
    if (!owner) {
      setView(null);
      return;
    }
    let live = true;
    setView(null);
    fetch(`${DESK_API}/activity/${owner}`)
      .then(async (r) => (r.ok ? ((await r.json()) as ActivityView) : false))
      .then((d) => live && setView(d))
      .catch(() => live && setView(false));
    return () => {
      live = false;
    };
  }, [owner, refreshKey]);

  return view;
}
