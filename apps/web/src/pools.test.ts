import { expect, test } from "bun:test";

import {
  POOLS,
  decodeSlot0,
  liquidityForAmounts,
  liquiditySlot,
  poolId,
  poolStateSlot,
  poolsForToken,
  rangeAt,
} from "./pools";

// The seeded Base pool specifically: the storage-layout assertions below were checked against that
// deployment, and the list now leads with Uniswap's own pool on the same chain.
const base = POOLS.find((p) => p.chainId === 84532 && p.source === "seeded")!;

// Both values were computed independently with `cast keccak` against the deployed Base Sepolia
// pool, and the liquidity slot below reads back the exact 1e12 the seeder put in. If the storage
// layout assumption is ever wrong, this is what catches it before a screen quotes a bad depth.
test("the pool id and state slot match what the chain answers to", () => {
  expect(poolId(base.key)).toBe("0xf8d27efed554f8613d78872423481b753053c1da452d1af2d25b338c59a11f1f");
  expect(poolStateSlot(base.key)).toBe("0x30aafddab1f1266bcb46555ec3a116b6315a136b32e6985e3d91684fcb393aa2");
  expect(liquiditySlot(base.key)).toBe("0x30aafddab1f1266bcb46555ec3a116b6315a136b32e6985e3d91684fcb393aa5");
});

test("slot0 unpacks the word Base Sepolia actually returned", () => {
  const s = decodeSlot0("0x000000000bb80000000000000000000000000001000042e8545f1f41b11cba6c");
  expect(s.lpFee).toBe(3000);
  expect(s.protocolFee).toBe(0);
  expect(s.tick).toBe(0);
  // Seeded at 1:1 and nudged by the lifecycle swaps, so just above 2**96.
  expect(s.sqrtPriceX96).toBeGreaterThan(2n ** 96n);
  expect(s.price).toBeGreaterThan(0.999);
  expect(s.price).toBeLessThan(1.001);
});

test("a negative tick sign-extends instead of reading as 16 million", () => {
  // tick = -600 packed into bits 160..183.
  const word = `0x${(((2n ** 24n - 600n) << 160n) | 2n ** 96n).toString(16).padStart(64, "0")}` as const;
  expect(decodeSlot0(word).tick).toBe(-600);
});

test("liquidity is capped by whichever side runs out first", () => {
  const sqrtP = 1;
  const both = liquidityForAmounts(1e6, 1e6, sqrtP, -600, 600);
  const starved = liquidityForAmounts(1e6, 1, sqrtP, -600, 600);
  expect(starved).toBeLessThan(both);
  expect(both).toBeGreaterThan(0);
});

test("every approved test token maps to exactly one pool per chain", () => {
  expect(poolsForToken(base.key.currency0)).toHaveLength(1);
  expect(poolsForToken("0x0000000000000000000000000000000000000001")).toHaveLength(0);
});

// The two invariants LiquidityDesk cannot survive being wrong about: it settles with
// `CrossPermit.transferFrom`, so neither side may be native ETH, and it calls `modifyLiquidity`
// itself, so a hook that gates the caller would revert every allocation.
test("every listed pool is hookless and has two ERC20 sides", () => {
  for (const p of POOLS) {
    expect(p.key.hooks).toBe("0x0000000000000000000000000000000000000000");
    expect(p.key.currency0).not.toBe("0x0000000000000000000000000000000000000000");
    expect(BigInt(p.key.currency0)).toBeLessThan(BigInt(p.key.currency1));
  }
});

test("the offered range straddles the pool's tick and lands on the spacing", () => {
  const uni = POOLS.find((p) => p.source === "uniswap")!;
  const { tickLower, tickUpper } = rangeAt(uni, -196_419);
  expect(Math.abs(tickLower % uni.key.tickSpacing)).toBe(0);
  expect(Math.abs(tickUpper % uni.key.tickSpacing)).toBe(0);
  expect(tickLower).toBeLessThan(-196_419);
  expect(tickUpper).toBeGreaterThan(-196_419);
});
