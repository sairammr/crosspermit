"use client";

/**
 * The desk's own two screens: who the clients are, and what their capital can be put into.
 *
 * Both are written to keep one distinction visible that is easy to blur on a dashboard: a mandate
 * the desk *asked for* is not authority, and a strategy that exists in this repository is not the
 * same as a strategy that is deployed on the chain the client actually signed for. Where the two
 * differ, the screen says so instead of rendering a button that cannot work.
 */

import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useReadContract } from "wagmi";

import { crossPermitAbi } from "@crosspermit/sdk";
import { CHAINS, CROSS_PERMIT, chainById } from "../../src/config";
import { type ClientMandate, createClient, revokeClient, useClients } from "../../src/clients";
import { useTreasury } from "../../src/relayer";

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

// ---------------------------------------------------------------- deployable capital

/**
 * One chain's outstanding authority to the execution desk, read from that chain's own storage.
 *
 * Read per chain rather than as one batched `useReadContracts`. Batching routes every read through
 * Multicall3, and a Multicall3 hop that fails reports the inner call as having "returned no data",
 * which is indistinguishable from a contract that is not there. A plain `eth_call` either answers
 * or errors, and on a screen where the difference between "zero" and "unknown" is the difference
 * between deploying capital and not, that distinction is worth more than one round trip.
 */
function useAllowance(chain: (typeof CHAINS)[number], owner?: `0x${string}`) {
  const read = useReadContract({
    address: CROSS_PERMIT,
    abi: crossPermitAbi,
    functionName: "allowance",
    args: [owner as `0x${string}`, chain.token, chain.router],
    chainId: chain.id,
    query: { enabled: Boolean(owner), refetchInterval: 20_000, retry: 2 },
  });

  if (!owner) return { state: "idle" as const };
  if (read.isLoading) return { state: "loading" as const };
  if (read.error || !read.data) {
    return { state: "unreadable" as const, why: String(read.error ?? "no data").slice(0, 300) };
  }

  const [amount, expiration] = read.data as readonly [bigint, number, number];
  // Expiration 0 is a LOCK, not an unbounded grant: the contract zeroes the amount and holds it
  // there. Either way there is nothing to deploy.
  const live = expiration > Math.floor(Date.now() / 1000);
  return { state: "ok" as const, amount: live ? amount : 0n, expiration, expired: !live && amount > 0n };
}

function Deployable({ chain, owner }: { chain: (typeof CHAINS)[number]; owner?: `0x${string}` }) {
  const a = useAllowance(chain, owner);
  if (a.state === "ok") return <>{formatUnits(a.amount, 6)}</>;
  return <span title={a.state === "unreadable" ? a.why : undefined}>—</span>;
}

function ChainCapital({
  chain,
  owner,
  uncovered,
}: {
  chain: (typeof CHAINS)[number];
  owner?: `0x${string}`;
  uncovered: boolean;
}) {
  const a = useAllowance(chain, owner);
  const audit = uncovered ? " · no control-plane audit trail here" : "";

  return (
    <div className="stat" title={a.state === "unreadable" ? a.why : undefined}>
      <div className="k">{chain.name}</div>
      <div className="v">{a.state === "ok" ? formatUnits(a.amount, 6) : "—"}</div>
      <div className="n">
        {a.state === "loading" && `reading ${chain.name}…`}
        {a.state === "idle" && "no account selected"}
        {/* Never "0". A chain that could not be read has an unknown allowance, and saying zero would
            tell the desk a client has no authority where they may have a great deal. */}
        {a.state === "unreadable" && "could not be read — unknown, not zero"}
        {a.state === "ok" && (a.expired ? "expired — nothing deployable" : "unexpired allowance, 6dp")}
        {audit}
      </div>
    </div>
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
  const clients = useClients(refreshKey);
  const active = Array.isArray(clients) ? clients.filter((c) => c.owner && c.status === "active") : [];
  const [picked, setPicked] = useState<string>("");

  // The desk manages client capital, so the subject of this screen is a client by default and the
  // connected wallet only when no client is chosen. Whose figures these are is named on the page:
  // a treasury screen that silently switched account would be worse than one that showed nothing.
  const chosen = active.find((c) => c.token === picked);
  const subject = (chosen?.owner as `0x${string}` | undefined) ?? owner;
  // Only for which chains carry a control-plane audit trail. The figures themselves come from
  // storage, below.
  const treasury = useTreasury(subject, refreshKey);

  return (
    <>
      <div className="panel">
        <h2>Deployable now</h2>
        <p className="sub">
          Read off each chain's own storage: the allowance still standing to the execution desk, with
          locked and expired ones counted as nothing.
        </p>

        <div className="row" style={{ gap: 12, alignItems: "center", marginBottom: 12 }}>
          <label className="field" style={{ minWidth: 260 }}>
            <span className="lbl">Whose capital</span>
            <select value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">{owner ? "the connected wallet" : "— pick a client —"}</option>
              {active.map((c) => (
                <option key={c.token} value={c.token}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {subject && (
            <span className="mono dim">
              {chosen ? `${chosen.name} · ` : "connected wallet · "}
              {subject}
            </span>
          )}
        </div>

        {active.length === 0 && Array.isArray(clients) && (
          <p className="note">
            No client has signed a mandate yet, so there is no client capital to show. Add one on the
            clients tab.
          </p>
        )}
        {!subject && <p className="note">Connect a wallet, pick a client, or open with <code>?owner=0x…</code>.</p>}
        {subject && (
          <div className="grid">
            {CHAINS.map((c) => (
              <ChainCapital
                key={c.id}
                chain={c}
                owner={subject}
                uncovered={Boolean(treasury && treasury.uncovered?.includes(c.id))}
              />
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
                  <td>
                    <Deployable chain={c} owner={subject} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
