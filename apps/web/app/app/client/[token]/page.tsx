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
import { type ClientMandate, useDeskHealth, useMandate } from "../../../../src/clients";
import { CHAINS, CROSS_PERMIT, chainById } from "../../../../src/config";
import { DitherArea, HorseMatrix } from "../../../../src/dithergraph";
import { Rail } from "../../../rail";
import { DeskFault } from "../../desk-fault";
import { POOLS } from "../../../../src/pools";
import { type ActivityRow, useActivity, useRelayerChains, useTreasury } from "../../../../src/relayer";
import { recommend } from "../../../../src/strategies";
import { authorityOverTime, resample } from "../../../../src/series";
import { type PoolRow, PoolsPanel } from "./pools";
import "../../desk.css";
import "./client.css";

const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

/**
 * A token amount, written to a length a person can actually read.
 *
 * `formatUnits` is exact, which is right for a blotter cell and wrong for a glanceable list: it
 * printed a drawn figure as 0.000000426578643079 next to one printed as 2. Big figures lose their
 * cents, small ones keep three significant digits — because below one, fixed decimals would round
 * the whole number away. The Positions table still carries the exact value.
 */
const amount = (v: bigint, dp: number) => {
  const n = Number(formatUnits(v, dp));
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
};

/**
 * A label per token, disambiguated by address where a symbol is not unique.
 *
 * Ethereum Sepolia carries three contracts that all answer `symbol()` with "USDC": Circle's own,
 * and the two the lifecycle script deployed. A list that printed the symbol alone showed the same
 * three words against three different assets, and no row could be told from another. Where a
 * symbol covers one contract it is left alone; where it covers several, the address is appended,
 * because the address is the only thing that actually distinguishes them.
 */
function tokenLabels(rows: Row[]): (token: Address) => string {
  const addresses = new Map<string, Set<string>>();
  for (const r of rows) {
    const seen = addresses.get(r.symbol) ?? new Set<string>();
    seen.add(r.token.toLowerCase());
    addresses.set(r.symbol, seen);
  }
  const out = new Map<string, string>();
  for (const r of rows) {
    const ambiguous = (addresses.get(r.symbol)?.size ?? 0) > 1;
    out.set(r.token.toLowerCase(), ambiguous ? `${r.symbol} ${short(r.token, 4)}` : r.symbol);
  }
  return (token: Address) => out.get(token.toLowerCase()) ?? short(token, 4);
}

/**
 * Which counterparty a spender is, in both lengths.
 *
 * Module scope because two panels name the same thing: the access list groups by the long name,
 * the drawn-per-grant rows disambiguate by the short one. An allowance to something this dashboard
 * cannot identify is the single most important row on the page, so it is named, never hidden.
 */
