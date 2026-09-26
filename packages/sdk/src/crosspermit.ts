// CrossPermit client: one signature, every chain.
//
// This is the only place a permission is ever built. It runs in the browser or the dApp; the
// relayer in apps/relayer is a convenience for paying gas, never a dependency.
//
// The user signs ONE EIP-712 message over a merkle root of per-chain permit bundles; each chain is
// then unlocked by submitting that chain's bundle plus its merkle proof to the CrossPermit deployed
// at the SAME address on every chain.
import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  concat,
  encodeAbiParameters,
  keccak256,
  pad,
  parseAbi,
  toBytes,
  toHex,
} from "viem";

// ---------- ABIs (verified against the CrossPermit core in contracts/src) ----------
export const crossPermitAbi = parseAbi([
  "struct AllowanceOrTransfer { uint48 modeOrExpiration; bytes32 tokenKey; address account; uint160 amountDelta; }",
  "struct ChainPermits { uint64 chainId; AllowanceOrTransfer[] permits; }",
  "function hashChainPermits(ChainPermits chainPermits) pure returns (bytes32)",
  "function permit(address owner, bytes32 salt, uint48 deadline, uint48 timestamp, ChainPermits permits, bytes32[] proof, bytes signature)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 timestamp)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

/**
 * `modeOrExpiration` semantics (ICrossPermit.sol):
 *   0 = immediate ERC20 transfer, 1 = decrease allowance, 2 = lock, 3 = unlock,
 *   > 3 = increase allowance, and the value itself is the new expiration timestamp.
 */
export const MODE = { TRANSFER: 0, DECREASE: 1, LOCK: 2, UNLOCK: 3 } as const;

export type Entry = { modeOrExpiration: number; tokenKey: Hex; account: Address; amountDelta: bigint };
export type ChainPermits = { chainId: bigint; permits: Entry[] };
export type ChainCtx = { chainId: number; client: PublicClient; wallet: WalletClient; crossPermit: Address };

/** ERC20 token key is the address left-padded to 32 bytes (ERC721/1155 use keccak(token, id)). */
export const tokenKey = (token: Address): Hex => pad(token, { size: 32 });

export const approveEntry = (token: Address, spender: Address, amount: bigint, expiry: number): Entry => {
  if (expiry <= MODE.UNLOCK) throw new Error(`expiry ${expiry} collides with a mode value; must be > 3`);
  return { modeOrExpiration: expiry, tokenKey: tokenKey(token), account: spender, amountDelta: amount };
};
export const transferEntry = (token: Address, to: Address, amount: bigint): Entry => ({
  modeOrExpiration: MODE.TRANSFER,
  tokenKey: tokenKey(token),
  account: to,
  amountDelta: amount,
});
/** A lock is per (owner, token, SPENDER) — it blocks that spender, not the whole token. */
export const lockEntry = (token: Address, spender: Address): Entry => ({
  modeOrExpiration: MODE.LOCK,
  tokenKey: tokenKey(token),
  account: spender,
  amountDelta: 0n,
});

// ---------- Leaves ----------

/** `CrossPermit.CHAIN_PERMITS_TYPEHASH`. */
export const CHAIN_PERMITS_TYPEHASH = keccak256(
  toBytes(
    "ChainPermits(uint64 chainId,AllowanceOrTransfer[] permits)" +
      "AllowanceOrTransfer(uint48 modeOrExpiration,bytes32 tokenKey,address account,uint160 amountDelta)",
  ),
);

/**
 * `CrossPermit.hashChainPermits`, computed locally.
 *
 * This MUST stay local. The leaf is the only thing standing between the user and a root they did
 * not build: if it came back from an `eth_call`, a hostile RPC could answer with the hash of its
 * own bundle, the wallet would show nothing but an opaque `merkleRoot`, and the signature would
 * authorise the attacker's permits. `test/LeafParity.t.sol` pins this against the real contract.
 *
 * Note the per-entry hash carries no typehash prefix — it is a raw `abi.encode` of the four fields.
 */
export function leafOf(cp: ChainPermits): Hex {
  const entryHashes = cp.permits.map((p) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "uint48" }, { type: "bytes32" }, { type: "address" }, { type: "uint160" }],
        [p.modeOrExpiration, p.tokenKey, p.account, p.amountDelta],
      ),
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }],
      [CHAIN_PERMITS_TYPEHASH, cp.chainId, keccak256(concat(entryHashes))],
    ),
  );
}

