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
import { Rail } from "../../../rail";
import { SIGNAL } from "../../../../src/dither";
import { POOLS } from "../../../../src/pools";
import { type ActivityRow, useActivity, useRelayerChains, useTreasury } from "../../../../src/relayer";
import { recommend } from "../../../../src/strategies";
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

/** The chain's own mark, served from this app. A badge reads faster than a chain name in a cell. */
const CHAIN_LOGO: Record<number, string> = {
  84532: "/logos/base.png",
  11155111: "/logos/ethereum.png",
  11155420: "/logos/optimism.png",
};

/** A chain, as a badge: mark plus short name. Used wherever a table used to carry a "Chain" column. */
function ChainTag({ chainId }: { chainId: number }) {
  const c = chainById(chainId);
  return (
    <span className="chain-tag">
      {CHAIN_LOGO[chainId] && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={CHAIN_LOGO[chainId]!} alt="" width={14} height={14} />
      )}
      {c?.short ?? chainId}
    </span>
  );
}

/** One proportion, drawn. `of` is the whole; a zero whole means there is nothing to draw. */
function Meter({ value, of, tone }: { value: number; of: number; tone?: "ok" | "warn" | "bad" }) {
  const pctFull = of > 0 ? Math.max(0, Math.min(100, (value / of) * 100)) : 0;
  return (
    <span className={`meter${tone ? ` m-${tone}` : ""}`} role="img" aria-label={`${pctFull.toFixed(0)}%`}>
      <i style={{ width: `${pctFull}%` }} />
    </span>
  );
}

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
      {/* One key, because there is one way out of a client record: back to the book it came from. */}
      <Rail
        variant="inline"
        go={null}
        items={[{ key: "desk", label: "← The desk", href: "/app" }]}
        brand={
          <Link href="/app">
            <HorseMatrix cols={20} size={24} tone="light" />
            CrossPermit
          </Link>
        }
        aside={
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
        }
      />

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

// ---------------------------------------------------------------- views

type TabKey = "overview" | "positions" | "history";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "positions", label: "Positions" },
  { key: "history", label: "History" },
];