function counterparty(chainId: number, spender: Address): { long: string; brief: string; known: boolean } {
  const chain = chainById(chainId);
  if (chain && spender.toLowerCase() === chain.router.toLowerCase())
    return { long: "execution desk · Universal Router", brief: "router", known: true };
  const pool = POOLS.find((p) => p.chainId === chainId);
  if (pool && spender.toLowerCase() === pool.liquidityDesk.toLowerCase())
    return { long: "liquidity desk · v4 LP adapter", brief: "LP desk", known: true };
  return { long: "unrecognised spender", brief: "unknown", known: false };
}
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
  // The views are keys on the rail, not a second row of keys under it. One key bank per screen:
  // a page with its own tab strip below the rail was two navigations for one decision.
  const [tab, setTab] = useState<TabKey>("overview");
  const health = useDeskHealth();

  return (
    <div className="wrap">
      {/* One key, because there is one way out of a client record: back to the book it came from. */}
      <Rail
        variant="inline"
        go={null}
        items={[
          { key: "desk", label: "← The desk", href: "/app" },
          ...TABS.map((t) => ({ key: t.key, label: t.label, current: tab === t.key, onClick: () => setTab(t.key) })),
        ]}
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

      {/* Said before anything else, and instead of the panels below blaming the relayer: if the
          desk layer refused to start, nothing downstream of it was ever asked. */}
      {health.kind === "misconfigured" && <DeskFault message={health.message} />}

      {state.kind === "loading" && <p className="note">Reading the mandate…</p>}
      {state.kind === "missing" && (
        <div className="panel">
          <h2>No such client</h2>
          <p className="note">That link was withdrawn or never existed. Nothing was granted under it.</p>
        </div>
      )}
      {state.kind === "offline" && health.kind !== "misconfigured" && (
        <div className="panel">
          <h2>The desk is unreachable</h2>
          <p className="note">
            The relayer did not answer, so this page cannot tell you what this client&rsquo;s authority is. It is not
            telling you there is none.
          </p>
        </div>
      )}
      {state.kind === "ok" && <Dashboard client={state.client} refreshKey={refreshKey} tab={tab} />}
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

/**
 * A share, written honestly.
 *
 * Three cases a bare `Math.round(share * 100)%` gets wrong, all of them live on this screen:
 * an allowance larger than the balance is over 100% and must say so rather than print 1,666,673%;
 * a draw of 0.000001 of a grant is not 0%, it is under 1% and the distinction is the whole point
 * of showing it; and a share is never negative.
 */
const share = (v: number) =>
  v > 1 ? ">100%" : v <= 0 ? "0%" : v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`;

/** A segmented readout. Twelve cells, because a share is read by counting lit cells, not measured. */
function Seg({ share: v, tone }: { share: number; tone?: "ok" | "warn" | "bad" }) {
  const lit = Math.max(0, Math.min(12, Math.round(v * 12)));
  return (
    <span className={`seg${tone ? ` s-${tone}` : ""}`} role="img" aria-label={share(v)}>
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} className={i < lit ? "on" : undefined} />
      ))}
    </span>
  );
}

/** One ranked row: what it is, how much, and its share of the whole — a bar chart that can be read. */
function Rank({
  label,
  figure,
  value,
  tone,
}: {
  label: React.ReactNode;
  figure: string;
  value: number;
  tone?: "ok" | "warn" | "bad";
}) {
  return (
    <div className="rank">
      <span className="rk-label">{label}</span>
      <Seg share={value} tone={tone} />
      <span className="rk-fig mono">{figure}</span>
      <span className="rk-pct micro">{share(value)}</span>
    </div>
  );
}

export type AssetTotal = {
  symbol: string;
  decimals: number;
  rows: Row[];
  held: number;
  deployable: number;
  reach: number;
};

/**
 * The overview, as a bento of console parts.
 *
 * Two rules decide every tile here. The first is that no figure crosses an asset: there is no
 * price on this screen, so USDC and WETH are never summed, only listed. The second is that tiles
 * in the same row carry comparable amounts of content — the previous arrangement put a two-row
 * bay beside a seventeen-row one and left half the grid empty, which is what made it read as
 * badly arranged rather than merely plain.
 *
 * Shape: what there is, how long it lasts, how big the book is; then the one time series, beside
 * the one rate; then the two distributions that answer "where is it" and "what has been used".
 */
function Bento({
  acts,
  rows,
  byAsset,
  decimalsOf,
  unread,
  yieldNow,
  events,
}: {
  acts: ActivityRow[];
  rows: Row[];
  byAsset: AssetTotal[];
  decimalsOf: (t?: string) => number;
  unread: boolean;
  yieldNow: ReturnType<typeof recommend>[number] | null;
  events: number;
}) {
  const lead = byAsset[0] ?? null;
  const [shown, setShown] = useState<string | null>(null);
  const asset = byAsset.find((a) => a.symbol === shown) ?? lead;

  /** The series for ONE asset. Summing a step function across decimals is what broke the old one. */
  const series = useMemo(() => {
    if (!asset) return [];
    const mine = new Set(asset.rows.map((r) => r.token.toLowerCase()));
    return resample(
      authorityOverTime(
        acts.filter((a) => a.token && mine.has(a.token.toLowerCase())),
        undefined,
        decimalsOf,
      ),
      72,
    );
  }, [acts, asset?.symbol, decimalsOf]);

  /**
   * Hours on the shortest-lived grant that still has something standing.
   *
   * Only live grants count. Folding spent and lapsed ones in is what made this read "0h · expiring"
   * on a book whose every usable grant had 29 days left — the most alarming figure on the screen,
   * and wrong.
   */
  const runway = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const live = rows
      .filter((r) => (r.remaining ?? 0n) > 0n && r.expiration && r.expiration > Math.max(now, LOCKED))
      .map((r) => r.expiration!);
    if (!live.length) return null;
    return Math.max(0, Math.floor((Math.min(...live) * 1000 - Date.now()) / 3_600_000));
  }, [rows]);

  /** Per chain and per asset, ranked. Two assets over two chains is four rows, not a bar chart. */
  const spread = useMemo(() => {
    const out: { chainId: number; symbol: string; deployable: number; share: number }[] = [];
    for (const a of byAsset) {
      const per = new Map<number, number>();
      for (const r of a.rows) {
        const v = r.remaining === undefined ? 0 : Number(formatUnits(r.remaining, a.decimals));
        per.set(r.chainId, (per.get(r.chainId) ?? 0) + v);
      }
      for (const [chainId, deployable] of per) {
        out.push({ chainId, symbol: a.symbol, deployable, share: a.deployable > 0 ? deployable / a.deployable : 0 });
      }
    }
    return out.sort((x, y) => y.share - x.share || y.deployable - x.deployable);
  }, [byAsset]);

  /** Drawn per grant, but only the grants that have been drawn on. The rest are one line of prose. */
  const drawn = useMemo(() => {
    const all = rows
      .filter((r) => r.granted > 0n && r.remaining !== undefined)
      .map((r) => ({ r, share: Number(r.granted - r.remaining!) / Number(r.granted) }));
    return { used: all.filter((x) => x.share > 0).sort((a, b) => b.share - a.share), untouched: all.filter((x) => x.share === 0).length };
  }, [rows]);

  const name = useMemo(() => tokenLabels(rows), [rows]);
  const chains = new Set(rows.map((r) => r.chainId)).size;
  /** Contracts behind the lead asset's symbol. More than one means the headline sums them. */
  const leadContracts = lead ? new Set(lead.rows.map((r) => r.token.toLowerCase())).size : 0;
  const atCeiling = drawn.used.filter((x) => x.share >= 0.999).length;
  const top = spread[0];

  return (
    <div className="bento">
      {/* What there is. One asset on the readout, the rest listed under it — never added together. */}
      <section className="bay b-assets">
        <div className="sec-head">
          <span className="silk">Deployable now</span>
          <span className="micro">per asset · no price, no total</span>
        </div>
        {unread ? (
          <>
            <div className="lcd">
              <div className="lcd-row">
                <span className="big mono">— — —</span>
              </div>
            </div>
            <p className="note">The control plane did not answer. Unknown, not zero.</p>
          </>
        ) : !lead ? (
          <p className="note">No approved asset carries standing authority yet.</p>
        ) : (
          <>
            <div className="lcd">
              <div className="lcd-row">
                <span className="big mono">{num(lead.deployable, lead.decimals === 18 ? 6 : 2)}</span>
                <span className="tag mono">{lead.symbol}</span>
              </div>
              <div className="lcd-row">
                <span className="ghost mono">of {num(lead.held, lead.decimals === 18 ? 6 : 2)} held</span>
                <span className="ghost mono">{share(lead.reach)} of holding</span>
              </div>
            </div>
            <div className="ranks">
              {byAsset.slice(1).map((a) => (
                <Rank
                  key={a.symbol}
                  label={<span className="mono">{a.symbol}</span>}
                  figure={amount(a.rows.reduce((t, r) => t + (r.remaining ?? 0n), 0n), a.decimals)}
                  value={a.reach}
                  tone={a.reach > 0 ? "ok" : "warn"}
                />
              ))}
            </div>
            {leadContracts > 1 && (
              <p className="note">
                {leadContracts} different contracts answer to &ldquo;{lead.symbol}&rdquo; here, and this figure adds them
                up. Only some of them are the real asset.
              </p>
            )}
            <p className="note">
              {lead.held === 0
                ? `Nothing held in ${lead.symbol} on any approved chain — the mandate is permission over an empty wallet.`
                : lead.deployable > lead.held
                  ? `The mandate permits ${num(lead.deployable - lead.held, 2)} more ${lead.symbol} than the client holds. Permission over money that is not there: the desk can draw only what exists.`
                  : `${pct(1 - lead.reach)} of the ${lead.symbol} this client holds sits outside the mandate — capital the desk cannot work with.`}
            </p>
          </>
        )}
      </section>

      {/* How long it lasts. The one figure here that becomes urgent on its own. */}
      <section className="bay b-runway">
        <span className="silk">Runway</span>
        <div className="big mono">
          {runway === null ? "—" : runway >= 48 ? `${Math.floor(runway / 24)}d` : `${runway}h`}
        </div>
        <span className={`led ${runway === null ? "" : runway < 24 ? "fault" : runway < 168 ? "on" : "ok"}`}>
          <i />
          {runway === null ? "nothing standing" : runway < 24 ? "expiring" : runway < 168 ? "within a week" : "healthy"}
        </span>
        <p className="note">Until the shortest-lived grant that still has something standing lapses.</p>
      </section>

      {/* How big the book is. Counts are the one thing on this screen that need no unit. */}
      <section className="bay b-book">
        <span className="silk">The book</span>
        <div className="kv-list">
          <div className="kv">
            <dt className="micro">Grants</dt>
            <dd className="mono">{rows.length || "—"}</dd>
          </div>
          <div className="kv">
            <dt className="micro">Assets</dt>
            <dd className="mono">{byAsset.length || "—"}</dd>
          </div>
          <div className="kv">
            <dt className="micro">Chains</dt>
            <dd className="mono">{chains || "—"}</dd>
          </div>
          <div className="kv">
            <dt className="micro">Events</dt>
            <dd className="mono">{events || "—"}</dd>
          </div>
        </div>
        <p className="note">
          {atCeiling > 0 ? `${atCeiling} grant${atCeiling === 1 ? " is" : "s are"} at the ceiling.` : "No grant is at its ceiling."}
        </p>
      </section>

      {/* The one time series. One asset at a time, because a step function summed across decimals
          is the solid black band this used to draw. */}
      <section className="bay b-trend">
        <div className="sec-head">
          <span className="silk">Authority outstanding, over time</span>
          <div className="chips">
            {byAsset.map((a) => (
              <button
                key={a.symbol}
                type="button"
                className={`chip${asset?.symbol === a.symbol ? " on" : ""}`}
                onClick={() => setShown(a.symbol)}
              >
                {a.symbol}
              </button>
            ))}
          </div>
        </div>
        <div className="plot tall">
          {series.length > 1 ? <DitherArea values={series} variant="gradient" bloom="low" baseline={0.08} /> : null}
        </div>
        <p className="note">
          {series.length > 1
            ? `Every grant, lock and clearing on this client's ${asset?.symbol}, summed across chains. ${events} events indexed.`
            : "Nothing indexed for this asset — the control plane may be behind, or blind to these chains."}
        </p>
      </section>

      {/* The one measurable rate, beside the series: the same decision, over the same horizon. */}
      <section className="bay b-rate">
        <span className="silk">Best measured rate</span>
        <div className="big mono">{yieldNow?.strategy.apy ? pct(yieldNow.strategy.apy) : "—"}</div>
        <span className={`led ${yieldNow?.routable ? "ok" : ""}`}>
          <i />
          {!yieldNow ? "none quotable" : yieldNow.routable ? "routable" : "not reachable"}
        </span>
        <p className="note">
          {yieldNow?.projectedUnits
            ? `+${formatUnits(yieldNow.projectedUnits, 6)} over the mandate${yieldNow.routable ? "" : ", if it were reachable"}.`
            : "Nothing on these terms carries a measured rate."}
        </p>
      </section>

      {/* Where it is. Per chain AND per asset, because a share across assets has no meaning. */}
      <section className="bay b-chains">
        <div className="sec-head">
          <span className="silk">Where the authority sits</span>
          <span className="micro">share of its own asset</span>
        </div>
        <div className="ranks">
          {spread.length === 0 && <p className="note">No chain carries standing authority.</p>}
          {spread.map((x) => (
            <Rank
              key={`${x.chainId}:${x.symbol}`}
              label={
                <>
                  <span className="mono">{x.symbol}</span>
                  <ChainTag chainId={x.chainId} />
                </>
              }
              figure={num(x.deployable, 2)}
              value={x.share}
              tone={x.deployable > 0 ? "ok" : "warn"}
            />
          ))}
        </div>
        <p className="note">
          {top && top.share > 0
            ? `${pct(top.share)} of deployable ${top.symbol} sits on ${chainById(top.chainId)?.short ?? top.chainId}. A chain that stalls takes that much of it with it.`
            : "Nothing to concentrate yet."}
        </p>
      </section>

      {/* What has been used. Only the grants actually drawn on — the untouched ones are a count,
          not seventeen empty meters. */}
      <section className="bay b-util">
        <div className="sec-head">
          <span className="silk">Drawn per grant</span>
          <span className="micro">share of each grant used</span>
        </div>
        <div className="ranks">
          {drawn.used.length === 0 && <p className="note">No grant has been drawn on yet.</p>}
          {/* Asset, chain AND counterparty. Three rows reading "USDC · ETH" were the same grant as
              far as anyone could tell; the spender is what actually tells them apart. */}
          {drawn.used.slice(0, 6).map(({ r, share: d }) => (
            <Rank
              key={`${r.chainId}:${r.token}:${r.spender}`}
              label={
                /* Two lines on purpose: a disambiguated token label plus a chain plus a
                   counterparty does not fit one, and letting it wrap on its own put three ragged
                   lines where the column should be. Asset leads; where and who sit under it. */
                <span className="rk-stack">
                  <span className="mono">{name(r.token)}</span>
                  <span className="rk-sub">
                    <ChainTag chainId={r.chainId} />
                    <span className="micro rk-who">{counterparty(r.chainId, r.spender).brief}</span>
                  </span>
                </span>
              }
              figure={amount(r.granted - r.remaining!, r.decimals)}
              value={d}
              tone={d >= 0.999 ? "bad" : "ok"}
            />
          ))}
        </div>
        <p className="note">
          {drawn.used.length > 6 ? `${drawn.used.length - 6} more drawn on. ` : ""}
          {drawn.untouched > 0
            ? `${drawn.untouched} grant${drawn.untouched === 1 ? "" : "s"} untouched.`
            : "Every grant has been drawn on."}
          {atCeiling > 0 ? " A grant at its ceiling cannot be drawn on again until the client raises it." : ""}
        </p>
      </section>
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

