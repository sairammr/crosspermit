"use client";

/**
 * The Uniswap v4 pools this desk's assets actually trade in, read straight off the PoolManager.
 *
 * v4 exposes no getters — the whole pool lives in one mapping and is read with `extsload`. So the
 * storage layout is computed here, the same way `StateLibrary` computes it, and verified against a
 * pool whose liquidity we seeded and therefore know: Base Sepolia's slot0 reads back lpFee 3000 and
 * its liquidity slot reads back exactly the 1e12 the seeder put in.
 *
 *   pool state slot = keccak256(poolId ++ uint256(6))
 *     + 0  slot0   = lpFee(24) | protocolFee(24) | tick(24) | sqrtPriceX96(160)
 *     + 3  liquidity
 *     + 6  positions mapping, keyed by keccak256(owner ++ tickLower ++ tickUpper ++ salt)
 */

import { type Address, encodeAbiParameters, encodePacked, keccak256, parseAbi } from "viem";

import { CHAINS } from "./config";

export const poolManagerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

export const liquidityDeskAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function add(address owner, PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity, uint128 max0, uint128 max1)",
  "function remove(PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity)",
  "function collect(PoolKey key, int24 tickLower, int24 tickUpper)",
]);

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type PoolInfo = {
  chainId: number;
  poolManager: Address;
  /** The v4 LP adapter that pulls under the client's signed mandate. */
  liquidityDesk: Address;
  key: PoolKey;
  /**
   * Where the pool came from.
   *
   * `uniswap` is a pool this repository did not create: Uniswap's own testnet deployment, the
   * canonical WETH/USDC pair, with whatever depth the public has put in it. `seeded` is one
   * `V4PoolSeeder` created over two mock tokens this repository deployed — useful because a demo
   * client actually holds those, useless as evidence that anything works against the real world.
   */
  source: "uniswap" | "seeded";
  /** Both sides, so a quote can be denominated in each token's own units rather than assuming 6dp. */
  sym0: string;
  sym1: string;
  dec0: number;
  dec1: number;
  /**
   * How many tick spacings either side of the pool's current tick a position is offered over.
   *
   * A fixed −600…600 was right only while every pool here was a 1:1 mock pair: WETH/USDC sits near
   * tick −196000, where that range is nowhere near the price and any position minted in it would be
   * entirely one-sided. The range is therefore computed from the live tick, at `rangeSpacings`
   * spacings out, and aligned down to the spacing the way v4 requires.
   */
  rangeSpacings: number;
};

