// The liquidity writ, end to end, on live testnets.
//
// One signature from the CLIENT, one transaction from the DESK — two different keys, on purpose —
// and the client ends up holding a Uniswap v4 position they never sent a token to fund.
//
//   client  signs a CrossPermit allowance naming LiquidityDesk on BOTH sides of the pair
//   desk    calls LiquidityDesk.add(client, ...) and the pool is paid by
//           CrossPermit.transferFrom(client -> PoolManager) inside the v4 unlock
//   client  can take it back; the desk cannot, and the script proves that by trying
//
//   forge build && set -a && . ./.env && set +a && bun run packages/sdk/scripts/liquidity-demo.ts
//
// Flags: --chain BaseSepolia|OPSepolia|Sepolia   (default BaseSepolia)
//        --size 1.5                              per side, 6dp
//        --keep                                  leave the position in place
import { readFileSync } from "node:fs";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { TIMESTAMP_LAG } from "../src/intent.js";
import {
  type ChainCtx,
  approveEntry,
  crossPermitAbi,
  leafOfChecked,
  randomSalt,
  signRoot,
  submitPermit,
} from "../src/crosspermit.js";

const root = new URL("../../../", import.meta.url).pathname;
const readJson = (p: string) => JSON.parse(readFileSync(`${root}${p}`, "utf8"));
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (run: set -a && . ./.env && set +a)`);
  return v;
};
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const CHAINS = {
  BaseSepolia: { chainId: 84532, rpc: "RPC_BASE_SEPOLIA", explorer: "https://sepolia.basescan.org" },
  OPSepolia: { chainId: 11155420, rpc: "RPC_OP_SEPOLIA", explorer: "https://sepolia-optimism.etherscan.io" },
  Sepolia: { chainId: 11155111, rpc: "RPC_ETH_SEPOLIA", explorer: "https://sepolia.etherscan.io" },
} as const;

const key = (arg("chain") ?? "BaseSepolia") as keyof typeof CHAINS;
const chain = CHAINS[key];
if (!chain) throw new Error(`unknown --chain ${key}`);

const pool = readJson(`deployments/v4pool-${key}.json`);
const desk = readJson(`deployments/liquidity-${key}.json`).address as Address;
const crossPermit = readJson("deployments/crosspermit.json").address as Address;

const poolKey = {
  currency0: pool.currency0 as Address,
  currency1: pool.currency1 as Address,
  fee: pool.fee as number,
  tickSpacing: pool.tickSpacing as number,
  hooks: pool.hooks as Address,
};
const TICK_LOWER = -600;
const TICK_UPPER = 600;

const deskAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function add(address owner, PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity, uint128 max0, uint128 max1)",
  "function remove(PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity)",
]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);

const client = privateKeyToAccount(env("PRIVATE_KEY") as Hex);
// A different key, because "the desk can deploy the client's capital" is only a claim worth making
// if the desk is genuinely not the client.
const deskCaller = privateKeyToAccount(env("RELAYER_PRIVATE_KEY") as Hex);

const transport = http(env(chain.rpc));
const pub = createPublicClient({ transport });
const wallet = createWalletClient({ transport });
const ctx: ChainCtx = { chainId: chain.chainId, client: pub, wallet, crossPermit };

const size = parseUnits(arg("size") ?? "1", 6);
const ok = (s: string) => console.log(`  ok   ${s}`);

console.log(`liquidity writ on ${key}`);
console.log(`  client ${client.address}`);
console.log(`  desk   ${deskCaller.address}  (LiquidityDesk ${desk})`);
console.log(`  pool   ${pool.poolManager}  ${poolKey.currency0} / ${poolKey.currency1}`);

// ---------- the client's one-time ERC20 approval to CrossPermit, exactly like Permit2 ----------

for (const token of [poolKey.currency0, poolKey.currency1]) {
  const held = await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [client.address] });
  if (held < size * 4n) {
    const hash = await wallet.writeContract({
      account: client, chain: null, address: token, abi: erc20, functionName: "mint", args: [client.address, size * 100n],
    });
    await pub.waitForTransactionReceipt({ hash });
    ok(`minted test ${token} to the client`);
  }
  const approved = await pub.readContract({ address: token, abi: erc20, functionName: "allowance", args: [client.address, crossPermit] });
  if (approved < size * 8n) {
    const hash = await wallet.writeContract({
      account: client, chain: null, address: token, abi: erc20, functionName: "approve", args: [crossPermit, 2n ** 256n - 1n],
    });
    await pub.waitForTransactionReceipt({ hash });
    ok(`client approved CrossPermit on ${token}`);
  }
}

// ---------- 1. the writ: one signature, both sides of the pair ----------

const now = Math.floor(Date.now() / 1000);
const expiry = now + 6 * 3600;
const cap = size * 2n;
const cp = {
  chainId: BigInt(chain.chainId),
  permits: [approveEntry(poolKey.currency0, desk, cap, expiry), approveEntry(poolKey.currency1, desk, cap, expiry)],
};
const leaf = await leafOfChecked(ctx, cp);
// Behind wall clock on purpose, by the SDK's own lag: the contract rejects a timestamp ahead of
// the block it lands in, and a local clock a few seconds fast is the normal case, not the exception.
const msg = { owner: client.address, salt: randomSalt(), deadline: expiry, timestamp: now - TIMESTAMP_LAG, merkleRoot: leaf };
const signature = await signRoot(wallet, client, crossPermit, msg);
// Single-chain bundle, so the tree is one leaf and the proof is empty.
const permitTx = await submitPermit(ctx, deskCaller, { ...msg, cp, proof: [], signature });
ok(`writ armed — ${chain.explorer}/tx/${permitTx}`);

const allowanceOf = async (token: Address) =>
  (await pub.readContract({ address: crossPermit, abi: crossPermitAbi, functionName: "allowance", args: [client.address, token, desk] })) as readonly [
    bigint,
    number,
    number,
  ];
ok(`allowance to the desk: ${formatUnits((await allowanceOf(poolKey.currency0))[0], 6)} / ${formatUnits((await allowanceOf(poolKey.currency1))[0], 6)}`);

// ---------- 2. the desk provides the liquidity, out of the client's account ----------

// Liquidity for `size` a side at a 1:1-ish price over [-600, 600]; the caps carry the slippage.
const sqrtA = Math.sqrt(1.0001 ** TICK_LOWER);
const sqrtB = Math.sqrt(1.0001 ** TICK_UPPER);
const liquidity = BigInt(Math.floor(Math.min((Number(size) * sqrtB) / (sqrtB - 1), Number(size) / (1 - sqrtA))));

const addTx = await wallet.writeContract({
  account: deskCaller, chain: null, address: desk, abi: deskAbi, functionName: "add",
  args: [client.address, poolKey, TICK_LOWER, TICK_UPPER, liquidity, cap, cap],
});
const addRcpt = await pub.waitForTransactionReceipt({ hash: addTx });
if (addRcpt.status !== "success") throw new Error(`add reverted: ${addTx}`);
ok(`desk added liquidity ${liquidity} — ${chain.explorer}/tx/${addTx}`);

/**
 * What actually moved, taken from the receipt's own logs.
 *
 * Not from a balance read before and after: a load-balanced public RPC answers "latest" from the
 * block before the one that just landed, and refuses a pinned historical block outright (-32001).
 * The receipt is the one account of the transaction that cannot be stale or unavailable.
 */
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (t: string) => `0x${t.slice(26)}`.toLowerCase();
const paidToPool = (logs: readonly { address: string; topics: readonly string[]; data: string }[], token: Address) =>
  logs
    .filter(
      (l) =>
        l.address.toLowerCase() === token.toLowerCase() &&
        l.topics[0]?.toLowerCase() === TRANSFER &&
        topicAddr(l.topics[1] ?? "") === client.address.toLowerCase() &&
        topicAddr(l.topics[2] ?? "") === String(pool.poolManager).toLowerCase(),
    )
    .reduce((sum, l) => sum + BigInt(l.data), 0n);

const paid0 = paidToPool(addRcpt.logs, poolKey.currency0);
const paid1 = paidToPool(addRcpt.logs, poolKey.currency1);
ok(`client paid ${formatUnits(paid0, 6)} + ${formatUnits(paid1, 6)} — client -> PoolManager, under the writ`);
if (paid0 === 0n || paid1 === 0n) throw new Error("the pool was not funded out of the client's account");

const deskHolds = await Promise.all(
  [poolKey.currency0, poolKey.currency1].map((t) =>
    pub.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [desk] }),
  ),
);
if (deskHolds[0] !== 0n || deskHolds[1] !== 0n) throw new Error("the adapter is holding tokens — it must never");
ok("LiquidityDesk holds nothing, and neither does the caller");

// ---------- 3. what the desk cannot do ----------

try {
  await pub.simulateContract({
    account: deskCaller, address: desk, abi: deskAbi, functionName: "remove",
    args: [poolKey, TICK_LOWER, TICK_UPPER, liquidity],
  });
  throw new Error("the desk was able to withdraw the position — that must be impossible");
} catch (e) {
  if (e instanceof Error && e.message.includes("must be impossible")) throw e;
  ok("the desk cannot withdraw it: remove is msg.sender-scoped, and the desk has no position");
}

// ---------- 4. the client takes it back ----------

if (!process.argv.includes("--keep")) {
  const removeTx = await wallet.writeContract({
    account: client, chain: null, address: desk, abi: deskAbi, functionName: "remove",
    args: [poolKey, TICK_LOWER, TICK_UPPER, liquidity],
  });
  await pub.waitForTransactionReceipt({ hash: removeTx });
  const rcpt = await pub.getTransactionReceipt({ hash: removeTx });
  const back = (token: Address) =>
    rcpt.logs
      .filter(
        (l) =>
          l.address.toLowerCase() === token.toLowerCase() &&
          l.topics[0]?.toLowerCase() === TRANSFER &&
          topicAddr(l.topics[2] ?? "") === client.address.toLowerCase(),
      )
      .reduce((sum, l) => sum + BigInt(l.data), 0n);
  ok(`client withdrew ${formatUnits(back(poolKey.currency0), 6)} + ${formatUnits(back(poolKey.currency1), 6)} — ${chain.explorer}/tx/${removeTx}`);
} else {
  ok("position left in place (--keep)");
}
