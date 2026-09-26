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
  /** The v4 LP adapter that pulls under a CrossPermit writ. */
  liquidityDesk: Address;
  key: PoolKey;
  /** The range the pool was seeded over, and the one this dashboard offers. */
  tickLower: number;
  tickUpper: number;
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * One pool per chain, from `deployments/v4pool-*.json` and `deployments/liquidity-*.json`.
 *
 * Hard-coded rather than fetched for the same reason the CrossPermit address is: a pool key read
 * from whatever the network offered would let the page quote depth for a pool nobody signed for.
 * Change a fee or a tick spacing here and it is a different, uninitialised pool.
 */
export const POOLS: PoolInfo[] = [
  {
    chainId: 84532,
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    liquidityDesk: "0xE666e3F76062d670A84b964Ca4D9B456b1531C03",
    key: {
      currency0: "0x4c309fD174629eE7Ac8eEceae8669FBaFD9953A2",
      currency1: "0x974727EA649Ee0EfBB6A1b1A584614838B832cB3",
      fee: 3000,
      tickSpacing: 60,
      hooks: ZERO,
    },
    tickLower: -600,
    tickUpper: 600,
  },
  {
    chainId: 11155420,
    poolManager: "0xf7F5aB3DcA35e17dE187b459159BC643853B3c67",
    liquidityDesk: "0x012a12367CeEB9e4ead98803D8019913cA80c3C2",
    key: {
      currency0: "0x903321dB019c620A9907E76e29927E0e7ACc4764",
      currency1: "0xC2aB86958061e874DD211a9d7c6860D2Bf5C92F1",
      fee: 3000,
      tickSpacing: 60,
      hooks: ZERO,
    },
    tickLower: -600,
    tickUpper: 600,
  },
  {
    chainId: 11155111,
    poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
    liquidityDesk: "0x2EDaA9629436C9D0b93301422a27b640068D7Cde",
    key: {
      currency0: "0x496C39F509a1ec2B63cBE689e7FD52D56Ee02C17",
      currency1: "0x98feA3a8eC2c4075470dF4d5c497E2DFF31feD88",
      fee: 3000,
      tickSpacing: 60,
      hooks: ZERO,
    },
    tickLower: -600,
    tickUpper: 600,
  },
];

export const poolOn = (chainId: number) => POOLS.find((p) => p.chainId === chainId);

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
    // currency1 per currency0. Both test tokens are 6dp, so no decimal correction is needed here;
    // a pool pairing different decimals would need one, and this is where it would go.
    price: (Number(sqrtPriceX96) / 2 ** 96) ** 2,
  };
}

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
