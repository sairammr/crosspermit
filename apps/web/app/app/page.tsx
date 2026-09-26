"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

import { CHAINS } from "../../src/config";
import { useClients } from "../../src/clients";
import { useTreasury } from "../../src/relayer";
import { ClientsTab } from "./desk";
import { Shell } from "./shell";

/**
 * The desk, which is a client book and nothing else.
 *
 * It used to be eight screens: a signing form, the relayer's fan-out, its quota, the treasury
 * reader, an audit view, a strategy catalogue and a yield sheet. Every one of them was a view onto
 * machinery, and none of them was what a manager opens the app to do — which is to see their
 * clients and open one. Those screens are gone; what a client's capital is doing lives on that
 * client's own page, where the account it belongs to is named on the screen.
 */

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

const usd = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(2);

function Stat({ k, v, n, tone }: { k: string; v: string; n: string; tone?: "warn" | "bad" }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      <div className="n">{n}</div>
    </div>
  );
}

export default function Page() {
  const { address } = useAccount();
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const clients = useClients(refreshKey);
  const treasury = useTreasury(address, refreshKey);

  const book = Array.isArray(clients) ? clients : [];
  const live = book.filter((c) => c.status === "active");
  const awaiting = book.filter((c) => c.status === "awaiting");

  const rows = treasury && typeof treasury === "object" ? treasury.rows : [];
  const active = rows.filter((r) => r.state === "active");
  const locked = rows.filter((r) => r.state === "locked");
  // Unbounded rows are counted, never summed: one uint256-max allowance would swamp the figure and
  // make a real exposure unreadable.
  const unbounded = rows.filter((r) => r.state === "unbounded");
  const outstanding = active.reduce((sum, r) => sum + Number(r.amount) / 1e6, 0);

  return (
    <Shell
      clients={clients}
      current="clients"
      title="Clients"
      meta={
        address
          ? `desk ${short(address, 8)} · ${CHAINS.length} chains`
          : `${CHAINS.length} chains · connect a wallet to read your book`
      }
      onSession={bump}
    >
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat
          k="Clients live"
          v={Array.isArray(clients) ? `${live.length} / ${clients.length}` : "—"}
          n={
            Array.isArray(clients)
              ? `signed and live${awaiting.length ? ` · ${awaiting.length} awaiting a signature` : ""}`
              : clients === null
                ? "reading the book…"
                : "prove a wallet to read your book"
          }
        />
        <Stat
          k="Outstanding authority"
          v={address && treasury && typeof treasury === "object" ? `${usd(outstanding)} USDC` : "—"}
          n={
            !address
              ? "connect a wallet to read the ledger"
              : treasury === null
                ? "reading the ledger…"
                : treasury === false
                  ? "the desk layer is unreachable"
                  : `${active.length} live allowance${active.length === 1 ? "" : "s"}${
                      unbounded.length ? `, ${unbounded.length} unbounded and not counted` : ""
                    }`
          }
        />
        <Stat
          k="Awaiting signature"
          v={Array.isArray(clients) ? String(awaiting.length) : "—"}
          n={awaiting.length ? "a link is open, nothing is granted yet" : "no open link is unsigned"}
          tone={awaiting.length ? "warn" : undefined}
        />
        <Stat
          k="Locked spenders"
          v={treasury && typeof treasury === "object" ? String(locked.length) : "—"}
          n={
            locked.length
              ? "a cross-chain LOCK is standing on the book"
              : "nothing is locked out across the book"
          }
          tone={locked.length ? "bad" : undefined}
        />
      </div>

      <ClientsTab refreshKey={refreshKey} onChange={bump} />
    </Shell>
  );
}
