"use client";

/**
 * The Uniswap v4 pools this client's approved assets trade in, and the one action a mandate can
 * take in them: provide liquidity, paid for by the writ.
 *
 * There is one step here, and it belongs to the DESK. The client's mandate — the single signature
 * they gave on `/c/<token>` — already names `LiquidityDesk` as a spender on every chain and token
 * it covers, so allocating is `add`, a transaction anyone may send: it can only move tokens from an
 * account that signed such a mandate, it can only move them into the PoolManager, and the position
 * it creates belongs to the client.
 *
 * Which is the product claim, expressed as a screen: the desk can put the client's capital to work
 * without ever being able to take it.
 */

import { useEffect, useMemo, useState } from "react";
import { type Address, formatUnits, parseUnits } from "viem";
import { useAccount, useReadContracts, useSwitchChain, useWriteContract } from "wagmi";

import { crossPermitAbi } from "@crosspermit/sdk";
import { CROSS_PERMIT, chainById } from "../../../../src/config";
import {
  POOL_CHAINS,
  amountsForLiquidity,
  poolId,
  priceOf,
  rangeAt,
  decodeSlot0,
  liquidityDeskAbi,
  liquidityForAmounts,
  liquiditySlot,
  poolManagerAbi,
  poolStateSlot,
  positionSlot,
} from "../../../../src/pools";
import { openAppKit } from "../../../../src/wagmi";

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);
const fmt = (n: number, dp = 4) => n.toLocaleString("en-US", { maximumFractionDigits: dp });

/** Headroom on the two caps passed to `add`. The price moves between this preview and the block. */
const SLIPPAGE = 1.02;

/** v4's "no hook" address, so the card can say so rather than printing twenty zeroes. */
const ZERO_HOOK = "0x0000000000000000000000000000000000000000";

export type PoolRow = {
  /** The v4 pool id. Two pools can share a chain, so the chain is not an identity. */
  id: `0x${string}`;
  chainId: number;
  source: (typeof POOL_CHAINS)[number]["source"];
  /** Live depth, for the chart on the left. */
  liquidity: bigint;
  /** Decimal-corrected: currency1 per whole currency0, not per smallest unit. */
  price: number;
  tick: number;
};

/** A token's mark. Only two are real here, and a symbol is a better label than a wrong logo. */
const TOKEN_LOGO: Record<string, string> = {
  USDC: "/logos/usdc.png",
  WETH: "/logos/ethereum.png",
};

/** The chain's own mark, for the badge that sits on the pair. */
const CHAIN_LOGO: Record<number, string> = {
  84532: "/logos/base.png",
  11155111: "/logos/ethereum.png",
  11155420: "/logos/optimism.png",
};