/** Three readings of the same mandate. Console keys, because the rail above is console keys. */
function Tabs({
  tab,
  onTab,
  counts,
}: {
  tab: TabKey;
  onTab: (t: TabKey) => void;
  counts: { positions: number; history: number };
}) {
  return (
    <nav className="subtabs" aria-label="Client views">
      {TABS.map((t) => {
        const n = t.key === "positions" ? counts.positions : t.key === "history" ? counts.history : 0;
        return (
          <button
            key={t.key}
            type="button"
            className={`btn btn-sm${tab === t.key ? " on" : ""}`}
            aria-current={tab === t.key ? "page" : undefined}
            onClick={() => onTab(t.key)}
          >
            <span className="cap">
              {t.label}
              {n > 0 && <b className="count">{n}</b>}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * The book in five figures, the way a portfolio screen opens: what is held, what of it is dry
 * powder, how much of the holding the desk can actually reach, how wide the book is spread, and the
 * best rate anything measurable would pay on it. A ledger that refused reads "could not" — never 0.
 */
function Book({
  held,
  deployable,
  positions,
  assets,
  chains,
  yieldNow,
  unread,
}: {
  held: bigint;
  deployable: bigint;
  positions: number;
  assets: number;
  chains: number;
  yieldNow: ReturnType<typeof recommend>[number] | null;
  unread: boolean;
}) {
  const reach = held > 0n ? Number(deployable) / Number(held) : 0;
  return (
    <div className="grid g3 book">
      <div className="stat">
        <div className="k">Held across chains</div>
        <div className="v">{unread ? "could not read" : num(Number(held) / 1e6, 4)}</div>
        <p className="n">The client&rsquo;s own balance, summed over every approved chain.</p>
      </div>
      <div className="stat">
        <div className="k">Deployable now</div>
        <div className="v">{unread ? "could not read" : num(Number(deployable) / 1e6, 4)}</div>
        <p className="n">Dry powder: what the desk&rsquo;s counterparties may draw today.</p>
      </div>
      <div className={`stat${!unread && held > 0n && reach < 0.2 ? " stat-warn" : ""}`}>
        <div className="k">Reach of the holding</div>
        <div className="v">{unread || held === 0n ? "—" : pct(reach)}</div>
        <p className="n">Share of the balance that standing authority actually covers.</p>
      </div>
      <div className="stat">
        <div className="k">Book width</div>
        <div className="v">
          {positions || "—"} · {assets}
        </div>
        <p className="n">
          Positions and assets, over {chains || 0} chain{chains === 1 ? "" : "s"}.
        </p>
      </div>
      <div className="stat">
        <div className="k">Best measured rate</div>
        <div className="v">{yieldNow?.strategy.apy ? pct(yieldNow.strategy.apy) : "none quotable"}</div>
        <p className="n">
          {yieldNow?.projectedUnits ? `+${formatUnits(yieldNow.projectedUnits, 6)} over the mandate` : "Nothing on these terms carries a measured rate."}
          {yieldNow && !yieldNow.routable ? " — and it is not reachable from here." : ""}
        </p>
      </div>
      <div className="stat">
        <div className="k">Venue</div>
        <div className="v">Uniswap v4</div>
        <p className="n">The one thing this mandate can be put to work in is in the panel to the right.</p>
      </div>
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
  // Keyed by pool id, not by chain: Base Sepolia and Ethereum Sepolia each carry two pools, and
  // keying by chain had them overwrite each other on every lift — a state change every render.
  const [tab, setTab] = useState<TabKey>("overview");
  const [poolRows, setPoolRows] = useState<Record<string, PoolRow>>({});
  const onPoolRows = useCallback((rows: PoolRow[]) => {
    setPoolRows((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const r of rows) {
        const old = prev[r.id];
        if (!old || old.liquidity !== r.liquidity || old.tick !== r.tick) {
          next[r.id] = r;
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
  // chains this client signed for, applied to what is actually deployable. Every strategy that
  // carries a measured rate is `liveOn: []` today, so the pick is routinely one this desk cannot
  // reach — which the line says, in the same words the strategy rows use.
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
        {/* The dashboard proper: the figures, the charts, who can spend this, and what happened. */}
        <main className="body">
          <Tabs tab={tab} onTab={setTab} counts={{ positions: rows.length, history: acts.length }} />

          {tab === "overview" && (
            <>
              <Book
                held={totalHeld}
                deployable={totalDeployable}
                positions={rows.length}
                assets={assets.length}
                chains={new Set(rows.map((r) => r.chainId)).size}
                yieldNow={yieldNow}
                unread={ledger === false}
              />
              <Charts acts={acts} rows={rows} poolRows={poolRows} />
              <Access rows={rows} platform={platform} covered={ledger ? ledger.covered : []} uncovered={uncovered} />
            </>
          )}

          {tab === "positions" && (
            <>
              {ledger && approved.length === 0 && (
                <div className="panel">
                  <h2>No grants indexed</h2>
                  <p className="note">Nothing for this account yet — indexing may be behind.</p>
                </div>
              )}
              <Positions assets={assets} />
            </>
          )}

          {tab === "history" && <Activity activity={activity} uncovered={uncovered} />}
        </main>

        {/* The narrow side: the mandate itself, and the venues it can be put to work in. */}
        <aside className="side">
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
              {/* A ledger that refused is not a ledger of zero. Both figures are folded from its
                  rows, so when it did not answer they are unknown, and they say so. */}
              <div className="kv">
                <dt className="micro">Held across chains</dt>
                <dd>{ledger === false ? "could not read" : num(Number(totalHeld) / 1e6, 4)}</dd>
              </div>
              <div className="kv">
                <dt className="micro">Deployable now</dt>
                <dd>{ledger === false ? "could not read" : num(Number(totalDeployable) / 1e6, 4)}</dd>
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
                  {yieldNow && !yieldNow.routable ? " (if it were reachable)" : ""}
                </dd>
              </div>
            </dl>

            {anyUnreadable && <p className="note">Some reads failed — floor, not total.</p>}
            {uncovered.length > 0 && (
              <p className="note">
                Not indexed: {uncovered.map((id) => chainById(id)?.short ?? id).join(", ")} — grants there are invisible here.
              </p>
            )}
            {ledger === false && <p className="note">Control plane silent — unknown, not zero.</p>}
          </div>

          <PoolsPanel owner={owner} onRows={onPoolRows} />
        </aside>
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

function Charts({ acts, rows, poolRows }: { acts: ActivityRow[]; rows: Row[]; poolRows: Record<string, PoolRow> }) {
  const chainIds = CHAINS.map((c) => c.id);
  const series = useMemo(() => resample(authorityOverTime(acts), 72), [acts]);
  const byChain = useMemo(() => perChain(acts, chainIds), [acts]);
  const pools = Object.values(poolRows);
  const depth = chainIds.map(
    (id) => pools.filter((p) => p.chainId === id).reduce((sum, p) => sum + Number(p.liquidity), 0) / 1e6,
  );
  // What share of what the client holds on a chain the desk may actually draw. A balance with no
  // allowance behind it is not capital this desk can work with, and that gap is the whole question.
  const used = chainIds.map((id) => {
    const on = rows.filter((r) => r.chainId === id);
    const held = on.reduce((sum, r) => sum + Number(r.balance ?? 0n), 0);
    const live = on.reduce((sum, r) => sum + Number(r.remaining ?? 0n), 0);
    return held > 0 ? Math.min(100, (live / held) * 100) : 0;
  });
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

      <Chart
        title="Authority outstanding, over time"
        note={series.length ? `${acts.length} events · ${span}m span` : "no events indexed"}
      >
        {series.length > 1 ? <DitherArea values={series} variant="gradient" bloom="low" baseline={0.08} /> : null}
      </Chart>

      <Chart
        title="Authority standing, per chain"
        note={CHAINS.map((c, i) => `${c.short} ${num(byChain[i] ?? 0)}`).join(" · ")}
      >
        {byChain.some((v) => v > 0) ? <DitherBars values={byChain} hotIndex={byChain.indexOf(Math.max(...byChain))} /> : null}
      </Chart>

      <Chart
        title="v4 pool depth, per chain"
        note={`L/1e6 · ${CHAINS.map((c, i) => `${c.short} ${num(depth[i] ?? 0)}`).join(" · ")}`}
      >
        {depth.some((v) => v > 0) ? <DitherBars values={depth} color={SIGNAL} /> : null}
      </Chart>

      <Chart
        title="Mandated share of the holding, %"
        note={CHAINS.map((c, i) => `${c.short} ${num(used[i] ?? 0, 1)}%`).join(" · ")}
      >
        {used.some((v) => v > 0) ? <DitherBars values={used} variant="dotted" /> : null}
      </Chart>

      <Chart
        title="Consumed per approved grant"
        note={consumed.some((v) => v > 0) ? "granted − standing, per grant" : "nothing drawn yet"}
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
        <h2>Who can spend this</h2>
        <span className="label">03 / Access</span>
      </div>

      <div className="grant-list">
        {rows.map((r) => {
          const name = label(r.chainId, r.spender);
          const chain = chainById(r.chainId);
          const standing = r.remaining ?? 0n;
          const odd = name === "unrecognised spender";
          return (
            <article className={`grant${odd ? " odd" : ""}`} key={`${r.chainId}:${r.token}:${r.spender}`}>
              <header>
                <strong>{name}</strong>
                <ChainTag chainId={r.chainId} />
                <span className="tag">{r.symbol}</span>
                <a className="micro" href={`${chain?.explorer ?? ""}/address/${r.spender}`} target="_blank" rel="noreferrer">
                  {short(r.spender)}
                </a>
                <span className={`tag ${standing > 0n ? "ok" : "warn"}`}>
                  {r.remaining === undefined ? "unknown" : standing > 0n ? when(r.expiration ?? 0) : "spent or expired"}
                </span>
              </header>
              <Meter
                value={Number(standing)}
                of={Number(r.granted)}
                tone={odd ? "bad" : standing > 0n ? "ok" : "warn"}
              />
              <span className="micro">
                {formatUnits(standing, r.decimals)} standing of {formatUnits(r.granted, r.decimals)} granted
              </span>
            </article>
          );
        })}
        {rows.length === 0 && <p className="note">No standing authority indexed.</p>}
      </div>
      <h3 className="grp">Platform</h3>
      <div className="chain-grid">
        {CHAINS.map((c) => {
          const p = platform ? platform.chains.find((x) => x.chainId === c.id) : undefined;
          const pool = POOLS.find((x) => x.chainId === c.id);
          const indexed = covered.includes(c.id);
          return (
            <article className="chain-tile" key={c.id}>
              <header>
                <ChainTag chainId={c.id} />
                <span className={`tag ${indexed ? "ok" : "warn"}`}>{indexed ? "indexed" : "blind"}</span>
              </header>
              <dl className="kv-list">
                <div className="kv">
                  <dt className="micro">Signer</dt>
                  <dd className="mono">{p ? short(p.signer) : "—"}</dd>
                </div>
                <div className="kv">
                  <dt className="micro">Custody</dt>
                  <dd>{p?.custody ?? "—"}</dd>
                </div>
                <div className="kv">
                  <dt className="micro">Venue</dt>
                  <dd>
                    {pool ? (
                      <a href={`${c.explorer}/address/${pool.poolManager}`} target="_blank" rel="noreferrer">
                        {short(pool.poolManager, 5)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
                <div className="kv">
                  <dt className="micro">Desk</dt>
                  <dd>
                    {pool ? (
                      <a href={`${c.explorer}/address/${pool.liquidityDesk}`} target="_blank" rel="noreferrer">
                        {short(pool.liquidityDesk, 5)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
      <p className="note">
        {platform === false
          ? "Relayer silent — signer and custody unknown."
          : `Indexed on ${covered.length}/${CHAINS.length} chains${
              uncovered.length ? ` · blind: ${uncovered.map((id) => chainById(id)?.short ?? id).join(", ")}` : ""
            }`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- positions

/**
 * The blotter. One row per (asset, chain, counterparty) the client actually approved, which is the
 * shape a portfolio manager reads a book in: what is held, what of it is reachable, how much of the
 * grant has been drawn, and how long the position has left to live. Grouped by asset, because an
 * asset approved on three chains is one exposure with three settlement venues, not three exposures.
 *
 * No strategy rows here. What the desk *could* do is a different question from what it holds, and
 * mixing the two put speculative lines in the same list as measured ones.
 */
function Positions({ assets }: { assets: [string, Row[]][] }) {
  return (
    <div className="panel">
      <div className="sec-head">
        <h2>Positions</h2>
        <span className="label">05 / Book</span>
      </div>

      {assets.length === 0 ? (
        <p className="note">No approved positions indexed.</p>
      ) : (
        <div className="table-wrap blotter">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Chain</th>
                <th>Counterparty</th>
                <th className="num">Held</th>
                <th className="num">Deployable</th>
                <th>Reach</th>
                <th className="num">Drawn</th>
                <th>Expires</th>
              </tr>
            </thead>
            {assets.map(([symbol, group]) => {
              const decimals = group[0]?.decimals ?? 6;
              // A strategy has to fit the weakest chain it runs on, so the asset line carries the
              // smallest live allowance, not the sum.
              const floor = group.reduce(
                (m, r) => (r.remaining !== undefined && r.remaining < m ? r.remaining : m),
                2n ** 255n,
              );
              const cap = floor === 2n ** 255n ? 0n : floor;
              return (
                <tbody key={symbol}>
                  <tr className="grp-row">
                    <th colSpan={3} scope="colgroup">
                      {symbol}
                    </th>
                    <td colSpan={5} className="num">
                      <span className={`tag ${cap > 0n ? "active" : "awaiting"}`}>
                        {cap > 0n ? `${formatUnits(cap, decimals)} deployable on every chain` : "nothing deployable"}
                      </span>
                    </td>
                  </tr>
                  {group.map((r) => {
                    const chain = chainById(r.chainId);
                    const held = Number(r.balance ?? 0n);
                    const live = Number(r.remaining ?? 0n);
                    const over = r.balance !== undefined && r.remaining !== undefined && r.remaining > r.balance;
                    const drawn = r.remaining === undefined || r.granted === 0n ? undefined : r.granted - r.remaining;
                    return (
                      <tr key={`${r.chainId}:${r.token}:${r.spender}`}>
                        <td className="mono">{r.symbol}</td>
                        <td>
                          <ChainTag chainId={r.chainId} />
                        </td>
                        <td>
                          <a
                            className="mono"
                            href={`${chain?.explorer ?? ""}/address/${r.spender}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {short(r.spender, 5)}
                          </a>
                        </td>
                        <td className="num mono">{r.balance === undefined ? "—" : formatUnits(r.balance, r.decimals)}</td>
                        <td className="num mono">
                          {r.remaining === undefined ? "unknown" : formatUnits(r.remaining, r.decimals)}
                        </td>
                        <td>
                          <Meter
                            value={live}
                            of={Math.max(held, live)}
                            tone={over ? "bad" : live > 0 ? "ok" : "warn"}
                          />
                        </td>
                        <td className="num mono">{drawn === undefined ? "—" : formatUnits(drawn, r.decimals)}</td>
                        <td>
                          <span className={`tag ${over ? "bad" : live > 0 ? "ok" : "warn"}`}>
                            {over ? "over the holding" : r.expiration === undefined ? "—" : when(r.expiration)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
      <p className="note">
        Held is the client&rsquo;s own balance; deployable is what the counterparty may draw today. A balance with no
        allowance behind it is not capital this desk can work with.
      </p>
    </div>
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
        <h2>History</h2>
        <span className="label">06 / MultiBaas event ledger</span>
      </div>

      {activity === null && <p className="note">Reading…</p>}
      {activity === false && <p className="note">Control plane silent — unknown, not empty.</p>}
      {activity && activity.rows.length === 0 && (
        <p className="note">Nothing indexed yet.</p>
      )}
      {activity && activity.rows.length > 0 && (
        <ol className="timeline">
          {activity.rows.map((r, i) => (
            <li key={`${r.txHash}:${i}`} className={`ev ${r.kind}`}>
              <span className="when micro">
                {r.timestamp ? new Date(r.timestamp * 1000).toISOString().replace("T", " ").slice(5, 16) : "—"}
              </span>
              <span className={`tag ${r.kind === "granted" ? "active" : r.kind === "locked" ? "bad" : "warn"}`}>
                {KIND[r.kind]}
              </span>
              <ChainTag chainId={r.chainId} />
              <span className="amt mono">{r.amount ? formatUnits(BigInt(r.amount), 6) : "—"}</span>
              <span className="micro who">
                {r.spender ? short(r.spender, 4) : "—"} ← {r.token ? short(r.token, 4) : "—"}
              </span>
              {r.explorer ? (
                <a className="micro" href={r.explorer} target="_blank" rel="noreferrer">
                  {short(r.txHash ?? "", 5)}
                </a>
              ) : (
                <span className="micro">—</span>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="note">
        {activity ? activity.covered.length : 0}/{CHAINS.length} chains indexed · expired grants live only here.
      </p>
    </div>
  );
}
