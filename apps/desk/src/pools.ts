// The pools this desk can actually deploy into, read off each chain's PoolManager.
//
// Read server side rather than in the page: the page has no RPC of its own, the reads are the same
// for every viewer, and one cached answer beats every open tab hammering three testnets. The slot
// math and the LP arithmetic are NOT restated here — they are imported from `@crosspermit/web`,
// where they are already checked against a pool whose liquidity we seeded and therefore know.
import { type Address, createPublicClient, http, parseAbi } from "viem";

import { CHAINS } from "@crosspermit/web/src/config";
import {
  type PoolInfo,
  POOLS,
  amountsForLiquidity,
  decodeSlot0,
  liquiditySlot,
  poolManagerAbi,
  poolStateSlot,
  positionSlot,
} from "@crosspermit/web/src/pools";

const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

/** One client's stake in a pool. The desk holds the v4 position; the client is its salt. */
export type Position = { liquidity: string; amount0: number; amount1: number; share: number };

export type PoolView = {
  chainId: number;
  chain: string;
  short: string;
  color: string;
  explorer: string;
  poolManager: Address;
  liquidityDesk: Address;
  /** `USDC/WETH`, or `USDC·53A2/USDC·2cB3` when the two sides share a symbol. */
  pair: string;
  /** True when both sides report the same symbol — two test mints, not a real pair. Said, not hidden. */
  sameSymbol: boolean;
  currency0: { address: Address; symbol: string; decimals: number };
  currency1: { address: Address; symbol: string; decimals: number };
  /** Fee in basis points of a percent, as v4 stores it: 3000 = 0.30%. */
  fee: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  /** null when the chain did not answer — which is not the same as a pool with no depth. */
  state: null | {
    tick: number;
    price: number;
    lpFee: number;
    liquidity: string;
    /** What that liquidity is worth in each token, at the current price, over the offered range. */
    reserve0: number;
    reserve1: number;
    /** One client's own position in this pool, when an owner was asked for. */
    position?: Position;
  };
  error?: string;
};

const clients = new Map<number, ReturnType<typeof createPublicClient>>();
const client = (chainId: number) => {
  const chain = CHAINS.find((c) => c.id === chainId);
  if (!chain) throw new Error(`no RPC configured for chain ${chainId}`);
  if (!clients.has(chainId)) clients.set(chainId, createPublicClient({ transport: http(chain.rpc) }));
  return clients.get(chainId)!;
};

/** Symbols and decimals are read from the token, not written in a config, and cached for the process. */
const meta = new Map<string, { symbol: string; decimals: number }>();
async function tokenMeta(chainId: number, token: Address) {
  const k = `${chainId}:${token.toLowerCase()}`;
  if (!meta.has(k)) {
    const c = client(chainId);
    const [symbol, decimals] = await Promise.all([
      c.readContract({ address: token, abi: erc20, functionName: "symbol" }),
      c.readContract({ address: token, abi: erc20, functionName: "decimals" }),
    ]);
    meta.set(k, { symbol: symbol as string, decimals: Number(decimals) });
  }
  return meta.get(k)!;
}

async function readPool(pool: PoolInfo, owner?: Address): Promise<PoolView> {
  const chain = CHAINS.find((c) => c.id === pool.chainId);
  const base = {
    chainId: pool.chainId,
    chain: chain?.name ?? String(pool.chainId),
    short: chain?.short ?? String(pool.chainId),
    color: chain?.color ?? "#888",
    explorer: chain?.explorer ?? "",
    poolManager: pool.poolManager,
    liquidityDesk: pool.liquidityDesk,
    fee: pool.key.fee,
    tickSpacing: pool.key.tickSpacing,
    tickLower: pool.tickLower,
    tickUpper: pool.tickUpper,
  };

  try {
    const c = client(pool.chainId);
    const read = (slot: `0x${string}`) =>
      c.readContract({ address: pool.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot] });

    const [word0, wordL, m0, m1] = await Promise.all([
      read(poolStateSlot(pool.key)),
      read(liquiditySlot(pool.key)),
      tokenMeta(pool.chainId, pool.key.currency0),
      tokenMeta(pool.chainId, pool.key.currency1),
    ]);

    const slot0 = decodeSlot0(word0 as `0x${string}`);
    const liquidity = BigInt(wordL as `0x${string}`);
    const sqrtP = Number(slot0.sqrtPriceX96) / 2 ** 96;
    const { amount0, amount1 } = amountsForLiquidity(Number(liquidity), sqrtP, pool.tickLower, pool.tickUpper);

    let position: Position | undefined;
    if (owner) {
      const word = (await read(
        positionSlot(pool.key, pool.liquidityDesk, pool.tickLower, pool.tickUpper, owner),
      )) as `0x${string}`;
      const own = BigInt(word);
      if (own > 0n) {
        const mine = amountsForLiquidity(Number(own), sqrtP, pool.tickLower, pool.tickUpper);
        position = {
          liquidity: own.toString(),
          amount0: mine.amount0 / 10 ** m0.decimals,
          amount1: mine.amount1 / 10 ** m1.decimals,
          share: liquidity > 0n ? Number(own) / Number(liquidity) : 0,
        };
      }
    }

    // Both seeded test tokens report "USDC", so a bare `USDC/USDC` would read as a pool that cannot
    // exist. Tagged with the last two bytes of each address instead, which is what actually
    // distinguishes them — and `sameSymbol` lets the page say so in words.
    const sameSymbol = m0.symbol === m1.symbol;
    const tag = (a: Address) => a.slice(-4).toUpperCase();
    return {
      ...base,
      sameSymbol,
      pair: sameSymbol
        ? `${m0.symbol}·${tag(pool.key.currency0)}/${m1.symbol}·${tag(pool.key.currency1)}`
        : `${m0.symbol}/${m1.symbol}`,
      currency0: { address: pool.key.currency0, ...m0 },
      currency1: { address: pool.key.currency1, ...m1 },
      state: {
        tick: slot0.tick,
        price: slot0.price,
        lpFee: slot0.lpFee,
        liquidity: liquidity.toString(),
        reserve0: amount0 / 10 ** m0.decimals,
        reserve1: amount1 / 10 ** m1.decimals,
        ...(position ? { position } : {}),
      },
    };
  } catch (e) {
    // A chain that did not answer is said so, per pool. Rendering it as an empty pool would read as
    // "no depth here", and those are different facts.
    return {
      ...base,
      pair: "…",
      sameSymbol: false,
      currency0: { address: pool.key.currency0, symbol: "?", decimals: 18 },
      currency1: { address: pool.key.currency1, symbol: "?", decimals: 18 },
      state: null,
      error: e instanceof Error ? e.message.split("\n")[0]! : String(e),
    };
  }
}

/**
 * Every pool, in parallel, with a short cache.
 *
 * ponytail: 20s process cache, no invalidation. It exists so a dashboard left open does not read
 * three testnets every render; a pool's depth does not move fast enough for that to mislead. Drop
 * the TTL if this ever prices an order.
 */
const CACHE_MS = 20_000;
let cached: { at: number; owner?: string; pools: PoolView[] } | null = null;

export async function pools(owner?: Address): Promise<PoolView[]> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS && cached.owner === owner?.toLowerCase()) return cached.pools;
  const out = await Promise.all(POOLS.map((p) => readPool(p, owner)));
  cached = { at: now, owner: owner?.toLowerCase(), pools: out };
  return out;
}