const compact = (n: number) =>
  n >= 1e12 ? `${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(2);

/** The pair, as Uniswap draws it: two overlapping marks with the chain badged on the corner. */
function PairMark({ pool }: { pool: (typeof POOL_CHAINS)[number] }) {
  const mark = (sym: string, src?: string) =>
    src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" width={26} height={26} />
    ) : (
      <span className="mono">{sym.replace(/^m/, "").slice(0, 1)}</span>
    );

  return (
    <span className="pair-mark" aria-hidden="true">
      <i className="m0">{mark(pool.sym0, TOKEN_LOGO[pool.sym0])}</i>
      <i className="m1">{mark(pool.sym1, TOKEN_LOGO[pool.sym1])}</i>
      {CHAIN_LOGO[pool.chainId] && (
        // eslint-disable-next-line @next/next/no-img-element
        <i className="chain">
          <img src={CHAIN_LOGO[pool.chainId]!} alt="" width={14} height={14} />
        </i>
      )}
    </span>
  );
}

export function PoolsPanel({
  owner,
  onRows,
}: {
  owner?: Address;
  /** Live pool figures lifted to the page, so the charts and the panel read the same numbers. */
  onRows?: (rows: PoolRow[]) => void;
}) {
  // Uniswap's own pools lead, because they are the ones that prove anything: real PoolManagers,
  // real depth, two chains. The repo's seeded pairs stay reachable — a demo client holds those
  // mock tokens — but folded away, so the screen is not half test fixtures.
  const live = POOL_CHAINS.filter((p) => p.source === "uniswap");
  const seeded = POOL_CHAINS.filter((p) => p.source !== "uniswap");

  return (
    <div className="panel">
      <div className="sec-head">
        <h2>Uniswap v4 pools</h2>
        <span className="label">04 / Venue</span>
      </div>
      <p className="sub">
        Uniswap&rsquo;s own v4 pools, read live from each PoolManager with <span className="mono">extsload</span>.
      </p>

      <div className="pool-list">
        {live.map((p) => (
          // Keyed by the pool, not the chain: one chain can carry two venues.
          <Pool key={poolId(p.key)} pool={p} owner={owner} onRow={(row) => onRows?.([row])} />
        ))}
      </div>

      <details className="pool-seeded">
        <summary>
          <span className="cap">This repository&rsquo;s own pools</span>
          <span className="micro">{seeded.length} seeded pairs over mock tokens · Optimism Sepolia has no v4 pool</span>
        </summary>
        <div className="pool-list">
          {seeded.map((p) => (
            <Pool key={poolId(p.key)} pool={p} owner={owner} onRow={(row) => onRows?.([row])} />
          ))}
        </div>
        <p className="note">Mock tokens the demo client holds — adapter evidence, not market evidence.</p>
      </details>

      <p className="note">ERC20/ERC20 only — the desk settles by transferFrom and cannot pay a native-ETH side.</p>
    </div>
  );
}

function Pool({
  pool,
  owner,
  onRow,
}: {
  pool: (typeof POOL_CHAINS)[number];
  owner?: Address;
  onRow?: (row: PoolRow) => void;
}) {
  const { address, chainId: walletChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [size, setSize] = useState("1");
  const [busy, setBusy] = useState<null | "add" | "remove" | "collect">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const desk = pool.liquidityDesk;
  const { currency0, currency1 } = pool.key;

  // Pool state, the client's own position, and the two allowances that decide whether `add` can
  // work at all. One batch, because unlike the allowance reads on the asset table these are all
  // on the same chain and a Multicall3 hop failing here fails the whole card, visibly.
  // The range is anchored to the tick the pool was at when this card first read it, not to the
  // live tick: re-deriving it on every read would move the position key under the client's feet,
  // and the position this card offers to take back would stop resolving the moment the price
  // moved a spacing.
  // ponytail: session-anchored range. A position minted in an earlier session, at a different
  // price, is not found by this card — read the owner's Mint logs if that ever matters.
  const [anchor, setAnchor] = useState<number | null>(null);
  const ticks = rangeAt(pool, anchor ?? 0);

  const reads = useReadContracts({
    contracts: [
      { address: pool.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [poolStateSlot(pool.key)], chainId: pool.chainId },
      { address: pool.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [liquiditySlot(pool.key)], chainId: pool.chainId },
      {
        address: pool.poolManager,
        abi: poolManagerAbi,
        functionName: "extsload",
        args: [positionSlot(pool.key, desk, ticks.tickLower, ticks.tickUpper, owner ?? desk)],
        chainId: pool.chainId,
      },
      { address: CROSS_PERMIT, abi: crossPermitAbi, functionName: "allowance", args: [owner!, currency0, desk], chainId: pool.chainId },
      { address: CROSS_PERMIT, abi: crossPermitAbi, functionName: "allowance", args: [owner!, currency1, desk], chainId: pool.chainId },
    ],
    query: { enabled: Boolean(owner), refetchInterval: 30_000 },
  });

  const at = (i: number): unknown => {
    const r = reads.data?.[i];
    return r?.status === "success" ? r.result : undefined;
  };

  const slot0 = at(0) === undefined ? undefined : decodeSlot0(at(0) as `0x${string}`);
  const depth = at(1) === undefined ? undefined : BigInt(at(1) as `0x${string}`);
  const position = at(2) === undefined ? undefined : BigInt(at(2) as `0x${string}`);
  const allowance0 = at(3) as readonly [bigint, number, number] | undefined;
  const allowance1 = at(4) as readonly [bigint, number, number] | undefined;

  const nowSec = Math.floor(Date.now() / 1000);
  const liveAllowance = (a?: readonly [bigint, number, number]) => (a && Number(a[1]) > nowSec ? a[0] : 0n);

  // The whole quote, derived from the price the pool is at right now, and denominated in each
  // side's own units — WETH is 18dp and USDC 6dp, so a single shared parse would size one of them
  // a trillion times wrong.
  const quote = useMemo(() => {
    if (!slot0) return null;
    let units0: bigint;
    let units1: bigint;
    try {
      units0 = parseUnits(size || "0", pool.dec0);
      units1 = parseUnits(size || "0", pool.dec1);
    } catch {
      return null;
    }
    if (units0 <= 0n || units1 <= 0n) return null;
    const sqrtP = Number(slot0.sqrtPriceX96) / 2 ** 96;
    const liquidity = liquidityForAmounts(Number(units0), Number(units1), sqrtP, ticks.tickLower, ticks.tickUpper);
    if (liquidity <= 0) return null;
    const { amount0, amount1 } = amountsForLiquidity(liquidity, sqrtP, ticks.tickLower, ticks.tickUpper);
    const cap = (n: number) => BigInt(Math.ceil(n * SLIPPAGE) + 1);
    return { liquidity: BigInt(liquidity), amount0, amount1, max0: cap(amount0), max1: cap(amount1) };
  }, [slot0?.sqrtPriceX96, size, ticks.tickLower, ticks.tickUpper, pool.dec0, pool.dec1]);

  const covered =
    quote !== null && liveAllowance(allowance0) >= quote.max0 && liveAllowance(allowance1) >= quote.max1;

  if (slot0 && anchor === null) setAnchor(slot0.tick);

  // Lifted for the depth chart — from an effect, not from render. Calling the parent's setState
  // while rendering re-renders every card, which lifts again: that loop is what "Maximum update
  // depth exceeded" was. `onRow` is deliberately out of the deps; it is rebuilt every render.
  useEffect(() => {
    if (!slot0 || depth === undefined) return;
    onRow?.({
      id: poolId(pool.key),
      chainId: pool.chainId,
      source: pool.source,
      liquidity: depth,
      price: priceOf(pool, slot0.price),
      tick: slot0.tick,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth, slot0?.price, slot0?.tick]);

  /** The desk's transaction. It can only ever move the client's tokens into this pool. */
  async function addLiquidity() {
    if (!owner || !quote) return;
    setBusy("add");
    setError(null);
    setDone(null);
    try {
      if (!address) {
        openAppKit();
        throw new Error("connect a wallet to send the transaction");
      }
      if (walletChain !== pool.chainId) await switchChainAsync({ chainId: pool.chainId });
      const hash = await writeContractAsync({
        address: desk,
        abi: liquidityDeskAbi,
        functionName: "add",
        chainId: pool.chainId,
        args: [owner, pool.key, ticks.tickLower, ticks.tickUpper, quote.liquidity, quote.max0, quote.max1],
      });
      setDone(`${pool.explorer}/tx/${hash}`);
      setTimeout(() => reads.refetch(), 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Taking the position back, and sweeping what it earned.
   *
   * Both are `msg.sender`-scoped in the contract, so the connected wallet has to BE the client.
   * That is the asymmetry the whole product rests on: the desk can put capital in and only the
   * owner can take it out, and the screen refuses rather than sending a transaction that reverts.
   */
  async function withdraw(what: "remove" | "collect") {
    if (!owner || position === undefined) return;
    setBusy(what);
    setError(null);
    setDone(null);
    try {
      if (!address) {
        openAppKit();
        throw new Error("connect a wallet");
      }
      if (address.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(`only ${short(owner)} can take their own position back — this wallet is ${short(address)}`);
      }
      if (walletChain !== pool.chainId) await switchChainAsync({ chainId: pool.chainId });
      const hash = await writeContractAsync({
        address: desk,
        abi: liquidityDeskAbi,
        functionName: what,
        chainId: pool.chainId,
        args:
          what === "remove"
            ? [pool.key, ticks.tickLower, ticks.tickUpper, position]
            : [pool.key, ticks.tickLower, ticks.tickUpper],
      });
      setDone(`${pool.explorer}/tx/${hash}`);
      setTimeout(() => reads.refetch(), 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : String(e));
    } finally {
      setBusy(null);
    }
  }

  const positionAmounts =
    position && position > 0n && slot0
      ? amountsForLiquidity(Number(position), Number(slot0.sqrtPriceX96) / 2 ** 96, ticks.tickLower, ticks.tickUpper)
      : null;

  const priceNow = slot0 ? priceOf(pool, slot0.price) : null;
  const depthNum = depth === undefined ? null : Number(depth);
  const standing0 = liveAllowance(allowance0);
  const standing1 = liveAllowance(allowance1);

  return (
    <section className="pool-card" aria-labelledby={`pool-${poolId(pool.key).slice(0, 10)}`}>
      {/* The row Uniswap's own pool list leads with: the pair, what kind of pool it is, then the
          figures. Everything in it is read off this chain — there is no API behind this screen. */}
      <header className="pc-head">
        <PairMark pool={pool} />
        <div className="pc-name">
          <h4 id={`pool-${poolId(pool.key).slice(0, 10)}`}>
            {pool.sym0}/{pool.sym1}
          </h4>
          <span className="micro">
            v4 · {pool.key.fee / 10_000}% · {pool.key.hooks === ZERO_HOOK ? "No hook" : short(pool.key.hooks)} ·{" "}
            {pool.name}
          </span>
        </div>

        <dl className="pc-figs">
          <div>
            <dt>Price</dt>
            <dd>{priceNow === null ? "—" : fmt(priceNow, 6)}</dd>
            <span className="micro">
              {pool.sym1} per {pool.sym0}
            </span>
          </div>
          <div>
            <dt>Depth</dt>
            <dd>{depthNum === null ? "—" : compact(depthNum)}</dd>
            <span className="micro">in-range liquidity L</span>
          </div>
          <div>
            <dt>Tick</dt>
            <dd>{slot0?.tick ?? "—"}</dd>
            <span className="micro">
              offered {ticks.tickLower}…{ticks.tickUpper}
            </span>
          </div>
          <div>
            <dt>Position</dt>
            <dd>{position === undefined ? "—" : position === 0n ? "none" : compact(Number(position))}</dd>
            <span className="micro">
              {positionAmounts
                ? `≈ ${fmt(positionAmounts.amount0 / 10 ** pool.dec0, 4)} ${pool.sym0} + ${fmt(positionAmounts.amount1 / 10 ** pool.dec1, 4)} ${pool.sym1}`
                : "held in the client's name"}
            </span>
          </div>
        </dl>

        <span className={`tag ${slot0 ? "ok" : "awaiting"}`}>{slot0 ? "live" : "unread"}</span>
      </header>

      <div className="pc-body">
        <div className="pc-act">
          <label className="field">
            <span className="lbl">
              Size per side ({pool.sym0} / {pool.sym1})
            </span>
            <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" />
          </label>

          <button
            type="button"
            className="btn btn-sm btn-action"
            disabled={!covered || busy !== null}
            onClick={() => void addLiquidity()}
            title={
              covered
                ? "pull under the client's mandate and mint the position to them"
                : "the mandate does not cover this size on this chain"
            }
          >
            <span className="cap">{busy === "add" ? "Adding…" : "Add liquidity"}</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!position || busy !== null}
            onClick={() => void withdraw("collect")}
            title="sweep the fees this position has earned, to the client"
          >
            <span className="cap">{busy === "collect" ? "Collecting…" : "Collect fees"}</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!position || busy !== null}
            onClick={() => void withdraw("remove")}
            title="withdraw the whole position, principal and fees, to the client"
          >
            <span className="cap">{busy === "remove" ? "Withdrawing…" : "Take it back"}</span>
          </button>
          <span className={`tag ${covered ? "ok" : "warn"}`}>{covered ? "covered by the mandate" : "mandate too small"}</span>
        </div>

        <p className="micro pc-quote">
          {quote
            ? `pulls ≈ ${fmt(quote.amount0 / 10 ** pool.dec0)} ${pool.sym0} + ${fmt(quote.amount1 / 10 ** pool.dec1)} ${pool.sym1}, capped at ${fmt(
                Number(quote.max0) / 10 ** pool.dec0,
              )} + ${fmt(Number(quote.max1) / 10 ** pool.dec1)} · L ${quote.liquidity.toString()}`
            : "enter a size to quote the position"}
        </p>

        <dl className="kv-list pc-kv">
          <div className="kv">
            <dt className="micro">Standing to the desk</dt>
            <dd>
              {formatUnits(standing0, pool.dec0)} {pool.sym0} · {formatUnits(standing1, pool.dec1)} {pool.sym1}
            </dd>
          </div>
          <div className="kv">
            <dt className="micro">PoolManager</dt>
            <dd>
              <a href={`${pool.explorer}/address/${pool.poolManager}`} target="_blank" rel="noreferrer">
                {short(pool.poolManager)}
              </a>
            </dd>
          </div>
          <div className="kv">
            <dt className="micro">LiquidityDesk</dt>
            <dd>
              <a href={`${pool.explorer}/address/${desk}`} target="_blank" rel="noreferrer">
                {short(desk)}
              </a>
            </dd>
          </div>
          <div className="kv">
            <dt className="micro">Tokens</dt>
            <dd>
              <a href={`${pool.explorer}/token/${currency0}`} target="_blank" rel="noreferrer">
                {short(currency0)}
              </a>{" "}
              ·{" "}
              <a href={`${pool.explorer}/token/${currency1}`} target="_blank" rel="noreferrer">
                {short(currency1)}
              </a>
            </dd>
          </div>
        </dl>

        <p className="note">
          {covered
            ? "Desk adds; only the client's own wallet can collect or take back."
            : "Mandate too small here — only the client can raise it."}
        </p>

        {error && (
          <p className="note blocked" role="alert">
            {error}
          </p>
        )}
        {done && (
          <p className="note">
            {done.startsWith("http") ? (
              <a href={done} target="_blank" rel="noreferrer">
                transaction sent — {short(done.split("/tx/")[1] ?? "", 8)}
              </a>
            ) : (
              done
            )}
          </p>
        )}
      </div>

      {chainById(pool.chainId) === undefined && <p className="note">Chain not in the desk&rsquo;s list.</p>}
    </section>
  );
}