function Dashboard({ client, refreshKey, tab }: { client: ClientMandate; refreshKey: number; tab: TabKey }) {
  const owner = (client.owner ?? undefined) as Address | undefined;
  const ledger = useTreasury(owner, refreshKey);
  const activity = useActivity(owner, refreshKey);
  const platform = useRelayerChains();

  // Live v4 figures, lifted out of the pools panel so the depth chart and the panel cannot
  // disagree about what the pool holds.
  // Keyed by pool id, not by chain: Base Sepolia and Ethereum Sepolia each carry two pools, and
  // keying by chain had them overwrite each other on every lift — a state change every render.
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
  const anyUnreadable = rows.some((r) => !r.readable);
  const acts = activity ? activity.rows : [];

  /**
   * Totals per asset — and deliberately not one total across them.
   *
   * There is no price on this screen, so USDC + WETH has no meaning as a single figure, and the
   * base units make it worse: adding a 6-decimal bigint to an 18-decimal one and dividing the
   * result by 1e6 is how "deployable now" came to read 3,999,999,999,581,566. An asset is the
   * smallest unit a figure here can honestly be stated in, so every figure is stated in one.
   */
  const byAsset = useMemo(() => {
    const out = assets.map(([symbol, group]) => {
      const dp = group[0]?.decimals ?? 6;
      const u = (v: bigint | undefined) => (v === undefined ? 0 : Number(formatUnits(v, dp)));
      const held = group.reduce((t, r) => t + u(r.balance), 0);
      const deployable = group.reduce((t, r) => t + u(r.remaining), 0);
      return { symbol, decimals: dp, rows: group, held, deployable, reach: held > 0 ? deployable / held : 0 };
    });
    return out.sort((a, b) => b.deployable - a.deployable);
  }, [assets]);

  /** Token address → decimals, so the event ledger can be scaled per token rather than per guess. */
  const decimalsOf = useMemo(() => {
    const m = new Map(rows.map((r) => [r.token.toLowerCase(), r.decimals]));
    return (t?: string) => (t ? (m.get(t.toLowerCase()) ?? 6) : 6);
  }, [rows]);

  // The yield line: the best measured rate among strategies that could run on the chains this
  // client signed for, sized against ONE asset's deployable — the largest 6-decimal one, because
  // `recommend` quotes in 6dp units and handing it a WETH figure would size a position a trillion
  // times over. Every strategy carrying a measured rate is `liveOn: []` today, so the pick is
  // routinely one this desk cannot reach — which the line says.
  const sizing = byAsset.find((a) => a.decimals === 6) ?? null;
  const yieldNow = useMemo(() => {
    if (!sizing) return null;
    const chainIds = [...new Set(rows.map((r) => r.chainId))];
    const capUnits = sizing.rows.reduce((t, r) => t + (r.remaining ?? 0n), 0n);
    const best = recommend({ capUnits, ttlHours: client.ttlHours || 720, chainIds })
      .filter((r) => r.projectedUnits !== null)
      .sort((a, b) => Number((b.projectedUnits ?? 0n) - (a.projectedUnits ?? 0n)))[0];
    return best ?? null;
  }, [sizing?.deployable, sizing?.symbol, client.ttlHours, rows.length]);

  return (
    <div className="desk client-page">
      <div className="client-grid">
        {/* The dashboard proper: the figures, the charts, who can spend this, and what happened. */}
        <main className="body">
          {tab === "overview" && (
            <>
              <Bento
                acts={acts}
                rows={rows}
                byAsset={byAsset}
                decimalsOf={decimalsOf}
                unread={ledger === false}
                yieldNow={yieldNow}
                events={activity ? activity.rows.length : 0}
              />
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
              {/* One line per asset. There is no price here, so there is no total. */}
              {ledger === false ? (
                <div className="kv">
                  <dt className="micro">Deployable</dt>
                  <dd>could not read</dd>
                </div>
              ) : byAsset.length === 0 ? (
                <div className="kv">
                  <dt className="micro">Deployable</dt>
                  <dd>—</dd>
                </div>
              ) : (
                byAsset.map((a) => (
                  <div className="kv" key={a.symbol}>
                    <dt className="micro">{a.symbol} deployable</dt>
                    <dd>
                      {num(a.deployable, 4)} <span className="micro">of {num(a.held, 4)} held</span>
                    </dd>
                  </div>
                ))
              )}
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
  /**
   * Grouped by who, not by grant.
   *
   * Seventeen cards that each repeated "liquidity desk · v4 LP adapter" answered the question
   * seventeen times. The question is "who can spend this", and the answer is two counterparties —
   * so the name is said once and the grants sit under it as rows.
   */
  const groups = useMemo(() => {
    const by = new Map<string, { name: ReturnType<typeof counterparty>; rows: Row[] }>();
    for (const r of rows) {
      const name = counterparty(r.chainId, r.spender);
      const g = by.get(name.long) ?? { name, rows: [] };
      g.rows.push(r);
      by.set(name.long, g);
    }
    // Anything unrecognised first: it is the row that matters most and the one most easily missed.
    return [...by.values()].sort((a, b) => Number(a.name.known) - Number(b.name.known));
  }, [rows]);

  const name = useMemo(() => tokenLabels(rows), [rows]);

  return (
    <div className="panel">
      <div className="sec-head">
        <h2>Who can spend this</h2>
        <span className="label">03 / Access</span>
      </div>

      {rows.length === 0 && <p className="note">No standing authority indexed.</p>}

      <div className="counterparties">
        {groups.map((g) => {
          const standing = g.rows.filter((r) => (r.remaining ?? 0n) > 0n).length;
          return (
            <section className={`cp${g.name.known ? "" : " odd"}`} key={g.name.long}>
              <header className="cp-head">
                <strong>{g.name.long}</strong>
                <span className="micro">
                  {standing} of {g.rows.length} standing
                </span>
              </header>
              <div className="cp-rows">
                {g.rows.map((r) => {
                  const chain = chainById(r.chainId);
                  const live = r.remaining ?? 0n;
                  return (
                    <div className="cp-row" key={`${r.chainId}:${r.token}:${r.spender}`}>
                      {/* The chain badge is the link to this counterparty's address on that chain,
                          so the row carries the address without spending a column on it. */}
                      <a
                        className="cp-where"
                        href={`${chain?.explorer ?? ""}/address/${r.spender}`}
                        target="_blank"
                        rel="noreferrer"
                        title={r.spender}
                      >
                        <ChainTag chainId={r.chainId} />
                      </a>
                      <span className="cp-sym mono">{name(r.token)}</span>
                      <Meter
                        value={Number(live)}
                        of={Number(r.granted)}
                        tone={!g.name.known ? "bad" : live > 0n ? "ok" : "warn"}
                      />
                      <span className="cp-fig mono">
                        {amount(live, r.decimals)}
                        <span className="micro"> / {amount(r.granted, r.decimals)}</span>
                      </span>
                      <span className={`tag ${live > 0n ? "ok" : "warn"}`}>
                        {r.remaining === undefined ? "unknown" : live > 0n ? when(r.expiration ?? 0) : "spent or expired"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
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
