"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { CHAINS, CROSS_PERMIT, WC_PROJECT_ID } from "../../src/config";
import { ProveOwnership } from "../../src/session-ui";
import { HorseMatrix } from "../../src/dithergraph";
import { Rail } from "../rail";
import { useClients, useDeskHealth } from "../../src/clients";
import { ClientsTab } from "./desk";
import { DeskFault } from "./desk-fault";
import { Overview } from "./overview";
import {
  useIntentStream,
  useActivity,
  useRecentIntents,
  useRelayerChains,
  useTreasury,
} from "../../src/relayer";

/**
 * The desk's two screens: the state of things, and the book.
 *
 * It used to carry six more — a signing form, the relayer's fan-out, its quota, the treasury
 * reader, an audit view, a strategy catalogue and a yield sheet. Every one was a view onto
 * machinery, and none of them was what a manager opens the app to do. What a client's capital is
 * doing lives on that client's own page, where the account it belongs to is named on the screen.
 */
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "clients", label: "Clients" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

export default function Page() {
  const [tab, setTab] = useState<Tab>("overview");
  const { address, isConnected } = useAccount();
  // Kept for the live fan-out the overview shows: an intent id arrives from the client's own
  // signing page, not from a form on the desk.
  const [intentId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // `?owner=0x...` opens the read-only views for an account without connecting a wallet. A risk
  // officer reviewing someone else's outstanding authority should not need that account's keys —
  // and the treasury and audit screens are reads, so there is nothing to sign.
  const [viewOnly, setViewOnly] = useState<`0x${string}` | undefined>();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("owner");
    if (q && /^0x[0-9a-fA-F]{40}$/.test(q)) setViewOnly(q as `0x${string}`);
  }, []);

  // Signing always uses the connected wallet. Only the read-only screens fall back to ?owner.
  const subject = address ?? viewOnly;

  // The overview is a summary of what the other screens read, so it reads nothing of its own: the
  // subscriptions live here and are handed down. Mounting them on the page also means the figures
  // are already warm when somebody switches to a detail screen, instead of every tab starting from
  // "loading…" again.
  const chains = useRelayerChains();
  const treasury = useTreasury(subject, refreshKey);
  const activity = useActivity(subject, refreshKey);
  const clients = useClients(refreshKey);
  const recent = useRecentIntents(refreshKey);
  const { status: inFlight } = useIntentStream(intentId);
  const health = useDeskHealth();

  return (
    <div className="wrap">
      {/* The same key bank the landing wears, inline. A desk screen is the key that is held down,
          which is the one state the console sheet already has for a control that stays put — so the
          tabs stopped being underlined text the moment the rail existed to carry them. */}
      <Rail
        variant="inline"
        go={null}
        items={TABS.map((t) => ({
          key: t.key,
          label: t.label,
          current: tab === t.key,
          onClick: () => setTab(t.key),
        }))}
        brand={
          <a href="/">
            <HorseMatrix cols={20} size={24} tone="light" />
            CrossPermit
          </a>
        }
        aside={
          /* One control, not two. Connecting a wallet and proving you hold its key are different
             facts, but they were never two decisions — this walks both, and afterwards it is the
             account button. */
          <ProveOwnership onChange={() => setRefreshKey((k) => k + 1)} />
        }
      />

      {/* A desk layer that refused to start explains itself here, rather than letting every panel
          below report an empty book as though the book were empty. */}
      {health.kind === "misconfigured" && <DeskFault message={health.message} />}

      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <span className="micro">
          CrossPermit {CROSS_PERMIT} · same address on {CHAINS.length} chains
        </span>
        <span className="micro">{subject ? `subject ${short(subject, 8)}` : "no subject"}</span>
      </div>

      {!address && viewOnly && (
        <div className="alert">
          <span>●</span>
          <div>
            <strong className="t">Read-only view</strong>
            <p>
              <span className="mono">{viewOnly}</span>. Connect a wallet to sign.
            </p>
          </div>
        </div>
      )}

      {!WC_PROJECT_ID && (
        <div className="alert">
          <span>●</span>
          <div>
            <strong className="t">WalletConnect unavailable</strong>
            <p>
              No <code>NEXT_PUBLIC_WC_PROJECT_ID</code> set, so only injected wallets (MetaMask, Rabby) will connect.
              Everything else works. Get a project id at{" "}
              <a href="https://dashboard.reown.com" target="_blank" rel="noreferrer">
                dashboard.reown.com
              </a>
              .
            </p>
          </div>
        </div>
      )}

      {tab === "overview" && (
        <Overview
          owner={subject}
          connected={isConnected}
          chains={chains}
          treasury={treasury}
          activity={activity}
          clients={clients}
          intents={recent}
          inFlight={inFlight}
          onGo={(t) => setTab(t as Tab)}
        />
      )}
      {tab === "clients" && <ClientsTab refreshKey={refreshKey} onChange={() => setRefreshKey((k) => k + 1)} />}
    </div>
  );
}
