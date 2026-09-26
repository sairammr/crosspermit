"use client";

/**
 * One client, everything about them, on one screen.
 *
 * The desk's ledger row says a client exists and signed. This says what that signature is worth
 * today: which tokens it approved, how much of each is still deployable on which chain, who holds
 * authority over it, what the control plane recorded getting there, what the desk could honestly
 * do with it next, and — in the pools panel — the one thing it can actually do right now.
 *
 * Four sources, kept separate on screen because they answer different questions and can legally
 * disagree:
 *
 *   MultiBaas event ledger   — how the authority came to be, and every grant that has since lapsed.
 *   Chain storage (eth_call) — what the allowance is right now. The number the router will enforce.
 *   v4 PoolManager storage   — the venue: price, depth, and this client's own position.
 *   The desk's own table     — what was asked for. Never evidence of what was granted.
 *
 * Where a chain has no MultiBaas deployment the screen says so rather than rendering an empty
 * history as though nothing had happened.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { type Address, formatUnits, parseAbi } from "viem";
import { useReadContracts } from "wagmi";

import { crossPermitAbi } from "@crosspermit/sdk";
import { type ClientMandate, useMandate } from "../../../../src/clients";
import { CHAINS, CROSS_PERMIT, chainById } from "../../../../src/config";
import { DitherArea, DitherBars, HorseMatrix } from "../../../../src/dithergraph";
import { SIGNAL } from "../../../../src/dither";
import { POOLS } from "../../../../src/pools";
import { type ActivityRow, useActivity, useRelayerChains, useTreasury } from "../../../../src/relayer";
import { type Recommendation, recommend } from "../../../../src/strategies";
import { authorityOverTime, perChain, resample } from "../../../../src/series";
import { type PoolRow, PoolsPanel } from "./pools";
import "../../desk.css";
import "./client.css";

const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const num = (n: number, dp = 2) => n.toLocaleString("en-US", { maximumFractionDigits: dp });

const STATUS_LABEL: Record<ClientMandate["status"], string> = {
  awaiting: "awaiting signature",
  active: "active",
  revoked: "withdrawn",
};

/** `LOCKED_ALLOWANCE` — the expiration CrossPermit writes to mean "locked", not "expired in 1970". */
const LOCKED = 2;

function when(unix: number): string {
  if (unix === 0) return "no expiry";
  if (unix === LOCKED) return "locked";
  const ms = unix * 1000 - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)}d left` : h >= 1 ? `${h}h left` : `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

// ---------------------------------------------------------------- page

export default function ClientPage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === "string" ? params.token : undefined;
  const { state, reload } = useMandate(token);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="wrap">
      <header className="top">
        <Link className="brandmark" href="/app">
          <HorseMatrix cols={20} size={28} />
          CrossPermit
        </Link>
        <nav className="tabs">
          <Link className="tab" href="/app">
            ← back to the desk
          </Link>
        </nav>
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => {
            reload();
            setRefreshKey((k) => k + 1);
          }}
        >
          <span className="cap">Refresh</span>
        </button>
      </header>

      {state.kind === "loading" && <p className="note">Reading the mandate…</p>}
      {state.kind === "missing" && (
        <div className="panel">
          <h2>No such client</h2>
          <p className="note">That link was withdrawn or never existed. Nothing was granted under it.</p>
        </div>
      )}
      {state.kind === "offline" && (
        <div className="panel">
          <h2>The desk is unreachable</h2>
          <p className="note">
            The relayer did not answer, so this page cannot tell you what this client&rsquo;s authority is. It is not
            telling you there is none.
          </p>
        </div>
      )}
      {state.kind === "ok" && <Dashboard client={state.client} refreshKey={refreshKey} />}
    </div>
  );
}

// ---------------------------------------------------------------- the dashboard

type Row = {
  chainId: number;
  token: Address;
  spender: Address;
  decimals: number;
  symbol: string;
  granted: bigint;
  expirationLedger: number;
  balance?: bigint;
  remaining?: bigint;
  expiration?: number;
  readable: boolean;
};

