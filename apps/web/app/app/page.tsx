"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useSignTypedData, useSwitchChain } from "wagmi";

import { SIGNING_CHAIN_ID, approveEntry, lockEntry, prepareIntent, toWire } from "@crosspermit/sdk";
import { CHAINS, CROSS_PERMIT, RELAYER_URL, WC_PROJECT_ID, chainById } from "../../src/config";
import { ProveOwnership } from "../../src/session-ui";
import { onSigningChain } from "../../src/wagmi";
import { HorseMatrix } from "../../src/dithergraph";
import { ClientsTab, StrategiesTab } from "./desk";
import {
  type IntentStatus,
  postIntent,
  useIntentStream,
  useQuota,
  useRecentIntents,
  useRelayerChains,
  useTreasury,
} from "../../src/relayer";

const TABS = ["clients", "permission", "relayer", "treasury", "strategies", "yield", "audit"] as const;
type Tab = (typeof TABS)[number];

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

/** Section head: "0N / NAME" beside the title, kit style. */
function SecHead({ n, name, title }: { n: number; name: string; title: string }) {
  return (
    <div className="sec-head">
      <h2>{title}</h2>
      <span className="label">
        {String(n).padStart(2, "0")} / {name}
      </span>
    </div>
  );
}

export default function Page() {
  const [tab, setTab] = useState<Tab>("clients");
  const { address, isConnected } = useAccount();
  const [intentId, setIntentId] = useState<string | null>(null);
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

  return (
    <div className="wrap">
      <header className="top">
        <a className="brandmark" href="/">
          <HorseMatrix cols={20} size={28} />
          CrossPermit
        </a>

        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} aria-selected={tab === t} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>

        <div className="row" style={{ gap: 14 }}>
          {/* One control, not two. Connecting a wallet and proving you hold its key are different
              facts, but they were never two decisions — this walks both, and afterwards it is the
              account button. */}
          <ProveOwnership onChange={() => setRefreshKey((k) => k + 1)} />
        </div>
      </header>

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

      {tab === "permission" && (
        <Permission
          owner={address}
          connected={isConnected}
          onSubmitted={(id) => {
            setIntentId(id);
            setRefreshKey((k) => k + 1);
            setTab("relayer");
          }}
        />
      )}
      {tab === "relayer" && (
        <RelayerTab intentId={intentId} onPick={setIntentId} refreshKey={refreshKey} owner={subject} />
      )}
      {tab === "clients" && <ClientsTab refreshKey={refreshKey} onChange={() => setRefreshKey((k) => k + 1)} />}
      {tab === "treasury" && <Treasury owner={subject} refreshKey={refreshKey} />}
      {tab === "strategies" && <StrategiesTab owner={subject} refreshKey={refreshKey} />}
      {tab === "yield" && <Yield />}
      {tab === "audit" && <Audit intentId={intentId} />}
    </div>
  );
}

// ---------------------------------------------------------------- permission

