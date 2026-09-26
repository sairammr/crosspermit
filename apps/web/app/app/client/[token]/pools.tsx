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

import { useMemo, useState } from "react";
import { type Address, formatUnits, parseUnits } from "viem";
import { useAccount, useReadContracts, useSwitchChain, useWriteContract } from "wagmi";

import { crossPermitAbi } from "@crosspermit/sdk";
import { CROSS_PERMIT, chainById } from "../../../../src/config";
import {
  POOL_CHAINS,
  amountsForLiquidity,
  poolId,
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

export type PoolRow = {
  chainId: number;
  /** Live depth, for the chart on the left. */
  liquidity: bigint;
  price: number;
  tick: number;
};

export function PoolsPanel({
  owner,
  onRows,
}: {
  owner?: Address;
  /** Live pool figures lifted to the page, so the charts and the panel read the same numbers. */
  onRows?: (rows: PoolRow[]) => void;
}) {
  return (
    <div className="panel">
      <div className="sec-head">
        <h2>Uniswap v4 pools</h2>
        <span className="label">04 / Venue</span>
      </div>
      <p className="sub">
        Read from each PoolManager&rsquo;s own storage with <span className="mono">extsload</span> — v4 has no getters,
        so the slot layout is computed the way <span className="mono">StateLibrary</span> computes it and checked
        against a pool whose liquidity we seeded.
      </p>
      {POOL_CHAINS.map((p) => (
        // Keyed by the pool, not the chain: a chain can carry both Uniswap's own pool and one this
        // repo seeded, and those are two different venues with two different positions.
        <Pool key={poolId(p.key)} pool={p} owner={owner} onRow={(row) => onRows?.([row])} />
      ))}
      <p className="note">
        Two of these are Uniswap&rsquo;s own pools — the canonical USDC/WETH pairs on Base and Ethereum Sepolia, found
        by sweeping each PoolManager&rsquo;s <span className="mono">Initialize</span> log and reading depth back with{" "}
        <span className="mono">extsload</span>. They are listed instead of anything deeper because{" "}
        <span className="mono">LiquidityDesk</span> settles with <span className="mono">CrossPermit.transferFrom</span>{" "}
        and therefore cannot pay a native-ETH side: Ethereum Sepolia&rsquo;s deepest v4 pools are ETH/USDC and are out
        of reach by construction. Optimism Sepolia has no Uniswap v4 pool at all — no{" "}
        <span className="mono">Initialize</span> event in 600k blocks — so the venue there, and the ones marked{" "}
        <em>seeded</em>, are this repository&rsquo;s own <span className="mono">V4PoolSeeder</span> pools over mock
        tokens. A client can only be allocated into a pool whose two tokens they actually hold.
      </p>
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

  if (slot0 && depth !== undefined) {
    // Lifted for the depth chart. Cheap enough to do on render; the parent dedupes by chain.
    onRow?.({ chainId: pool.chainId, liquidity: depth, price: slot0.price, tick: slot0.tick });
  }

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

  return (
    <section className="pool" aria-labelledby={`pool-${pool.chainId}`}>
      <div className="rec-head">
        <h4 id={`pool-${pool.chainId}`}>{pool.name}</h4>
        <span className="micro kindtag">
          {pool.sym0}/{pool.sym1} · {pool.key.fee / 10_000}% · spacing {pool.key.tickSpacing}
        </span>
        <span className={`tag ${pool.source === "uniswap" ? "ok" : "awaiting"}`}>
          {pool.source === "uniswap" ? "Uniswap's own pool" : "seeded by this repo"}
        </span>
        <span className={`tag ${slot0 ? "active" : "awaiting"}`}>{slot0 ? "pool live" : "unread"}</span>
      </div>

      <div className="grid">
        <div className="stat">
          <div className="k">Price</div>
          <div className="v">{slot0 ? fmt(slot0.price, 6) : "—"}</div>
          <div className="n">currency1 per currency0 · tick {slot0?.tick ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="k">Depth</div>
          <div className="v">{depth === undefined ? "—" : depth.toString()}</div>
          <div className="n">in-range liquidity, L/1e6</div>
        </div>
        <div className="stat">
          <div className="k">This client&rsquo;s position</div>
          <div className="v">{position === undefined ? "—" : position === 0n ? "none" : position.toString()}</div>
          <div className="n">
            {positionAmounts
              ? `≈ ${fmt(positionAmounts.amount0 / 10 ** pool.dec0, 4)} ${pool.sym0} + ${fmt(positionAmounts.amount1 / 10 ** pool.dec1, 4)} ${pool.sym1} at today's price`
              : "salt = the client's address, so v4 holds it in their name"}
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <td>PoolManager</td>
              <td>
                <a href={`${pool.explorer}/address/${pool.poolManager}`} target="_blank" rel="noreferrer">
                  {short(pool.poolManager)}
                </a>
              </td>
              <td>currency0</td>
              <td>
                <a href={`${pool.explorer}/token/${currency0}`} target="_blank" rel="noreferrer">
                  {short(currency0)}
                </a>
              </td>
            </tr>
            <tr>
              <td>LiquidityDesk</td>
              <td>
                <a href={`${pool.explorer}/address/${desk}`} target="_blank" rel="noreferrer">
                  {short(desk)}
                </a>
              </td>
              <td>currency1</td>
              <td>
                <a href={`${pool.explorer}/token/${currency1}`} target="_blank" rel="noreferrer">
                  {short(currency1)}
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="row subject" style={{ marginTop: 10 }}>
        <label className="field">
          <span className="lbl">Size per side ({pool.sym0} / {pool.sym1})</span>
          <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" />
        </label>
        <span className="micro">
          {quote
            ? `pulls ≈ ${fmt(quote.amount0 / 10 ** pool.dec0)} ${pool.sym0} + ${fmt(
                quote.amount1 / 10 ** pool.dec1,
              )} ${pool.sym1}, capped at ${fmt(Number(quote.max0) / 10 ** pool.dec0)} + ${fmt(
                Number(quote.max1) / 10 ** pool.dec1,
              )} · L ${quote.liquidity.toString()} over ticks ${ticks.tickLower}…${ticks.tickUpper}`
            : "enter a size to quote the position"}
        </span>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-sm btn-action"
          disabled={!covered || busy !== null}
          onClick={() => void addLiquidity()}
          title={covered ? "pull under the client's mandate and mint the position to them" : "the mandate does not cover this size on this chain"}
        >
          <span className="cap">{busy === "add" ? "Adding…" : "Add to the pool"}</span>
        </button>
        <span className={`tag ${covered ? "ok" : "warn"}`}>{covered ? "covered by the mandate" : "mandate too small for this size"}</span>
        <span className="micro">
          {covered
            ? "the desk's transaction — the client signs nothing here"
            : "reduce the size, or ask the client to re-sign a larger mandate"}
        </span>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
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
        <span className="micro">
          {position
            ? "client's own wallet only — the desk has no path to either of these"
            : "nothing to take back on this chain yet"}
        </span>
      </div>

      <p className="note">
        Fees are not quoted here. v4 accrues them into the position and settles the figure at the moment you sweep;
        a number computed off two `feeGrowthInside` snapshots in a browser would be a guess presented as earnings.
        Collect returns what the pool actually owes, to the client&rsquo;s address.
      </p>

      <p className="note">
        Standing to the LiquidityDesk under the client&rsquo;s one signed mandate:{" "}
        {formatUnits(liveAllowance(allowance0), pool.dec0)} {pool.sym0},{" "}
        {formatUnits(liveAllowance(allowance1), pool.dec1)} {pool.sym1}.
        {covered
          ? " Enough for this size. `add` settles by calling CrossPermit.transferFrom(client → PoolManager) inside the v4 unlock — the desk never holds a balance, and the client is not asked to sign again."
          : " Not enough for this size on this chain. The mandate is the only thing that can raise it, and only the client can sign one."}
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
      {chainById(pool.chainId) === undefined && (
        <p className="note">This chain is not in the dashboard&rsquo;s own list, so balances are not shown for it.</p>
      )}
    </section>
  );
}
