// Cross-chain cancellation: kill a signed-but-unsubmitted permission everywhere, with one signature.
//
// This is the other half of a usable permission system. An institution that has signed a
// multichain intent and then changes its mind — a counterparty downgraded, a spender compromised —
// must be able to retract it on every chain without chasing each one separately. Same merkle
// machinery as the permit path, different signed struct.
import {
  type Account,
  type Address,
  type Hex,
  type WalletClient,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  toBytes,
} from "viem";

import type { ChainCtx } from "./crosspermit.js";

export const cancelAbi = parseAbi([
  "struct NoncesToInvalidate { uint64 chainId; bytes32[] salts; }",
  "function invalidateNonces(address owner, uint48 deadline, NoncesToInvalidate invalidations, bytes32[] proof, bytes signature)",
  "function invalidateNonces(bytes32[] salts)",
  "function isNonceUsed(address owner, bytes32 salt) view returns (bool)",
  "function hashNoncesToInvalidate(NoncesToInvalidate invalidations) pure returns (bytes32)",
]);

/** `SaltRegistry.NONCES_TO_INVALIDATE_TYPEHASH`. */
export const NONCES_TO_INVALIDATE_TYPEHASH = keccak256(toBytes("NoncesToInvalidate(uint64 chainId,bytes32[] salts)"));

export type Invalidation = { chainId: bigint; salts: Hex[] };

/**
 * `SaltRegistry.hashNoncesToInvalidate`, computed locally.
 *
 * Note this is NOT the EIP-712 encoding of a struct with a dynamic array: the contract does a plain
 * `abi.encode(typehash, chainId, salts)`, so the array contributes an offset, a length and its
 * elements rather than `keccak256(abi.encodePacked(salts))`. Matching the contract matters more than
 * matching the spec here — a "more correct" local hash would simply never verify.
 */
export const invalidationLeaf = (inv: Invalidation): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32[]" }],
      [NONCES_TO_INVALIDATE_TYPEHASH, inv.chainId, inv.salts],
    ),
  );

/** Compute the leaf locally, then make the chain agree — same rule as the permit path. */
export async function invalidationLeafChecked(ctx: ChainCtx, inv: Invalidation): Promise<Hex> {
  const local = invalidationLeaf(inv);
  const onChain = await ctx.client.readContract({
    address: ctx.crossPermit,
    abi: cancelAbi,
    functionName: "hashNoncesToInvalidate",
    args: [inv],
  });
  if (local !== onChain) {
    throw new Error(`invalidation leaf mismatch on chain ${ctx.chainId}: local ${local}, chain says ${onChain}`);
  }
  return local;
}

/**
 * Sign one root that cancels salts on every chain.
 *
 * Same chain-agnostic domain as `signRoot` — `chainId: 1` pinned — so the one signature ports. Note
 * there is no `timestamp` in this struct: a cancellation is not ordered against the allowance
 * timeline, it just burns the salt, and a burnt salt can never be un-burnt.
 */
export async function signCancelRoot(
  wallet: WalletClient,
  account: Account | Address,
  crossPermit: Address,
  msg: { owner: Address; deadline: number; merkleRoot: Hex },
): Promise<Hex> {
  return wallet.signTypedData({
    account,
    domain: { name: "CrossPermit", version: "1", chainId: 1, verifyingContract: crossPermit },
    types: {
      CancelCrossPermit: [
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint48" },
        { name: "merkleRoot", type: "bytes32" },
      ],
    },
    primaryType: "CancelCrossPermit",
    message: msg,
  });
}

/** Submit one chain's cancellation. Anyone may submit; it only destroys authority, never grants it. */
export async function submitInvalidation(
  ctx: ChainCtx,
  account: Account | Address,
  a: { owner: Address; deadline: number; inv: Invalidation; proof: Hex[]; signature: Hex; nonce?: number },
): Promise<Hex> {
  const hash = await ctx.wallet.writeContract({
    account,
    chain: null,
    nonce: a.nonce,
    address: ctx.crossPermit,
    abi: cancelAbi,
    functionName: "invalidateNonces",
    args: [a.owner, a.deadline, a.inv, a.proof, a.signature],
  });
  const receipt = await ctx.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`invalidateNonces reverted on chain ${ctx.chainId}: ${hash}`);
  return hash;
}