/** The offered range for a pool, from the tick it is at right now. */
export function rangeAt(pool: Pick<PoolInfo, "key" | "rangeSpacings">, tick: number) {
  const s = pool.key.tickSpacing;
  const mid = Math.floor(tick / s) * s;
  return { tickLower: mid - pool.rangeSpacings * s, tickUpper: mid + pool.rangeSpacings * s };
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * One pool per chain, from `deployments/v4pool-*.json` and `deployments/liquidity-*.json`.
 *
 * Hard-coded rather than fetched for the same reason the CrossPermit address is: a pool key read
 * from whatever the network offered would let the page quote depth for a pool nobody signed for.
 * Change a fee or a tick spacing here and it is a different, uninitialised pool.
 */
export const POOLS: PoolInfo[] = [
  // ---- Uniswap's own pools, on Uniswap's own PoolManagers ----
  // Found by sweeping each PoolManager's Initialize logs and reading slot0/liquidity back with
  // `extsload`; only hookless ERC20/ERC20 pools are listed, because `LiquidityDesk` settles with
  // `CrossPermit.transferFrom` and can therefore never pay a native-ETH side. That rules out the
  // deepest testnet pools — ETH/USDC on Ethereum Sepolia — however much depth they carry.
  {
    chainId: 84532,
    source: "uniswap",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    liquidityDesk: "0xE666e3F76062d670A84b964Ca4D9B456b1531C03",
    key: {
      // WETH (canonical predeploy) / USDC (Circle's own Base Sepolia deployment).
      currency0: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      currency1: "0x4200000000000000000000000000000000000006",
      fee: 100,
      tickSpacing: 1,
      hooks: ZERO,
    },
    sym0: "USDC",
    sym1: "WETH",
    dec0: 6,
    dec1: 18,
    rangeSpacings: 200,
  },
  {
    chainId: 11155111,
    source: "uniswap",
    poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
    liquidityDesk: "0x2EDaA9629436C9D0b93301422a27b640068D7Cde",
    key: {
      // The only hookless ERC20/ERC20 canonical pool with any depth on Ethereum Sepolia. It is
      // thin — the liquidity there is in the native ETH/USDC pools, which this adapter cannot pay.
      currency0: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      currency1: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
      fee: 10_000,
      tickSpacing: 200,
      hooks: ZERO,
    },
    sym0: "USDC",
    sym1: "WETH",
    dec0: 6,
    dec1: 18,
    rangeSpacings: 2,
  },

  // ---- our own seeded pools ----
  // Kept, and labelled, for one reason: a demo client holds these mock tokens and can therefore
  // actually be allocated. Optimism Sepolia has no Uniswap v4 pool at all — no Initialize event in
  // 600k blocks, and none of the canonical keys are even initialised — so this is the only venue
  // there.
  {
    chainId: 11155420,
    source: "seeded",
    poolManager: "0xf7F5aB3DcA35e17dE187b459159BC643853B3c67",
    liquidityDesk: "0x012a12367CeEB9e4ead98803D8019913cA80c3C2",
    key: {
      currency0: "0x903321dB019c620A9907E76e29927E0e7ACc4764",
      currency1: "0xC2aB86958061e874DD211a9d7c6860D2Bf5C92F1",
      fee: 3000,
      tickSpacing: 60,
      hooks: ZERO,
    },
    sym0: "mUSDC",
    sym1: "mUSDC",
    dec0: 6,
    dec1: 6,
    rangeSpacings: 10,
  },
  {
    chainId: 84532,
    source: "seeded",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    liquidityDesk: "0xE666e3F76062d670A84b964Ca4D9B456b1531C03",
    key: {
      currency0: "0x4c309fD174629eE7Ac8eEceae8669FBaFD9953A2",
      currency1: "0x974727EA649Ee0EfBB6A1b1A584614838B832cB3",
      fee: 3000,
      tickSpacing: 60,
      hooks: ZERO,
    },
    sym0: "mUSDC",
    sym1: "mUSDC",
    dec0: 6,
    dec1: 6,
    rangeSpacings: 10,
  },
  {
    chainId: 11155111,
    source: "seeded",
    poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
    liquidityDesk: "0x2EDaA9629436C9D0b93301422a27b640068D7Cde",
    key: {
      currency0: "0x496C39F509a1ec2B63cBE689e7FD52D56Ee02C17",
      currency1: "0x98feA3a8eC2c4075470dF4d5c497E2DFF31feD88",
      fee: 3000,
      tickSpacing: 60,
      hooks: ZERO,
    },
    sym0: "mUSDC",
    sym1: "mUSDC",
    dec0: 6,
    dec1: 6,
    rangeSpacings: 10,
  },
];

/**
 * Fail at import if a pool names a currency no mandate can be granted over.
 *
 * The LiquidityDesk settles with `CrossPermit.transferFrom`, so it can only ever move a token the
 * client's signature named — and the mandate screen writes one permit entry per token in that
 * chain's `tokens` list. A pool currency missing from that list therefore has an allowance of zero
 * that nothing on any screen can raise, and the card reads "mandate too small" at every size, for
 * every client, permanently. That is a config mismatch wearing the costume of a live market
 * condition, which is the worst kind of bug to read off a dashboard. Break the build instead.
 */
for (const p of POOLS) {
  const chain = CHAINS.find((c) => c.id === p.chainId);
  if (!chain) continue;
  const granted = new Set(chain.tokens.map((t) => t.toLowerCase()));
  for (const [side, currency] of [
    ["currency0", p.key.currency0],
    ["currency1", p.key.currency1],
  ] as const) {
    if (!granted.has(currency.toLowerCase())) {
      throw new Error(
        `${chain.name}: pool ${p.sym0}/${p.sym1} names ${side} ${currency}, which is not in CHAINS.tokens — ` +
          `no mandate can grant over it, so that pool would read "mandate too small" forever. Add it to config.ts.`,
      );
    }
  }
}

/** The venue a chain leads with: Uniswap's own pool where there is one. */
export const poolOn = (chainId: number) =>
  POOLS.find((p) => p.chainId === chainId && p.source === "uniswap") ?? POOLS.find((p) => p.chainId === chainId);

/** Every pool whose key names this token — i.e. the venues one approved asset can actually reach. */
export const poolsForToken = (token: Address) =>
  POOLS.filter(
    (p) =>
      p.key.currency0.toLowerCase() === token.toLowerCase() || p.key.currency1.toLowerCase() === token.toLowerCase(),
  );

export function poolId(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;
const POSITIONS_OFFSET = 6n;

const asSlot = (v: bigint): `0x${string}` => `0x${v.toString(16).padStart(64, "0")}`;

export function poolStateSlot(key: PoolKey): `0x${string}` {
  return keccak256(encodePacked(["bytes32", "uint256"], [poolId(key), POOLS_SLOT]));
}

export const liquiditySlot = (key: PoolKey) => asSlot(BigInt(poolStateSlot(key)) + LIQUIDITY_OFFSET);

/**
 * Where one client's position lives.
 *
 * `owner` is the LiquidityDesk — v4 credits the contract that called `modifyLiquidity` — and the
 * client is the salt. That is the whole reason the desk needs no share accounting of its own.
 */
export function positionSlot(key: PoolKey, desk: Address, tickLower: number, tickUpper: number, client: Address) {
  const positionId = keccak256(
    encodePacked(["address", "int24", "int24", "bytes32"], [desk, tickLower, tickUpper, asSlot(BigInt(client))]),
  );
  const mapping = asSlot(BigInt(poolStateSlot(key)) + POSITIONS_OFFSET);
  return keccak256(encodePacked(["bytes32", "bytes32"], [positionId, mapping]));
}

export type Slot0 = { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number; price: number };

/** Unpack slot0. `tick` is a signed 24-bit field, so it has to be sign-extended by hand. */
export function decodeSlot0(word: `0x${string}`): Slot0 {
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  const raw = Number((v >> 160n) & 0xffffffn);
  const tick = raw >= 0x800000 ? raw - 0x1000000 : raw;
  return {
    sqrtPriceX96,
    tick,
    protocolFee: Number((v >> 184n) & 0xffffffn),
    lpFee: Number((v >> 208n) & 0xffffffn),
    // currency1 per currency0, in each side's SMALLEST units — slot0 knows nothing about decimals.
    // `priceOf` below turns it into a human price; a caller that prints this raw will print e8 on
    // any pair whose two sides differ in decimals.
    price: (Number(sqrtPriceX96) / 2 ** 96) ** 2,
  };
}

/**
 * `slot0.price` as a human would quote it: currency1 per whole currency0.
 *
 * The raw ratio is between smallest units, so a 6dp/18dp pair reads ~1e12 out. Every pool here was
 * a 1:1 6dp mock when this was written and the correction was a no-op; two of them are now real
 * WETH/USDC pairs, where it is the difference between a price and a phone number.
 */
export const priceOf = (pool: Pick<PoolInfo, "dec0" | "dec1">, price: number) =>
  price * 10 ** (pool.dec0 - pool.dec1);

export const sqrtAtTick = (tick: number) => Math.sqrt(1.0001 ** tick);

/**
 * How much of each side a given liquidity costs at the current price, and the inverse.
 *
 * Floating point, deliberately. These figures drive a preview and the two slippage caps passed to
 * `LiquidityDesk.add`; the amounts that actually move are computed by v4 itself inside the unlock,
 * and the caps carry a buffer. Doing Q96 fixed-point here would be more code for a number that is
 * an estimate by construction — the pool price moves between the preview and the block.
 *
 * ponytail: float math with a cap buffer. Move to Q64.96 if this ever sizes a real position.
 */
export function amountsForLiquidity(liquidity: number, sqrtP: number, tickLower: number, tickUpper: number) {
  const sqrtA = sqrtAtTick(tickLower);
  const sqrtB = sqrtAtTick(tickUpper);
  const p = Math.min(Math.max(sqrtP, sqrtA), sqrtB);
  return {
    amount0: (liquidity * (sqrtB - p)) / (p * sqrtB),
    amount1: liquidity * (p - sqrtA),
  };
}

/** The largest liquidity `amount0`/`amount1` can both fund. Whichever side runs out first wins. */
export function liquidityForAmounts(amount0: number, amount1: number, sqrtP: number, tickLower: number, tickUpper: number) {
  const sqrtA = sqrtAtTick(tickLower);
  const sqrtB = sqrtAtTick(tickUpper);
  const p = Math.min(Math.max(sqrtP, sqrtA), sqrtB);
  const l0 = p < sqrtB ? (amount0 * (p * sqrtB)) / (sqrtB - p) : Number.POSITIVE_INFINITY;
  const l1 = p > sqrtA ? amount1 / (p - sqrtA) : Number.POSITIVE_INFINITY;
  const l = Math.min(l0, l1);
  return Number.isFinite(l) ? Math.floor(l) : 0;
}

/** Chains that have both a pool and a deployed adapter, for the "where can this run" line. */
export const POOL_CHAINS = POOLS.map((p) => ({
  ...p,
  name: CHAINS.find((c) => c.id === p.chainId)?.name ?? String(p.chainId),
  short: CHAINS.find((c) => c.id === p.chainId)?.short ?? String(p.chainId),
  explorer: CHAINS.find((c) => c.id === p.chainId)?.explorer ?? "",
}));
