"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";

import { RELAYER_URL } from "./config";

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

const apiKey = process.env.NEXT_PUBLIC_RELAYER_API_KEY ?? "";

const headers = (): HeadersInit => ({
  "content-type": "application/json",
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
});

/** What the relayer serves, and with whose key. Null while loading, false when unreachable. */
export function useRelayerChains() {
  const [state, setState] = useState<{ crossPermit: string; chains: ChainRow[] } | null | false>(null);

  useEffect(() => {
    let live = true;
    fetch(`${RELAYER_URL}/v1/chains`)
      .then((r) => r.json())
      .then((d) => live && setState(d))
      .catch(() => live && setState(false));
    return () => {
      live = false;
    };
  }, []);

  return state;
}

export async function postIntent(wire: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${RELAYER_URL}/v1/intents`, {
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
    const es = new EventSource(`${RELAYER_URL}/v1/intents/${intentId}/sse`);
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
      fetch(`${RELAYER_URL}/v1/intents/${intentId}`)
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
    fetch(`${RELAYER_URL}/v1/intents/${intentId}`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => undefined);
  }, [intentId]);

  return { status, connected, refresh };
}

export function useRecentIntents(refreshKey: number) {
  const [intents, setIntents] = useState<{ intentId: string; owner: string; root: string; createdAt: number }[]>([]);
  useEffect(() => {
    fetch(`${RELAYER_URL}/v1/intents?limit=25`)
      .then((r) => r.json())
      .then((d) => setIntents(d.intents ?? []))
      .catch(() => setIntents([]));
  }, [refreshKey]);
  return intents;
}

export function useQuota(owner: string | undefined, refreshKey: number) {
  const [quota, setQuota] = useState<{ intents: number; gasWei: string; resetsInMs: number } | null>(null);
  useEffect(() => {
    if (!owner) return;
    fetch(`${RELAYER_URL}/v1/quota/${owner}`)
      .then((r) => r.json())
      .then((d) => setQuota(d.remaining ?? null))
      .catch(() => setQuota(null));
  }, [owner, refreshKey]);
  return quota;
}
