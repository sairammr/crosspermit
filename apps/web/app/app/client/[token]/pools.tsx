"use client";

/**
 * The Uniswap v4 pools this client's approved assets trade in, and the one action a mandate can
 * take in them: provide liquidity, paid for by the writ.
 *
 * The flow is two steps and they are deliberately not merged. Step one is the CLIENT signing a
 * liquidity writ — an allowance naming `LiquidityDesk` as spender on both sides of the pair, on
 * every chain they choose, from one signature. Step two is the DESK calling `add`, which is a
 * transaction anyone may send: it can only move tokens from an account that signed such a writ, it
 * can only move them into the PoolManager, and the position it creates belongs to the client.
 *
 * Which is the product claim, expressed as a screen: the desk can put the client's capital to work
 * without ever being able to take it.
 */

import { useMemo, useState } from "react";
import { type Address, formatUnits, parseUnits } from "viem";
import { useAccount, useReadContracts, useSwitchChain, useSignTypedData, useWriteContract } from "wagmi";

import { SIGNING_CHAIN_ID, approveEntry, crossPermitAbi, prepareIntent, toWire } from "@crosspermit/sdk";
import { CROSS_PERMIT, chainById } from "../../../../src/config";
import {
  POOL_CHAINS,
  amountsForLiquidity,
  decodeSlot0,
  liquidityDeskAbi,
  liquidityForAmounts,
  liquiditySlot,
  poolManagerAbi,
  poolStateSlot,
  positionSlot,
} from "../../../../src/pools";
import { postIntent } from "../../../../src/relayer";
import { onSigningChain, openAppKit } from "../../../../src/wagmi";

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
        <Pool key={p.chainId} pool={p} owner={owner} onRow={(row) => onRows?.([row])} />
      ))}
      <p className="note">
        Uniswap has no v4 deployment this desk can reach on Unichain Sepolia, and MultiBaas does not index it either,
        so the three pools above are Base, Optimism and Ethereum Sepolia. Each one is a real pool with real depth,
        created by <span className="mono">V4PoolSeeder</span> and traded by the lifecycle script.
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
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [size, setSize] = useState("1");
  const [busy, setBusy] = useState<null | "writ" | "add" | "remove" | "collect">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const desk = pool.liquidityDesk;
  const { currency0, currency1 } = pool.key;

  // Pool state, the client's own position, and the two allowances that decide whether `add` can
  // work at all. One batch, because unlike the allowance reads on the asset table these are all
  // on the same chain and a Multicall3 hop failing here fails the whole card, visibly.
  const reads = useReadContracts({
    contracts: [
      { address: pool.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [poolStateSlot(pool.key)], chainId: pool.chainId },
      { address: pool.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [liquiditySlot(pool.key)], chainId: pool.chainId },
      {
        address: pool.poolManager,
        abi: poolManagerAbi,
        functionName: "extsload",
        args: [positionSlot(pool.key, desk, pool.tickLower, pool.tickUpper, owner ?? desk)],
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

  // The whole quote, derived from the price the pool is at right now.
  const quote = useMemo(() => {
    if (!slot0) return null;
    let units: bigint;
    try {
      units = parseUnits(size || "0", 6);
    } catch {
      return null;
    }
    if (units <= 0n) return null;
    const sqrtP = Number(slot0.sqrtPriceX96) / 2 ** 96;
    const budget = Number(units);
    const liquidity = liquidityForAmounts(budget, budget, sqrtP, pool.tickLower, pool.tickUpper);
    if (liquidity <= 0) return null;
    const { amount0, amount1 } = amountsForLiquidity(liquidity, sqrtP, pool.tickLower, pool.tickUpper);
    const cap = (n: number) => BigInt(Math.ceil(n * SLIPPAGE) + 1);
    return { liquidity: BigInt(liquidity), amount0, amount1, max0: cap(amount0), max1: cap(amount1) };
  }, [slot0?.sqrtPriceX96, size, pool.tickLower, pool.tickUpper]);

  const covered =
    quote !== null && liveAllowance(allowance0) >= quote.max0 && liveAllowance(allowance1) >= quote.max1;

  if (slot0 && depth !== undefined) {
    // Lifted for the depth chart. Cheap enough to do on render; the parent dedupes by chain.
    onRow?.({ chainId: pool.chainId, liquidity: depth, price: slot0.price, tick: slot0.tick });
  }

  /** One signature: an allowance to the LiquidityDesk on BOTH sides of the pair. */
  async function signWrit() {
    if (!owner || !quote) return;
    setBusy("writ");
    setError(null);
    setDone(null);
    try {
      if (!address) {
        openAppKit();
        throw new Error("connect the client's wallet to sign the writ");
      }
      if (address.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(`only ${short(owner)} can widen their own writ — this wallet is ${short(address)}`);
      }
      const now = Math.floor(Date.now() / 1000);
      const expiry = now + 24 * 3600;
      // Headroom over this one add, so a second position does not need a second signature — and
      // stated as such rather than quietly granting more than the screen showed.
      const grant = (n: bigint) => n * 4n;
      const { intent, typedData } = prepareIntent({
        crossPermit: CROSS_PERMIT,
        owner,
        now,
        ttl: 3600,
        chains: [
          {
            chainId: pool.chainId,
            permits: [
              approveEntry(currency0, desk, grant(quote.max0), expiry),
              approveEntry(currency1, desk, grant(quote.max1), expiry),
            ],
          },
        ],
      });
      await onSigningChain(walletChain, switchChainAsync);
      const signature = await signTypedDataAsync({ ...typedData, chainId: SIGNING_CHAIN_ID } as never);
      const { status, body } = await postIntent(toWire({ ...intent, signature }));
      if (status >= 400) throw new Error(`${body.code ?? status}: ${body.error ?? "rejected"}`);
      setDone(`writ submitted — intent ${short(String(body.intentId), 8)}`);
      setTimeout(() => reads.refetch(), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
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
        args: [owner, pool.key, pool.tickLower, pool.tickUpper, quote.liquidity, quote.max0, quote.max1],
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
            ? [pool.key, pool.tickLower, pool.tickUpper, position]
            : [pool.key, pool.tickLower, pool.tickUpper],
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
      ? amountsForLiquidity(Number(position), Number(slot0.sqrtPriceX96) / 2 ** 96, pool.tickLower, pool.tickUpper)
      : null;

  return (
    <section className="pool" aria-labelledby={`pool-${pool.chainId}`}>
      <div className="rec-head">
        <h4 id={`pool-${pool.chainId}`}>{pool.name}</h4>
        <span className="micro kindtag">
          {pool.key.fee / 10_000}% · spacing {pool.key.tickSpacing}
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
          <div className="v">{depth === undefined ? "—" : fmt(Number(depth) / 1e6, 2)}</div>
          <div className="n">in-range liquidity, L/1e6</div>
        </div>
        <div className="stat">
          <div className="k">This client&rsquo;s position</div>
          <div className="v">{position === undefined ? "—" : position === 0n ? "none" : fmt(Number(position) / 1e6, 2)}</div>
          <div className="n">
            {positionAmounts
              ? `≈ ${fmt(positionAmounts.amount0 / 1e6, 4)} + ${fmt(positionAmounts.amount1 / 1e6, 4)} at today's price`
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
          <span className="lbl">Size per side (6dp)</span>
          <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" />
        </label>
        <span className="micro">
          {quote
            ? `pulls ≈ ${fmt(quote.amount0 / 1e6)} + ${fmt(quote.amount1 / 1e6)}, capped at ${fmt(
                Number(quote.max0) / 1e6,
              )} + ${fmt(Number(quote.max1) / 1e6)} · L ${quote.liquidity.toString()} over ticks ${pool.tickLower}…${pool.tickUpper}`
            : "enter a size to quote the position"}
        </span>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className={covered ? "btn btn-sm" : "btn btn-sm btn-action"}
          disabled={!owner || !quote || busy !== null}
          onClick={() => void signWrit()}
          title="the client signs an allowance naming the LiquidityDesk, on both sides of the pair"
        >
          <span className="cap">{busy === "writ" ? "Signing…" : covered ? "Writ covers this" : "1 · Sign liquidity writ"}</span>
        </button>
        <button
          type="button"
          className={covered ? "btn btn-sm btn-action" : "btn btn-sm"}
          disabled={!covered || busy !== null}
          onClick={() => void addLiquidity()}
          title={covered ? "pull under the writ and mint the position to the client" : "no writ covers this size yet"}
        >
          <span className="cap">{busy === "add" ? "Adding…" : "2 · Add to the pool"}</span>
        </button>
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
        Writ standing to the desk: {formatUnits(liveAllowance(allowance0), 6)} of currency0,{" "}
        {formatUnits(liveAllowance(allowance1), 6)} of currency1.
        {covered
          ? " Enough for this size. `add` settles by calling CrossPermit.transferFrom(client → PoolManager) inside the v4 unlock — the desk never holds a balance."
          : " Not enough for this size, so step two is closed until the client widens it."}
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
