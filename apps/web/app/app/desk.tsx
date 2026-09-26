"use client";

/**
 * The desk's own two screens: who the clients are, and what their capital can be put into.
 *
 * Both are written to keep one distinction visible that is easy to blur on a dashboard: a mandate
 * the desk *asked for* is not authority, and a strategy that exists in this repository is not the
 * same as a strategy that is deployed on the chain the client actually signed for. Where the two
 * differ, the screen says so instead of rendering a button that cannot work.
 */

import { useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";

import { CHAINS, chainById } from "../../src/config";
import { type ClientMandate, createClient, revokeClient, useClients } from "../../src/clients";
import { type AllowanceRow, useTreasury } from "../../src/relayer";

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

// ---------------------------------------------------------------- clients

export function ClientsTab({ refreshKey, onChange }: { refreshKey: number; onChange: () => void }) {
  const clients = useClients(refreshKey);
  const [name, setName] = useState("");
  const [mandate, setMandate] = useState("USDC mandate across three chains");
  const [cap, setCap] = useState("250000");
  const [hours, setHours] = useState("720");
  const [chainIds, setChainIds] = useState<number[]>(CHAINS.map((c) => c.id));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<ClientMandate | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      // The cap is entered in whole tokens and stored in base units. Converted here, once, so the
      // relayer never has to guess which of the two it was handed.
      const res = await createClient({
        name,
        mandate,
        capUnits: parseUnits(cap || "0", 6).toString(),
        ttlHours: Number(hours),
        chainIds,
      });
      if (!res.ok) throw new Error(res.error);
      setFresh(res.client ?? null);
      setName("");
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel">
        <h2>Add a client</h2>
        <p className="sub">
          This creates an invitation, not authority. Nothing is granted until the client opens the
          link and signs it themselves.
        </p>

        <div className="grid">
          <label className="field">
            <span className="lbl">Client name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Meridian Capital" />
          </label>
          <label className="field">
            <span className="lbl">Mandate</span>
            <input value={mandate} onChange={(e) => setMandate(e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Cap per chain (whole tokens)</span>
            <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" />
          </label>
          <label className="field">
            <span className="lbl">Expires in (hours)</span>
            <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="numeric" />
          </label>
        </div>

        <div className="row" style={{ marginTop: 12, gap: 14, flexWrap: "wrap" }}>
          <span className="lbl">Chains</span>
          {CHAINS.map((c) => (
            <label key={c.id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={chainIds.includes(c.id)}
                onChange={(e) =>
                  setChainIds((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id)))
                }
              />
              {c.short}
            </label>
          ))}
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="action" disabled={busy || !name.trim() || chainIds.length === 0} onClick={add}>
            {busy ? "creating…" : "Create link"}
          </button>
        </div>
        {error && <div className="err">{error}</div>}

        {fresh && <ShareLink client={fresh} />}
      </div>

      <div className="panel">
        <h2>Clients</h2>
        {clients === null && <p className="note">Loading…</p>}
        {clients === false && (
          <p className="note">
            The relayer refused the client list. That is expected when{" "}
            <code>RELAYER_API_KEYS</code> is set and this dashboard has no{" "}
            <code>NEXT_PUBLIC_RELAYER_API_KEY</code> — the list is the desk&rsquo;s, not the public&rsquo;s.
          </p>
        )}
        {Array.isArray(clients) && clients.length === 0 && <p className="note">No clients yet.</p>}
        {Array.isArray(clients) && clients.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Cap / chain</th>
                  <th>Chains</th>
                  <th>Signed by</th>
                  <th>Link</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.token}>
                    <td>{c.name}</td>
                    <td>
                      <span className={`tag ${c.status}`}>{c.status}</span>
                    </td>
                    <td>{formatUnits(BigInt(c.capUnits), 6)}</td>
                    <td>{c.chainIds.map((id) => chainById(id)?.short ?? id).join(" · ")}</td>
                    <td className="mono">{c.owner ? short(c.owner) : "—"}</td>
                    <td>
                      <CopyLink token={c.token} />
                    </td>
                    <td>
                      {c.status !== "revoked" && (
                        <button
                          className="ghost"
                          onClick={async () => {
                            await revokeClient(c.token);
                            onChange();
                          }}
                        >
                          withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">
          Withdrawing a link only stops it being used. An allowance a client already signed is live
          on chain until it expires or a cross-chain <span className="mono">LOCK</span> retires it.
        </p>
      </div>
    </>
  );
}

function linkFor(token: string): string {
  return typeof window === "undefined" ? `/c/${token}` : `${window.location.origin}/c/${token}`;
}

function ShareLink({ client }: { client: ClientMandate }) {
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2>Send this to {client.name}</h2>
      <p className="sub">One client, one link. It grants nothing on its own.</p>
      <div className="mono" style={{ wordBreak: "break-all", marginTop: 8 }}>
        {linkFor(client.token)}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <CopyLink token={client.token} label="Copy link" />
        <a className="ghost" href={`/c/${client.token}`} target="_blank" rel="noreferrer">
          open as the client sees it
        </a>
      </div>
    </div>
  );
}

function CopyLink({ token, label = "copy" }: { token: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="ghost"
      onClick={async () => {
        // navigator.clipboard is unavailable on insecure origins that are not localhost, so a
        // failure here is normal rather than exceptional: show the state instead of throwing.
        try {
          await navigator.clipboard.writeText(linkFor(token));
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "copied" : label}
    </button>
  );
}

// ---------------------------------------------------------------- strategies

/**
 * What a desk can actually do with a client's mandate, per chain.
 *
 * `live` is the honest bit. Uniswap v4 is deployed on all three testnets and the lifecycle proves a
 * swap settles out of a CrossPermit allowance there. Aave v4 and the equity desk are fork-proved
 * against mainnet and have no testnet deployment, so they are listed as venues the mandate is
 * *shaped for* rather than ones this dashboard can route into today.
 */
const STRATEGIES = [
  {
    key: "v4",
    venue: "Uniswap v4",
    what: "Swap and provide liquidity through the Universal Router, settled out of the allowance.",
    live: true,
    figures: [
      ["Pool fee", "0.30%"],
      ["Proved", "1,000,000 in → 996,999 out, per chain"],
      ["Path", "V4_SWAP → SETTLE_ALL → transferFrom"],
    ],
  },
  {
    key: "aave",
    venue: "Aave v4",
    what: "Supply idle cash to the Core Hub through the MAIN Spoke.",
    live: false,
    figures: [
      ["Supply APR", "3.976%"],
      ["Supply APY", "4.056%"],
      ["Utilisation", "90.16%, read at the Hub"],
      ["30-day round trip", "10,000 → 10,032.65 USDC"],
    ],
  },
  {
    key: "equity",
    venue: "Tokenized equities",
    what: "Fill tokenized equity exposure against an oracle, bounded three ways.",
    live: false,
    figures: [
      ["Instrument", "NVDAon (Ondo), read live"],
      ["Bounds", "minOut · staleness window · deviation band"],
      ["Gate", "compliance gate denies when unset"],
    ],
  },
] as const;

export function StrategiesTab({ owner, refreshKey }: { owner?: `0x${string}`; refreshKey: number }) {
  const treasury = useTreasury(owner, refreshKey);

  // Deployable capital is the outstanding, unlocked authority — not a balance. A treasury screen
  // that adds locked rows into a headline number tells the desk it can trade money it cannot touch.
  const deployable = useMemo(() => {
    const rows: AllowanceRow[] = treasury ? (treasury.rows ?? []) : [];
    const byChain = new Map<number, bigint>();
    for (const r of rows) {
      if (r.state !== "active") continue;
      byChain.set(r.chainId, (byChain.get(r.chainId) ?? 0n) + BigInt(r.amount));
    }
    return byChain;
  }, [treasury]);

  return (
    <>
      <div className="panel">
        <h2>Deployable now</h2>
        <p className="sub">
          Outstanding, unlocked authority per chain — what the desk may spend today. Locked and
          expired rows are excluded rather than summed.
        </p>
        {!owner && <p className="note">Connect a wallet, or open with <code>?owner=0x…</code>, to read a mandate.</p>}
        {owner && treasury === null && <p className="note">Reading the ledger…</p>}
        {owner && treasury === false && <p className="note">The relayer did not answer.</p>}
        {owner && treasury && (
          <div className="grid">
            {CHAINS.map((c) => (
              <div className="stat" key={c.id}>
                <div className="k">{c.name}</div>
                <div className="v">{formatUnits(deployable.get(c.id) ?? 0n, 6)}</div>
                <div className="n">
                  {treasury.uncovered?.includes(c.id)
                    ? "no control-plane audit trail on this chain"
                    : "active allowance, 6dp"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Strategies and venues</h2>
        <p className="sub">Where a mandate can be put to work, and which of those this deployment can reach.</p>
        {STRATEGIES.map((s) => (
          <div className="panel" key={s.key} style={{ marginTop: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 style={{ margin: 0 }}>{s.venue}</h2>
              <span className={`tag ${s.live ? "active" : "awaiting"}`}>
                {s.live ? "live on all three testnets" : "mainnet fork only"}
              </span>
            </div>
            <p className="sub">{s.what}</p>
            <div className="grid">
              {s.figures.map(([k, v]) => (
                <div className="stat" key={k}>
                  <div className="k">{k}</div>
                  <div className="v">{v}</div>
                </div>
              ))}
            </div>
            {!s.live && (
              <p className="note">
                No deployment exists on Ethereum, Base or Optimism Sepolia, so this dashboard will
                not offer to route into it. The figures above were recorded by{" "}
                <span className="mono">FORK=1 forge test</span> against live mainnet.
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>Liquidity venues per chain</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Chain</th>
                <th>Execution desk (spender)</th>
                <th>Token</th>
                <th>Deployable</th>
              </tr>
            </thead>
            <tbody>
              {CHAINS.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="mono">
                    <a href={`${c.explorer}/address/${c.router}`} target="_blank" rel="noreferrer">
                      {short(c.router)}
                    </a>
                  </td>
                  <td className="mono">{short(c.token)}</td>
                  <td>{formatUnits(deployable.get(c.id) ?? 0n, 6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
