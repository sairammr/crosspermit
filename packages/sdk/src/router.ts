// Universal Router v4 swap encoding.
//
// Layouts verified against Uniswap/universal-router @ 543e1a19d6e21e31ced2512eec5792b50f13a0ba
// and its pinned lib/v4-periphery @ a7af5b345b479b05fde9182d7e40913a73b3e18f.
import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, parseAbi } from "viem";

export const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

/** Commands.sol */
export const COMMAND_V4_SWAP = "0x10" as const;

/** Actions.sol — SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL, in execution order. */
export const ACTIONS_EXACT_IN_SINGLE = "0x060c0f" as const;

/** v4-core types/PoolKey.sol */
export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/** v4 requires `currency0 < currency1`, compared as integers. Hookless pool, so `hooks` is zero. */
export function poolKeyFor(tokenA: Address, tokenB: Address, fee: number, tickSpacing: number): PoolKey {
  if (BigInt(tokenA) === BigInt(tokenB)) throw new Error(`a pool needs two different currencies, got ${tokenA} twice`);
  const [currency0, currency1] = BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  return { currency0, currency1, fee, tickSpacing, hooks: "0x0000000000000000000000000000000000000000" };
}

const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

/**
 * IV4Router.ExactInputSingleParams.
 *
 * `minHopPriceX36` is REQUIRED on this pin: the decoder demands a 0x160-byte payload ("9 elements"),
 * so encoding the older 5-field struct reverts. 0 disables the per-hop price check.
 */
const exactInputSingleParams = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: poolKeyComponents },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "minHopPriceX36", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

const currencyAndAmount = [{ type: "address" }, { type: "uint256" }] as const;

export type ExactInSingle = {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  /** Minimum acceptable output; also the TAKE_ALL floor. */
  minOut: bigint;
  /** Per-hop price floor, X36 fixed point. 0 disables it. */
  minHopPriceX36?: bigint;
  hookData?: Hex;
};

/** The single `inputs[0]` blob for a V4_SWAP command: abi.encode(bytes actions, bytes[] params). */
export function encodeV4ExactInSingleInput(p: ExactInSingle): Hex {
  const tokenIn = p.zeroForOne ? p.poolKey.currency0 : p.poolKey.currency1;
  const tokenOut = p.zeroForOne ? p.poolKey.currency1 : p.poolKey.currency0;

  const swap = encodeAbiParameters(exactInputSingleParams, [
    {
      poolKey: p.poolKey,
      zeroForOne: p.zeroForOne,
      amountIn: p.amountIn,
      amountOutMinimum: p.minOut,
      minHopPriceX36: p.minHopPriceX36 ?? 0n,
      hookData: p.hookData ?? "0x",
    },
  ]);
  // SETTLE_ALL's uint256 is a MAX the router may pull; TAKE_ALL's is a MIN it must deliver.
  const settleAll = encodeAbiParameters(currencyAndAmount, [tokenIn, p.amountIn]);
  const takeAll = encodeAbiParameters(currencyAndAmount, [tokenOut, p.minOut]);

  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [
    ACTIONS_EXACT_IN_SINGLE,
    [swap, settleAll, takeAll],
  ]);
}

/**
 * Full `UniversalRouter.execute` calldata for a v4 exact-in single-hop swap.
 * The input side is paid by the user through CrossPermit, so no separate approval call is needed —
 * the allowance was already set by the cross-chain permit.
 */
export function encodeV4ExactInSingleSwap(p: ExactInSingle & { deadline: bigint }): Hex {
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [COMMAND_V4_SWAP, [encodeV4ExactInSingleInput(p)], p.deadline],
  });
}

/** Commands.sol — PERMIT2_TRANSFER_FROM. Pulls `amount` of `token` from the caller via PERMIT2. */
export const COMMAND_PERMIT2_TRANSFER_FROM = "0x02" as const;

/**
 * `execute` calldata for a straight Permit2-backed pull.
 *
 * This is the cheapest end-to-end proof that a router was deployed with `permit2 := CrossPermit`:
 * the router's PERMIT2 immutable has no getter, so the only way to read it is to make the router
 * spend through it. The pull succeeds only if the allowance lives in CrossPermit.
 */
export function encodePermit2TransferFrom(p: {
  token: Address;
  recipient: Address;
  amount: bigint;
  deadline: bigint;
}): Hex {
  // The dispatcher passes `recipient` through `map()`, which rewrites address(1) to the caller and
  // address(2) to the router itself. Tokens parked in the router are sweepable by anyone, so these
  // must be deliberate, never the result of a zero-ish address slipping through.
  if (BigInt(p.recipient) <= 2n) {
    throw new Error(`recipient ${p.recipient} is a Universal Router magic constant, not an address`);
  }
  const input = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint160" }],
    [p.token, p.recipient, p.amount],
  );
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [COMMAND_PERMIT2_TRANSFER_FROM, [input], p.deadline],
  });
}