function Dashboard({ client, refreshKey }: { client: ClientMandate; refreshKey: number }) {
  const owner = (client.owner ?? undefined) as Address | undefined;
  const ledger = useTreasury(owner, refreshKey);
  const activity = useActivity(owner, refreshKey);
  const platform = useRelayerChains();

  // Live v4 figures, lifted out of the pools panel so the depth chart and the panel cannot
  // disagree about what the pool holds.
  const [poolRows, setPoolRows] = useState<Record<number, PoolRow>>({});
  const onPoolRows = useCallback((rows: PoolRow[]) => {
    setPoolRows((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const r of rows) {
        const old = prev[r.chainId];
        if (!old || old.liquidity !== r.liquidity || old.tick !== r.tick) {
          next[r.chainId] = r;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Which (chain, token, spender) triples this client actually approved. The event ledger is the
  // source, because it also carries pairs whose allowance has since lapsed — which chain storage
  // cannot, and which the desk's own table never knew about.
  const approved = useMemo(() => {
    const seen = new Map<string, { chainId: number; token: Address; spender: Address; granted: bigint; expirationLedger: number }>();
    for (const r of ledger ? ledger.rows : []) {
      const key = `${r.chainId}:${r.token.toLowerCase()}:${r.spender.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.set(key, {
          chainId: r.chainId,
          token: r.token as Address,
          spender: r.spender as Address,
          granted: BigInt(r.amount),
          expirationLedger: r.expiration,
        });
      }
    }
    return [...seen.values()];
  }, [ledger]);

  // Four reads per approved triple, one round trip: symbol, decimals, the client's holding, and
  // the allowance the spender will actually be able to draw on.
  const reads = useReadContracts({
    contracts: approved.flatMap((a) => [
      { address: a.token, abi: tokenAbi, functionName: "symbol" as const, chainId: a.chainId },
      { address: a.token, abi: tokenAbi, functionName: "decimals" as const, chainId: a.chainId },
      { address: a.token, abi: tokenAbi, functionName: "balanceOf" as const, args: [owner!], chainId: a.chainId },
      {
        address: CROSS_PERMIT,
        abi: crossPermitAbi,
        functionName: "allowance" as const,
        args: [owner!, a.token, a.spender],
        chainId: a.chainId,
      },
    ]),
    query: { enabled: Boolean(owner) && approved.length > 0, refetchInterval: 30_000 },
  });

  const rows: Row[] = approved.map((a, i) => {
    const at = (k: number): unknown => {
      const r = reads.data?.[i * 4 + k];
      return r?.status === "success" ? r.result : undefined;
    };
    const decimals = typeof at(1) === "number" ? (at(1) as number) : 6;
    const live = at(3) as readonly [bigint, number, number] | undefined;
    const expiration = live ? Number(live[1]) : undefined;
    const unexpired = expiration !== undefined && expiration > Math.floor(Date.now() / 1000);
    return {
      ...a,
      decimals,
      symbol: (at(0) as string | undefined) ?? short(a.token, 4),
      balance: at(2) as bigint | undefined,
      // Never coerce an unreadable allowance to zero. On this screen zero means "nothing to
      // deploy" and unknown means "we could not ask", and acting on the first when it is the
      // second is exactly the mistake that costs a desk money.
      remaining: live === undefined ? undefined : unexpired ? live[0] : 0n,
      expiration,
      readable: live !== undefined,
    };
  });

  /** Group by symbol: one asset, however many chains and spenders it was approved to. */
  const assets = useMemo(() => {
    const by = new Map<string, Row[]>();
    for (const r of rows) by.set(r.symbol, [...(by.get(r.symbol) ?? []), r]);
    return [...by.entries()];
  }, [JSON.stringify(rows.map((r) => [r.symbol, r.chainId, r.spender, r.remaining?.toString(), r.expiration]))]);

  const uncovered = ledger ? ledger.uncovered : [];
  const totalDeployable = rows.reduce((s, r) => s + (r.remaining ?? 0n), 0n);
  const totalHeld = rows.reduce((s, r) => s + (r.balance ?? 0n), 0n);
  const anyUnreadable = rows.some((r) => !r.readable);
  const acts = activity ? activity.rows : [];

  // The yield line for the rail: the best measured rate among strategies that could run on the
  // chains this client signed for, applied to what is actually deployable.
  const yieldNow = useMemo(() => {
    const chainIds = [...new Set(rows.map((r) => r.chainId))];
    const best = recommend({ capUnits: totalDeployable, ttlHours: client.ttlHours || 720, chainIds })
      .filter((r) => r.projectedUnits !== null)
      .sort((a, b) => Number((b.projectedUnits ?? 0n) - (a.projectedUnits ?? 0n)))[0];
    return best ?? null;
  }, [totalDeployable.toString(), client.ttlHours, rows.length]);

  return (
    <div className="desk client-page">
      <div className="client-grid">
        <aside className="rail">
          <div className="panel">
            <div className="sec-head">
              <h2>{client.name}</h2>
              <span className={`tag ${client.status}`}>{STATUS_LABEL[client.status]}</span>
            </div>
            <p className="sub">{client.mandate || "No note was attached to this mandate."}</p>

            <dl className="kv-list">
              <div className="kv">
                <dt className="micro">Signed by</dt>
                <dd className="mono">{owner ? short(owner, 8) : "—"}</dd>
              </div>
              <div className="kv">
                <dt className="micro">Held across chains</dt>
                <dd>{num(Number(totalHeld) / 1e6, 4)}</dd>
              </div>
              <div className="kv">
                <dt className="micro">Deployable now</dt>
                <dd>{num(Number(totalDeployable) / 1e6, 4)}</dd>
              </div>
              <div className="kv">
                <dt className="micro">Approved triples</dt>
                <dd>
                  {approved.length || "—"} · {assets.length} asset(s)
                </dd>
              </div>
              <div className="kv">
                <dt className="micro">Chains signed</dt>
                <dd>{client.chainIds.map((id) => chainById(id)?.short ?? id).join(" · ") || "—"}</dd>
              </div>
              <div className="kv">
                <dt className="micro">Terms asked for</dt>
                <dd>
                  {client.capUnits ? formatUnits(BigInt(client.capUnits), 6) : "—"}
                  {client.ttlHours ? ` · ${client.ttlHours}h` : ""}
                </dd>
              </div>
              <div className="kv">
                <dt className="micro">Best measured rate</dt>
                <dd>
                  {yieldNow?.strategy.apy ? pct(yieldNow.strategy.apy) : "none quotable"}
                  {yieldNow?.projectedUnits ? ` → +${formatUnits(yieldNow.projectedUnits, 6)}` : ""}
                </dd>
              </div>
            </dl>

            {anyUnreadable && (
              <p className="note">Some allowance reads failed, so the deployable figure is a floor, not a total.</p>
            )}
            {uncovered.length > 0 && (
              <p className="note">
                No MultiBaas deployment on {uncovered.map((id) => chainById(id)?.name ?? id).join(", ")}. Allowances
                there are read from chain storage, but there is <strong>no control-plane audit trail</strong> — the
                history is missing whatever happened on those chains, which is not the same as nothing having
                happened.
              </p>
            )}
            {ledger === false && (
              <p className="note">
                The control plane did not answer. Approved pairs are derived from its event ledger, so this page
                cannot list them — it is not telling you there are none.
              </p>
            )}
          </div>

          <Charts acts={acts} rows={rows} poolRows={poolRows} />
        </aside>

        <main className="body">
          <Access rows={rows} platform={platform} covered={ledger ? ledger.covered : []} uncovered={uncovered} />

          <PoolsPanel owner={owner} onRows={onPoolRows} />

          {ledger && approved.length === 0 && (
            <div className="panel">
              <h2>No grants indexed</h2>
              <p className="note">
                The ledger has no grants for this account. If the client signed within the last few blocks, indexing
                may not have caught up.
              </p>
            </div>
          )}

          {assets.map(([symbol, group]) => (
            <Asset key={symbol} symbol={symbol} rows={group} ttlHours={client.ttlHours} />
          ))}

          <Activity activity={activity} uncovered={uncovered} />
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- charts

function Chart({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <figure className="chart">
      <figcaption>
        <span className="micro">{title}</span>
      </figcaption>
      <div className="plot">{children}</div>
      <p className="note">{note}</p>
    </figure>
  );
}

function Charts({ acts, rows, poolRows }: { acts: ActivityRow[]; rows: Row[]; poolRows: Record<number, PoolRow> }) {
  const chainIds = CHAINS.map((c) => c.id);
  const series = useMemo(() => resample(authorityOverTime(acts), 72), [acts]);
  const byChain = useMemo(() => perChain(acts, chainIds), [acts]);
  const depth = chainIds.map((id) => Number(poolRows[id]?.liquidity ?? 0n) / 1e6);
  const drift = chainIds.map((id) => Math.abs((poolRows[id]?.price ?? 1) - 1) * 1e4);
  const consumed = rows.map((r) =>
    r.remaining === undefined || r.granted === 0n ? 0 : Number(r.granted - r.remaining) / 1e6,
  );

  const first = acts.length ? Math.min(...acts.filter((a) => a.timestamp).map((a) => a.timestamp!)) : 0;
  const last = acts.length ? Math.max(...acts.filter((a) => a.timestamp).map((a) => a.timestamp!)) : 0;
  const span = first && last ? Math.max(1, Math.round((last - first) / 60)) : 0;

  return (
    <div className="panel charts">
      <div className="sec-head">
        <h2>How it grew</h2>
        <span className="label">02 / Real reads</span>
      </div>
      <p className="sub">
        Every series is folded from records that exist: MultiBaas-indexed <span className="mono">Permit</span> events
        for authority, PoolManager storage for depth. No projections, no interpolation between invented points.
      </p>

      <Chart
        title="Authority outstanding, over time"
        note={
          series.length
            ? `Step series over ${acts.length} indexed event(s) spanning ${span} minute(s), summed across every (chain, token) pair. A permit sets a pair's allowance; a LOCK takes it to zero.`
            : "Nothing indexed yet, so there is no series to draw. An empty chart here means no events, not no authority."
        }
      >
        {series.length > 1 ? <DitherArea values={series} variant="gradient" bloom="low" baseline={0.08} /> : null}
      </Chart>

      <Chart
        title="Authority standing, per chain"
        note={`${CHAINS.map((c, i) => `${c.short} ${num(byChain[i] ?? 0)}`).join(" · ")}. Last state of every pair on that chain, from the same events.`}
      >
        {byChain.some((v) => v > 0) ? <DitherBars values={byChain} hotIndex={byChain.indexOf(Math.max(...byChain))} /> : null}
      </Chart>

      <Chart
        title="v4 pool depth, per chain"
        note={`${CHAINS.map((c, i) => `${c.short} ${num(depth[i] ?? 0)}`).join(" · ")}. In-range liquidity L/1e6, read live from each PoolManager's storage.`}
      >
        {depth.some((v) => v > 0) ? <DitherBars values={depth} color={SIGNAL} /> : null}
      </Chart>

      <Chart
        title="Pool price drift from 1:1, bps"
        note={`${CHAINS.map((c, i) => `${c.short} ${num(drift[i] ?? 0, 1)}`).join(" · ")}. Every pool was seeded at 1:1, so this is what trading has moved it by — the fee income side of an LP position, and the divergence side too.`}
      >
        {drift.some((v) => v > 0) ? <DitherBars values={drift} variant="dotted" /> : null}
      </Chart>

      <Chart
        title="Consumed per approved grant"
        note={
          consumed.some((v) => v > 0)
            ? "Granted minus what still stands, per (chain, token, spender). A bar here is capital the desk has already put to work."
            : "Nothing consumed yet: every grant still stands at the amount it was signed for."
        }
      >
        {consumed.some((v) => v > 0) ? <DitherBars values={consumed} /> : null}
      </Chart>
    </div>
  );
}

// ---------------------------------------------------------------- access

/** Who can spend this client's money, and which platform pieces are watching. */
function Access({
  rows,
  platform,
  covered,
  uncovered,
}: {
  rows: Row[];
  platform: ReturnType<typeof useRelayerChains>;
  covered: number[];
  uncovered: number[];
}) {
  const label = (chainId: number, spender: Address) => {
    const chain = chainById(chainId);
    if (chain && spender.toLowerCase() === chain.router.toLowerCase()) return "execution desk · Universal Router";
    const pool = POOLS.find((p) => p.chainId === chainId);
    if (pool && spender.toLowerCase() === pool.liquidityDesk.toLowerCase()) return "liquidity desk · v4 LP adapter";
    // Named, never hidden. An allowance to something this dashboard cannot identify is the single
    // most important row on the page.
    return "unrecognised spender";
  };

  const live = rows.filter((r) => (r.remaining ?? 0n) > 0n);

  return (
    <div className="panel">
      <div className="sec-head">
        <h2>Who can spend this, and what is watching</h2>
        <span className="label">03 / Access</span>
      </div>
      <p className="sub">
        A treasury&rsquo;s real exposure is not its balance. It is every allowance it has signed and not yet retracted
        — one row each, with the spender named rather than left as a hex string.
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Spender</th>
              <th>Address</th>
              <th>Chain</th>
              <th>Asset</th>
              <th className="num">Granted</th>
              <th className="num">Still spendable</th>
              <th>Expiry</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const name = label(r.chainId, r.spender);
              const chain = chainById(r.chainId);
              return (
                <tr key={`${r.chainId}:${r.token}:${r.spender}`}>
                  <td>
                    {name}
                    {name === "unrecognised spender" && (
                      <span className="sub-line">not the router and not the liquidity desk — worth asking about</span>
                    )}
                  </td>
                  <td>
                    <a href={`${chain?.explorer ?? ""}/address/${r.spender}`} target="_blank" rel="noreferrer">
                      {short(r.spender)}
                    </a>
                  </td>
                  <td>{chain?.name ?? r.chainId}</td>
                  <td>{r.symbol}</td>
                  <td className="num">{formatUnits(r.granted, r.decimals)}</td>
                  <td className="num">
                    {r.remaining === undefined ? <span title="the read failed">unknown</span> : formatUnits(r.remaining, r.decimals)}
                  </td>
                  <td>{r.expiration === undefined ? "—" : when(r.expiration)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7}>No standing authority indexed for this client.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="note">
        {live.length} of {rows.length} grant(s) can still be drawn on right now. Withdrawing the client&rsquo;s link on
        the desk does not touch any of these: an allowance is retired by a cross-chain{" "}
        <span className="mono">LOCK</span>, not by an invitation being cancelled.
      </p>

      <h3 className="grp">Platform</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Chain</th>
              <th>Relayer signer</th>
              <th>Custody</th>
              <th>Audit trail</th>
              <th>v4 pool</th>
              <th>Liquidity desk</th>
            </tr>
          </thead>
          <tbody>
            {CHAINS.map((c) => {
              const p = platform ? platform.chains.find((x) => x.chainId === c.id) : undefined;
              const pool = POOLS.find((x) => x.chainId === c.id);
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{p ? short(p.signer) : "—"}</td>
                  <td>{p?.custody ?? "—"}</td>
                  <td>
                    <span className={`tag ${covered.includes(c.id) ? "ok" : "warn"}`}>
                      {covered.includes(c.id) ? "MultiBaas" : "none"}
                    </span>
                  </td>
                  <td>
                    {pool ? (
                      <a href={`${c.explorer}/address/${pool.poolManager}`} target="_blank" rel="noreferrer">
                        {short(pool.poolManager, 5)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {pool ? (
                      <a href={`${c.explorer}/address/${pool.liquidityDesk}`} target="_blank" rel="noreferrer">
                        {short(pool.liquidityDesk, 5)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">
        {platform === false
          ? "The relayer did not answer, so its signer and custody per chain are unknown."
          : `Control plane covers ${covered.length} of ${CHAINS.length} chains${
              uncovered.length ? `; ${uncovered.map((id) => chainById(id)?.short ?? id).join(", ")} runs on the local signer with no indexed history` : ""
            }.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- one approved asset

function Asset({ symbol, rows, ttlHours }: { symbol: string; rows: Row[]; ttlHours: number }) {
  const decimals = rows[0]?.decimals ?? 6;
  const chainIds = [...new Set(rows.map((r) => r.chainId))];
  // The recommender is given what actually stands, not what the desk asked for: the smallest live
  // per-chain allowance, because a strategy has to fit the weakest chain it will run on.
  const capUnits = rows.reduce((m, r) => (r.remaining !== undefined && r.remaining < m ? r.remaining : m), 2n ** 255n);
  const cap = capUnits === 2n ** 255n ? 0n : capUnits;
  // Hours left on the shortest-lived grant. That, not the desk's requested TTL, is how long a
  // position actually has.
  const hoursLeft = rows.reduce((m, r) => {
    const h = r.expiration ? Math.max(0, Math.floor((r.expiration * 1000 - Date.now()) / 3_600_000)) : 0;
    return Math.min(m, h);
  }, Number.POSITIVE_INFINITY);
  const ttl = Number.isFinite(hoursLeft) && hoursLeft > 0 ? hoursLeft : ttlHours;

  const recs = useMemo(() => recommend({ capUnits: cap, ttlHours: ttl, chainIds }), [cap.toString(), ttl, chainIds.join()]);
  const routable = recs.filter((r) => r.routable);
  const hedges = recs.filter((r) => r.strategy.kind === "hedge");
  const designed = recs.filter((r) => !r.routable && r.strategy.kind !== "hedge");

  return (
    <div className="panel">
      <div className="sec-head">
        <h2>{symbol}</h2>
        <span className="label">05 / Approved asset</span>
        <span className={`tag ${cap > 0n ? "active" : "awaiting"}`}>
          {cap > 0n ? `${formatUnits(cap, decimals)} deployable everywhere` : "nothing deployable"}
        </span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Chain</th>
              <th>Spender</th>
              <th className="num">Held</th>
              <th className="num">Still deployable</th>
              <th>Expiry</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const chain = chainById(r.chainId);
              const over = r.balance !== undefined && r.remaining !== undefined && r.remaining > r.balance;
              return (
                <tr key={`${r.chainId}:${r.token}:${r.spender}`}>
                  <td>{chain?.name ?? r.chainId}</td>
                  <td>
                    <a href={`${chain?.explorer ?? ""}/address/${r.spender}`} target="_blank" rel="noreferrer">
                      {short(r.spender)}
                    </a>
                  </td>
                  <td className="num">{r.balance === undefined ? "—" : formatUnits(r.balance, r.decimals)}</td>
                  <td className="num">
                    {r.remaining === undefined ? (
                      <span title="the read failed — unknown, not zero">unknown</span>
                    ) : (
                      formatUnits(r.remaining, r.decimals)
                    )}
                    {over && <span className="sub-line">exceeds the holding — authority that cannot be honoured</span>}
                  </td>
                  <td>{r.expiration === undefined ? "—" : when(r.expiration)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="grp">What this mandate can be put into</h3>
      {routable.length === 0 ? (
        <p className="note">
          Nothing is routable for {symbol} on these terms. Every row below says which of the four gates it failed: no
          deployment, wrong chain, too short, or too small.
        </p>
      ) : (
        routable.map((r) => <Rec key={r.strategy.key} rec={r} decimals={decimals} ttl={ttl} />)
      )}

      <h3 className="grp">Hedge overlays</h3>
      <p className="sub">
        What a fund desk would actually reach for on a book like this — and, for each, the leg that does not exist
        here. None of these is a button, and the reason is on the row.
      </p>
      {hedges.map((r) => (
        <Rec key={r.strategy.key} rec={r} decimals={decimals} ttl={ttl} />
      ))}

      {designed.length > 0 && (
        <>
          <h3 className="grp">Measured, but not reachable from here</h3>
          {designed.map((r) => (
            <Rec key={r.strategy.key} rec={r} decimals={decimals} ttl={ttl} />
          ))}
        </>
      )}
    </div>
  );
}

function Rec({ rec, decimals, ttl }: { rec: Recommendation; decimals: number; ttl: number }) {
  const s = rec.strategy;
  return (
    <section className={`rec ${rec.routable ? "on" : "off"}`} aria-labelledby={`rec-${s.key}`}>
      <div className="rec-head">
        <h4 id={`rec-${s.key}`}>{s.venue}</h4>
        <span className="micro kindtag">{s.kind}</span>
        <span className={`tag ${rec.routable ? "active" : "awaiting"}`}>
          {rec.routable ? `routable on ${rec.on.map((id) => chainById(id)?.short ?? id).join(" · ")}` : "not routable"}
        </span>
        <span className="micro score" title="fit against this mandate's own terms — not a prediction of returns">
          fit {rec.score}
        </span>
      </div>
      <p>{s.what}</p>

      <dl className="kv-list">
        <div className="kv">
          <dt className="micro">Rate</dt>
          <dd>{s.apy === null ? "not quotable" : pct(s.apy)}</dd>
        </div>
        <div className="kv">
          <dt className="micro">Over {ttl}h</dt>
          <dd>
            {rec.projectedUnits === null ? "—" : `+${formatUnits(rec.projectedUnits, decimals)}`}
            {rec.projectedUnits !== null && !rec.routable ? " (if it were reachable)" : ""}
          </dd>
        </div>
        <div className="kv">
          <dt className="micro">Legs</dt>
          <dd>{s.legs.join(" → ")}</dd>
        </div>
      </dl>

      <p className="note">
        <strong>Evidence.</strong> {s.evidence}
      </p>
      <p className="note">
        <strong>Costs.</strong> {s.risks.join(". ")}.
      </p>
      {rec.blocked ? (
        <p className="note blocked">
          <strong>Blocked.</strong> {rec.blocked}. Shown rather than hidden, because a desk asking what it could do
          with this mandate deserves the real answer and the reason it is not one.
        </p>
      ) : (
        <div className="row">
          <span className="micro">
            {s.key === "v4-lp" || s.key === "v4-swap"
              ? "armed from the pools panel above, against the live pool"
              : rec.because.join(" · ")}
          </span>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- history

function Activity({ activity, uncovered }: { activity: ReturnType<typeof useActivity>; uncovered: number[] }) {
  const KIND: Record<ActivityRow["kind"], string> = {
    granted: "granted",
    locked: "locked",
    cleared: "cleared to zero",
    cancelled: "salt burned",
  };

  return (
    <div className="panel">
      <div className="sec-head">
        <h2>Everything the control plane recorded</h2>
        <span className="label">06 / MultiBaas event ledger</span>
      </div>
      <p className="sub">
        Decoded from indexed <span className="mono">Permit</span>, <span className="mono">Lockdown</span> and{" "}
        <span className="mono">NonceInvalidated</span> events. Ordered by the timestamp the client signed, which is the
        ordering CrossPermit itself applies — not by the block that happened to land first.
      </p>

      {activity === null && <p className="note">Reading…</p>}
      {activity === false && <p className="note">The control plane did not answer. History unknown, not empty.</p>}
      {activity && activity.rows.length === 0 && (
        <p className="note">
          Nothing indexed for this account yet
          {uncovered.length ? " on the chains MultiBaas covers" : ""}.
        </p>
      )}
      {activity && activity.rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Signed at</th>
                <th>What</th>
                <th>Chain</th>
                <th>Token</th>
                <th>Spender</th>
                <th className="num">Amount</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {activity.rows.map((r, i) => (
                <tr key={`${r.txHash}:${i}`}>
                  <td>{r.timestamp ? new Date(r.timestamp * 1000).toISOString().replace("T", " ").slice(0, 16) : "—"}</td>
                  <td>
                    <span className={`tag ${r.kind === "granted" ? "active" : r.kind === "locked" ? "bad" : "warn"}`}>
                      {KIND[r.kind]}
                    </span>
                  </td>
                  <td>{r.chainName}</td>
                  <td>{r.token ? short(r.token, 4) : "—"}</td>
                  <td>{r.spender ? short(r.spender, 4) : "—"}</td>
                  <td className="num">{r.amount ? formatUnits(BigInt(r.amount), 6) : "—"}</td>
                  <td>
                    {r.explorer ? (
                      <a href={r.explorer} target="_blank" rel="noreferrer">
                        {short(r.txHash ?? "", 6)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="note">
        Covers {activity ? activity.covered.length : 0} of {CHAINS.length} chains. An allowance that has since expired
        left no storage behind but did leave a row here, which is why this table and the deployable figures above can
        legitimately disagree.
      </p>
    </div>
  );
}
