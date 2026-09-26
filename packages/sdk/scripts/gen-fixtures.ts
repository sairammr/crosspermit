// Emits everything the forge tests check the TypeScript client against. Running the real encoders
// here means a drift in the client fails a unit test instead of a testnet transaction.
//
//   contracts/fixtures/swap-calldata.txt      UniversalRouter.execute calldata for a v4 exact-in single swap
//   contracts/fixtures/permit2-transfer.txt   UniversalRouter.execute calldata for PERMIT2_TRANSFER_FROM
//   contracts/fixtures/merkle-fixtures.txt    root:leaf:proof triples for tree sizes 1..8
//   contracts/fixtures/leaf-fixtures.txt      leaf:abi-encoded ChainPermits pairs
import { writeFileSync } from "node:fs";
import { type Address, type Hex, encodeAbiParameters, keccak256, toHex } from "viem";
import {
  type ChainPermits,
  approveEntry,
  buildUnbalancedTree,
  leafOf,
  lockEntry,
  tokenKey,
  transferEntry,
} from "../src/crosspermit.js";
import { encodePermit2TransferFrom, encodeV4ExactInSingleSwap } from "../src/router.js";

const write = (name: string, body: string) => {
  writeFileSync(new URL(`../../../contracts/fixtures/${name}`, import.meta.url), body);
  console.log(`  ${name}`);
};

// ---------- Universal Router calldata ----------

const SWAP_FIXTURE = {
  poolKey: {
    currency0: "0x1111111111111111111111111111111111111111" as Address,
    currency1: "0x2222222222222222222222222222222222222222" as Address,
    fee: 500,
    tickSpacing: 10,
    hooks: "0x0000000000000000000000000000000000000000" as Address,
  },
  zeroForOne: true,
  amountIn: 5_000000n,
  minOut: 123n,
  deadline: 1_900_000_000n,
};

const TRANSFER_FIXTURE = {
  token: "0x3333333333333333333333333333333333333333" as Address,
  recipient: "0x4444444444444444444444444444444444444444" as Address,
  amount: 7_000000n,
  deadline: 1_900_000_000n,
};

// ---------- Merkle trees ----------

const syntheticLeaf = (tree: number, index: number): Hex => keccak256(toHex(`leaf/${tree}/${index}`));

const merkleLines: string[] = [];
for (let n = 1; n <= 8; n++) {
  const leaves = Array.from({ length: n }, (_, i) => syntheticLeaf(n, i));
  const { root, proofs } = buildUnbalancedTree(leaves);
  leaves.forEach((leaf, i) => {
    const proof = proofs[i]!;
    merkleLines.push(`${root}:${leaf}:${proof.length === 0 ? "-" : proof.join(",")}`);
  });
}

// ---------- ChainPermits leaves ----------

const TOKEN = "0x5555555555555555555555555555555555555555" as Address;
const SPENDER = "0x6666666666666666666666666666666666666666" as Address;
const RECIPIENT = "0x7777777777777777777777777777777777777777" as Address;
const MAX_UINT160 = 2n ** 160n - 1n;

const bundles: ChainPermits[] = [
  { chainId: 1n, permits: [] }, // empty array: keccak of nothing
  { chainId: 11155111n, permits: [approveEntry(TOKEN, SPENDER, 10_000000n, 1_900_000_000)] },
  {
    chainId: 84532n,
    permits: [approveEntry(TOKEN, SPENDER, 5_000000n, 1_900_000_000), transferEntry(TOKEN, RECIPIENT, 2_000000n)],
  },
  { chainId: 1301n, permits: [lockEntry(TOKEN, SPENDER)] },
  { chainId: 2n ** 64n - 1n, permits: [approveEntry(TOKEN, SPENDER, MAX_UINT160, 2 ** 48 - 1)] },
  {
    chainId: 0n,
    permits: [
      // An NFT-style key: not a clean address, so the transfer path would reject it, but it still
      // has to hash the same way.
      { modeOrExpiration: 1, tokenKey: keccak256(toHex("collection/1")), account: SPENDER, amountDelta: 0n },
      { modeOrExpiration: 3, tokenKey: tokenKey(TOKEN), account: SPENDER, amountDelta: 1n },
    ],
  },
];

const chainPermitsAbi = [
  {
    type: "tuple",
    components: [
      { name: "chainId", type: "uint64" },
      {
        name: "permits",
        type: "tuple[]",
        components: [
          { name: "modeOrExpiration", type: "uint48" },
          { name: "tokenKey", type: "bytes32" },
          { name: "account", type: "address" },
          { name: "amountDelta", type: "uint160" },
        ],
      },
    ],
  },
] as const;

const leafLines = bundles.map((cp) => `${leafOf(cp)}:${encodeAbiParameters(chainPermitsAbi, [cp])}`);

console.log("fixtures:");
write("swap-calldata.txt", encodeV4ExactInSingleSwap(SWAP_FIXTURE));
write("permit2-transfer.txt", encodePermit2TransferFrom(TRANSFER_FIXTURE));
write("merkle-fixtures.txt", `${merkleLines.join("\n")}\n`);
write("leaf-fixtures.txt", `${leafLines.join("\n")}\n`);