/**
 * Belt and braces: compute the leaf locally, then make the chain agree. A mismatch means either a
 * CrossPermit that is not the one this client was written against, or an RPC that is lying — refuse
 * to sign either way.
 */
export async function leafOfChecked(ctx: ChainCtx, cp: ChainPermits): Promise<Hex> {
  const local = leafOf(cp);
  const onChain = await ctx.client.readContract({
    address: ctx.crossPermit,
    abi: crossPermitAbi,
    functionName: "hashChainPermits",
    args: [cp],
  });
  if (local !== onChain) {
    throw new Error(`leaf mismatch on chain ${ctx.chainId}: local ${local}, ${ctx.crossPermit} says ${onChain}`);
  }
  return local;
}

// ---------- Unbalanced merkle tree ----------

/** OpenZeppelin sorted-pair hashing — what `MerkleProof.processProof` (used by CrossPermit) reconstructs with. */
const hashPair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/**
 * Left-leaning ("unbalanced") tree: root = H(...H(H(l0,l1),l2)..., l_{n-1}).
 * The LAST leaf sits one hop from the root, so it carries the shortest proof and the cheapest
 * calldata. Order leaves CHEAPEST chain first, MOST EXPENSIVE chain last.
 *
 * Returns the root and one proof per leaf, index-aligned with `leaves`.
 */
export function buildUnbalancedTree(leaves: Hex[]): { root: Hex; proofs: Hex[][] } {
  if (leaves.length === 0) throw new Error("no leaves");
  if (leaves.length === 1) return { root: leaves[0]!, proofs: [[]] };

  // acc[i] is the node covering leaves[0..i].
  const acc: Hex[] = [leaves[0]!];
  for (let i = 1; i < leaves.length; i++) acc.push(hashPair(acc[i - 1]!, leaves[i]!));

  const proofs = leaves.map((_, i) => {
    // Sibling first (leaf 0 pairs with leaf 1; every other leaf pairs with the accumulator below it),
    // then every leaf above, which is the order processProof folds them in.
    const proof: Hex[] = [i === 0 ? leaves[1]! : acc[i - 1]!];
    for (let j = Math.max(i, 1) + 1; j < leaves.length; j++) proof.push(leaves[j]!);
    return proof;
  });

  return { root: acc[acc.length - 1]!, proofs };
}

/** Recompute the root from a leaf + proof the way the contract does. Use it to self-check before signing. */
export function processProof(leaf: Hex, proof: Hex[]): Hex {
  return proof.reduce(hashPair, leaf);
}

// ---------- One EIP-712 signature for every chain ----------

export type PermitMessage = {
  owner: Address;
  salt: Hex;
  deadline: number;
  timestamp: number;
  merkleRoot: Hex;
};

/**
 * The CrossPermit domain pins `chainId` to 1 on every chain (EIP712.sol `CROSS_CHAIN_ID`), which is
 * exactly what makes one signature valid everywhere. This is NOT a bug: do not substitute the
 * live chain id.
 */
export async function signRoot(
  wallet: WalletClient,
  account: Account | Address,
  crossPermit: Address,
  msg: PermitMessage,
): Promise<Hex> {
  return wallet.signTypedData({
    account,
    domain: { name: "CrossPermit", version: "1", chainId: 1, verifyingContract: crossPermit },
    types: {
      CrossPermit: [
        { name: "owner", type: "address" },
        { name: "salt", type: "bytes32" },
        { name: "deadline", type: "uint48" },
        { name: "timestamp", type: "uint48" },
        { name: "merkleRoot", type: "bytes32" },
      ],
    },
    primaryType: "CrossPermit",
    message: msg,
  });
}

export const randomSalt = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));

// ---------- Submit on one chain ----------

/**
 * Anyone may submit — it only sets allowances and executes transfers the owner already signed.
 * The router still pulls from its own caller, so a stranger submitting cannot spend anything.
 */
export async function submitPermit(
  ctx: ChainCtx,
  account: Account | Address,
  a: Omit<PermitMessage, "merkleRoot"> & { cp: ChainPermits; proof: Hex[]; signature: Hex; nonce?: number },
): Promise<Hex> {
  const hash = await ctx.wallet.writeContract({
    account,
    chain: null,
    nonce: a.nonce,
    address: ctx.crossPermit,
    abi: crossPermitAbi,
    functionName: "permit",
    args: [a.owner, a.salt, a.deadline, a.timestamp, a.cp, a.proof, a.signature],
  });
  const receipt = await ctx.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`permit reverted on chain ${ctx.chainId}: ${hash}`);
  return hash;
}