function Permission({
  owner,
  connected,
  onSubmitted,
}: {
  owner?: `0x${string}`;
  connected: boolean;
  onSubmitted: (id: string) => void;
}) {
  const [amount, setAmount] = useState("5");
  const [hours, setHours] = useState("24");
  const [lock, setLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();

  // Built eagerly so the payload is on screen BEFORE the wallet asks. A signer who only ever sees
  // an opaque merkleRoot in their wallet is trusting the page; showing the bundles first is the
  // whole point of computing the leaves client-side.
  const preview = useMemo(() => {
    if (!owner) return null;
    try {
      const now = Math.floor(Date.now() / 1000);
      const units = parseUnits(amount || "0", 6);
      if (units === 0n) return null;
      const expiry = now + Number(hours || "24") * 3600;
      return prepareIntent({
        crossPermit: CROSS_PERMIT,
        owner,
        now,
        ttl: 3600,
        chains: CHAINS.map((c) => ({
          chainId: c.id,
          permits: lock ? [lockEntry(c.token, c.router)] : [approveEntry(c.token, c.router, units, expiry)],
        })),
      });
    } catch {
      return null;
    }
  }, [owner, amount, hours, lock]);

  async function submit() {
    if (!preview || !owner) return;
    setBusy(true);
    setError(null);
    try {
      // The wallet will not sign a domain pinned to a chain it is not on, and it does not switch
      // itself, so ask it to move first. No transaction follows — the signature is spent on the
      // chains the mandate names, never on the signing domain's chain.
      await onSigningChain(chainId, switchChainAsync);
      const signature = await signTypedDataAsync({ ...preview.typedData, chainId: SIGNING_CHAIN_ID } as never);
      const { status, body } = await postIntent(toWire({ ...preview.intent, signature }));
      if (status >= 400) throw new Error(`${body.code ?? status}: ${body.error ?? "rejected"}`);
      onSubmitted(String(body.intentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SecHead n={2} name="permission" title={`One permission, ${CHAINS.length} chains`} />

      <div className="panel">
        <span className="label">Build</span>
        <p className="sub">
          One EIP-712 message over a merkle root of per-chain bundles. Sign once; the relayer submits every leg.
        </p>

        <div className="grid">
          <label className="field">
            <span className="lbl">Amount per chain (6dp)</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <label className="field">
            <span className="lbl">Allowance expires in (hours)</span>
            <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="lbl">Mode</span>
            <select value={lock ? "lock" : "approve"} onChange={(e) => setLock(e.target.value === "lock")}>
              <option value="approve">Approve the router</option>
              <option value="lock">LOCK the router (cross-chain kill switch)</option>
            </select>
          </label>
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn btn-action" disabled={!connected || !preview || busy} onClick={submit}>
            <span className="cap">{busy ? "signing…" : "Sign permission"}</span>
          </button>
          {!connected && <span className="micro">connect a wallet to sign</span>}
        </div>
        {error && <div className="err">{error}</div>}
      </div>

      <div className="panel">
        <span className="label">What you are about to sign</span>
        <p className="sub">
          Every leaf is computed in this browser and folded into the root below. Nothing here came from an RPC — a leaf
          that did would let a hostile endpoint choose what you sign.
        </p>

        {!preview ? (
          <p className="note">Connect a wallet and enter an amount.</p>
        ) : (
          <>
            <div className="grid" style={{ marginBottom: 16 }}>
              <div className="stat">
                <div className="k">merkle root</div>
                <div className="v">{short(preview.intent.root, 10)}</div>
                <div className="n">signed once, valid on every chain</div>
              </div>
              <div className="stat">
                <div className="k">salt</div>
                <div className="v">{short(preview.intent.salt, 10)}</div>
                <div className="n">replay protection, retractable</div>
              </div>
              <div className="stat">
                <div className="k">signature deadline</div>
                <div className="v">{new Date(preview.intent.deadline * 1000).toLocaleTimeString()}</div>
                <div className="n">the relayer refuses inside 60s of this</div>
              </div>
            </div>

            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Chain</th>
                    <th>Action</th>
                    <th>Spender</th>
                    <th className="num">Amount</th>
                    <th className="num">Proof</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.intent.legs.map((leg) => {
                    const c = chainById(leg.chainId)!;
                    const p = leg.bundle.permits[0]!;
                    return (
                      <tr key={leg.chainId}>
                        <td>
                          {c.name} <span className="dim">{leg.chainId}</span>
                        </td>
                        <td>
                          {p.modeOrExpiration === 2 ? (
                            <span className="tag bad">LOCK</span>
                          ) : (
                            <span className="tag ok">APPROVE</span>
                          )}
                        </td>
                        <td>{short(p.account)}</td>
                        <td className="num">{p.modeOrExpiration === 2 ? "—" : formatUnits(p.amountDelta, 6)}</td>
                        <td className="num dim">
                          {leg.proof.length} node{leg.proof.length === 1 ? "" : "s"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note">
              The last chain carries a one-node proof because the tree leans left — order the chains cheapest first so
              the dearest one gets the smallest calldata.
            </p>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- relayer

function RelayerTab({
  intentId,
  onPick,
  refreshKey,
  owner,
}: {
  intentId: string | null;
  onPick: (id: string) => void;
  refreshKey: number;
  owner?: `0x${string}`;
}) {
  const chains = useRelayerChains();
  const { status, connected } = useIntentStream(intentId);
  const recent = useRecentIntents(refreshKey);
  const quota = useQuota(owner, refreshKey);

  return (
    <>
      <SecHead n={3} name="relayer" title="Relayer" />

      <div className="panel">
        <span className="label">Endpoint</span>
        <p className="sub">
          <span className="mono">{RELAYER_URL}</span> — one POST covers every chain. It can pay gas and refuse to
          submit; it cannot change who receives anything.
        </p>

        {chains === null && <p className="note">connecting…</p>}
        {chains === false && (
          <p className="err">
            unreachable. Start it: <span className="mono">bun run apps/relayer/src/server.ts</span>
          </p>
        )}
        {chains && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Chain</th>
                  <th>Signer</th>
                  <th>Custody</th>
                  <th>Audit trail</th>
                </tr>
              </thead>
              <tbody>
                {chains.chains.map((c) => (
                  <tr key={c.chainId}>
                    <td>
                      {c.name} <span className="dim">{c.chainId}</span>
                    </td>
                    <td>{short(c.signer)}</td>
                    <td>
                      <span className={`tag ${c.custody === "local" ? "warn" : "ok"}`}>{c.custody}</span>
                    </td>
                    <td>
                      {c.auditTrail === "multibaas" ? (
                        <span className="tag ok">multibaas</span>
                      ) : (
                        <span className="tag">none</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {quota && (
          <p className="note">
            Your remaining quota this window: {quota.intents} intents, {(Number(quota.gasWei) / 1e18).toFixed(4)} ETH of
            gas, resetting in {Math.ceil(quota.resetsInMs / 1000)}s.
          </p>
        )}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 24 }}>
          <span className="label">Live fan-out</span>
          <span className={`status ${connected ? "live" : ""}`}>
            <i />
            {connected ? "streaming" : "idle"}
          </span>
        </div>
        <p className="sub">
          {intentId ? <span className="mono">{intentId}</span> : "sign an intent, or pick one below"}
        </p>
        {status ? <LegTable status={status} /> : <p className="note">nothing in flight.</p>}
      </div>

      <div className="panel">
        <span className="label">Recent intents</span>
        <p className="sub">Every signature this relayer has fanned out.</p>
        {recent.length === 0 ? (
          <p className="note">none yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Intent</th>
                  <th>Owner</th>
                  <th>Root</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.map((i) => (
                  <tr key={i.intentId}>
                    <td>{short(i.intentId)}</td>
                    <td>{short(i.owner)}</td>
                    <td className="dim">{short(i.root)}</td>
                    <td className="dim">{new Date(i.createdAt).toLocaleTimeString()}</td>
                    <td className="num">
                      <button className="btn btn-sm" onClick={() => onPick(i.intentId)}>
                        <span className="cap">view</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function LegTable({ status }: { status: IntentStatus }) {
  const tone = (s: string) => (s === "confirmed" ? "ok" : s === "failed" ? "bad" : "warn");
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Chain</th>
            <th>Status</th>
            <th>Transaction</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {status.legs.map((leg) => {
            const c = chainById(leg.chainId);
            return (
              <tr key={leg.chainId}>
                <td>
                  {c?.name ?? leg.chainId} <span className="dim">{leg.chainId}</span>
                </td>
                <td>
                  <span className={`tag ${tone(leg.status)}`}>{leg.status}</span>
                </td>
                <td>
                  {leg.txHash ? (
                    <a href={`${c?.explorer}/tx/${leg.txHash}`} target="_blank" rel="noreferrer">
                      {short(leg.txHash)}
                    </a>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td className="prose" style={{ maxWidth: 380 }}>
                  {leg.error ?? (leg.status === "confirmed" ? "applied" : "")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- treasury

function Treasury({ owner, refreshKey }: { owner?: `0x${string}`; refreshKey: number }) {
  const view = useTreasury(owner, refreshKey);

  return (
    <>
      <SecHead n={4} name="treasury" title="Outstanding authority" />

      <div className="panel">
        <span className="label">Ledger</span>
        <p className="sub">
          What this account has authorised, to whom, on which chain — decoded from indexed{" "}
          <span className="mono">Permit</span> events in the MultiBaas control plane, not read from chain storage.
          Storage answers what an allowance is now; an auditor asks how it got there.
        </p>

        {!owner && <p className="note">connect a wallet.</p>}
        {owner && view === null && <p className="note">reading the control plane…</p>}
        {owner && view === false && <p className="err">relayer unreachable — start it to read the ledger.</p>}

        {owner && view && typeof view === "object" && (
          <>
            {view.error && <p className="err">{view.error}</p>}

            {view.rows.length === 0 ? (
              <p className="note">
                No indexed authority for this account yet. Indexing starts at the block CrossPermit was registered, so
                activity from before that is not shown.
              </p>
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Chain</th>
                      <th>Token</th>
                      <th>Spender</th>
                      <th className="num">Amount</th>
                      <th>State</th>
                      <th>Signed at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((r) => (
                      <tr key={`${r.chainId}:${r.token}:${r.spender}`}>
                        <td>
                          {r.chainName} <span className="dim">{r.chainId}</span>
                        </td>
                        <td>{short(r.token)}</td>
                        <td>{short(r.spender)}</td>
                        <td className="num">{(Number(r.amount) / 1e6).toLocaleString()}</td>
                        <td>
                          <span
                            className={`tag ${r.state === "locked" ? "bad" : r.state === "active" ? "ok" : "warn"}`}
                          >
                            {r.state}
                          </span>
                        </td>
                        <td className="dim">
                          {r.explorer ? (
                            <a href={r.explorer} target="_blank" rel="noreferrer">
                              {new Date(r.timestamp * 1000).toLocaleString()}
                            </a>
                          ) : (
                            new Date(r.timestamp * 1000).toLocaleString()
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid" style={{ marginTop: 16 }}>
              <div className="stat">
                <div className="k">chains with an audit trail</div>
                <div className="v">{view.covered.length}</div>
                <div className="n">{view.covered.join(", ") || "none"}</div>
              </div>
              <div className="stat">
                <div className="k">chains without one</div>
                <div className="v">{view.uncovered.length}</div>
                <div className="n">{view.uncovered.join(", ") || "none"}</div>
              </div>
            </div>

            {view.uncovered.length > 0 && (
              <p className="note">
                Chain{view.uncovered.length > 1 ? "s" : ""} {view.uncovered.join(", ")} ha
                {view.uncovered.length > 1 ? "ve" : "s"} no MultiBaas deployment, so nothing indexes
                {view.uncovered.length > 1 ? " them" : " it"} and authority there will never appear in this table. That
                is a gap in the record, not an absence of exposure — a free-tier account gets one deployment per
                network.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- yield

function Yield() {
  // Measured live on mainnet by contracts/test/TreasuryFork.t.sol. Shown as recorded figures with
  // their provenance, not as a live feed this page is polling — claiming live would be a lie.
  const rows = [
    { k: "Supply APR", v: "3.976%", n: "derived: drawnRate x utilisation x (1 - liquidityFee)" },
    { k: "Supply APY", v: "4.056%", n: "APR compounded per second; always at or above APR" },
    { k: "Utilisation", v: "90.16%", n: "measured at the Hub, where v4 liquidity actually lives" },
    { k: "Round trip", v: "+32.65 USDC", n: "10 000 USDC supplied, withdrawn after 30 days" },
  ];

  return (
    <>
      <SecHead n={6} name="yield" title="Yield" />

      <div className="panel">
        <span className="label">Aave v4 — Core Hub, MAIN Spoke</span>
        <p className="sub">
          Principal is pulled through CrossPermit, so deploying idle cash rides the same single signature as everything
          else in the intent.
        </p>
        <div className="grid">
          {rows.map((r) => (
            <div className="stat" key={r.k}>
              <div className="k">{r.k}</div>
              <div className="v">{r.v}</div>
              <div className="n">{r.n}</div>
            </div>
          ))}
        </div>
        <p className="note">
          Figures recorded from <span className="mono">FORK=1 forge test --match-contract TreasuryFork</span> against
          live Ethereum mainnet. APR and APY are separate numbers on purpose: the Hub exposes only a borrow rate, so
          supply APR is derived, and a treasury that reports a borrow rate as its own yield overstates its returns.
        </p>
      </div>

      <div className="panel">
        <span className="label">Tokenized equities</span>
        <p className="sub">NVIDIA and peers, funded by the same signature.</p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Token</th>
                <th>Venue</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>NVIDIA (Ondo Tokenized)</td>
                <td>
                  <a
                    href="https://etherscan.io/token/0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE"
                    target="_blank"
                    rel="noreferrer"
                  >
                    NVDAon
                  </a>
                </td>
                <td className="dim">issuer mint / redeem</td>
                <td>
                  <span className="tag warn">venue adapter pending</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="note">
          The desk&apos;s guards are proved against the real token: compliance gate deny-by-default, oracle staleness
          bound, and a price-deviation band. The venue itself is still a mock, because NVDAon&apos;s on-chain route is
          the issuer&apos;s gated mint/redeem window rather than an AMM anyone can trade against. Stated plainly rather
          than demoed as if it were live.
        </p>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- audit

function Audit({ intentId }: { intentId: string | null }) {
  const { status } = useIntentStream(intentId);

  return (
    <>
      <SecHead n={7} name="audit" title="One signature, every record it produced" />

      <div className="panel">
        <span className="label">Record</span>
        <p className="sub">
          The screen a risk committee asks for: a single authorisation expanded into the N on-chain transactions it
          caused, instead of N separate approval logs to reconcile.
        </p>

        {!status ? (
          <p className="note">sign an intent, or pick one from the relayer tab.</p>
        ) : (
          <>
            <div className="grid" style={{ marginBottom: 16 }}>
              <div className="stat">
                <div className="k">intent</div>
                <div className="v">{short(status.intentId, 8)}</div>
                <div className="n">keyed on owner, salt and root</div>
              </div>
              <div className="stat">
                <div className="k">signed root</div>
                <div className="v">{short(status.root, 8)}</div>
                <div className="n">one signature covered every leg</div>
              </div>
              <div className="stat">
                <div className="k">outcome</div>
                <div className="v">{status.done ? (status.ok ? "complete" : "partial") : "in flight"}</div>
                <div className="n">
                  {status.legs.filter((l) => l.status === "confirmed").length}/{status.legs.length} chains confirmed
                </div>
              </div>
            </div>
            <LegTable status={status} />
          </>
        )}
      </div>
    </>
  );
}
