// The complete CrossPermit lifecycle, against three live testnets.
//
// Eight stages, each one a real state transition of a real deployment. Every stage that grants or
// revokes authority does it with ONE signature covering all three chains:
//
//   setup      chain ids, code, test token, mint, one-time ERC20 approval, a real Uniswap v4 pool
//   authorize  one signature -> allowances on 3 chains, plus an immediate signed transfer on one
//   spend      the router pulls (PERMIT2_TRANSFER_FROM) and swaps (V4_SWAP) out of that allowance
//   decrease   one signature -> DECREASE every spender's remainder to zero on all 3 chains
//   lock       one signature -> LOCK every spender on all 3 chains; prove the router cannot spend
//   unlock     one signature -> UNLOCK and re-grant; prove it can spend again
//   cancel     sign a permit, then retract its salt on all 3 chains before submitting it, and
//              prove the retracted permit can never be redeemed
//   report     per-chain table with explorer links
//
//   script/deploy.sh all && set -a && . ./.env && set +a && bun run packages/sdk/scripts/lifecycle.ts
//
// Flags: --only stage,stage   run just these
//        --skip stage,stage   run everything else
//        --via-relayer URL    submit permits through a running relayer instead of directly
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

import {
  type ChainCtx,
  type ChainPermits,
  type Entry,
  MODE,
  approveEntry,
  buildUnbalancedTree,
  crossPermitAbi,
  erc20Abi,
  leafOfChecked,
  lockEntry,
  processProof,
  randomSalt,
  signRoot,
  submitPermit,
  tokenKey,
  transferEntry,
} from "../src/crosspermit.js";
import { type Invalidation, cancelAbi, invalidationLeafChecked, signCancelRoot, submitInvalidation } from "../src/cancel.js";
import { type PoolKey, encodePermit2TransferFrom, encodeV4ExactInSingleSwap, poolKeyFor } from "../src/router.js";
import { toWire } from "../src/intent.js";

// ---------- configuration ----------

const here = (p: string) => new URL(`../../../${p}`, import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(here(p), "utf8"));

/**
 * Cheapest chain first, dearest (L1) last — the tree is left-leaning, so the last leaf carries the
 * 1-node proof and therefore the cheapest calldata on the chain where calldata costs most.
 * `poolManager` is v4PoolManager from universal-router's own script/deployParameters/Deploy*.s.sol.
 */
const CHAINS = [
  { key: "BaseSepolia", name: "Base Sepolia", chainId: 84532, rpc: "RPC_BASE_SEPOLIA", explorer: "https://sepolia.basescan.org", pull: 3_000000n, poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408" as Address },
  { key: "OPSepolia", name: "Optimism Sepolia", chainId: 11155420, rpc: "RPC_OP_SEPOLIA", explorer: "https://sepolia-optimism.etherscan.io", pull: 4_000000n, poolManager: "0xf7F5aB3DcA35e17dE187b459159BC643853B3c67" as Address },
  { key: "Sepolia", name: "Ethereum Sepolia", chainId: 11155111, rpc: "RPC_ETH_SEPOLIA", explorer: "https://sepolia.etherscan.io", pull: 5_000000n, poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543" as Address },
] as const;

const TRANSFER_ON = 84532; // one chain also carries an immediate signed transfer, same signature
const TRANSFER_AMOUNT = 1_000000n;
const RECIPIENT = "0x000000000000000000000000000000000000bEEF" as Address;
const MINT = 500_000000n;
const RELOCK_PULL = 1_000000n; // the small pull used to prove lock, then unlock
/**
 * Deliberate surplus in the authorised amount, over and above what `spend` consumes.
 * Without it `spend` consumes the allowance exactly, `decrease` would be asserting 0 -> 0, and a
 * broken DECREASE would pass. An assertion that cannot fail is not an assertion.
 */
const SURPLUS = 2_000000n;

/** 1:1 price, wide range, deep liquidity relative to the trade, so minOut only absorbs the 0.3% fee. */
const V4 = {
  fee: 3000,
  tickSpacing: 60,
  tickLower: -600,
  tickUpper: 600,
  sqrtPriceX96: 79228162514264337593543950336n, // 2**96
  liquidity: 1_000_000_000_000n,
  seedFunding: 100_000_000_000_000n,
  swapIn: 1_000000n,
  minOut: 990000n,
} as const;

const STAGES = ["setup", "authorize", "spend", "decrease", "lock", "unlock", "cancel", "report"] as const;
type Stage = (typeof STAGES)[number];

const MOCK_USDC = readJson("contracts/out/MockUSDC.sol/MockUSDC.json");
const V4_SEEDER = readJson("contracts/out/V4PoolSeeder.sol/V4PoolSeeder.json");
const CROSS_PERMIT = readJson("deployments/crosspermit.json").address as Address;

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (run: set -a && . ./.env && set +a)`);
  return v;
};

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const only = arg("only")?.split(",");
const skip = arg("skip")?.split(",") ?? [];
const relayerUrl = arg("via-relayer");
const wanted = (s: Stage) => (only ? only.includes(s) : true) && !skip.includes(s);

// ---------- reporting ----------

let failures = 0;
const log: { stage: Stage; chain: string; what: string; tx?: Hex; url?: string }[] = [];

const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
  return ok;
};

const record = (stage: Stage, c: Chain, what: string, tx?: Hex) => {
  log.push({ stage, chain: c.name, what, tx, url: tx ? `${c.explorer}/tx/${tx}` : undefined });
  if (tx) console.log(`       ${c.explorer}/tx/${tx}`);
};

// ---------- RPC resilience ----------
//
// Public RPCs load-balance across nodes, so a read taken right after a broadcast can land on a node
// that has not seen the block yet: code reads back empty, getTransactionCount comes back stale.
// Everything below therefore polls for visible state, and tracks nonces locally — this process is
// the only sender for this account, so a local counter beats asking.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hasCode(client: PublicClient, address: Address): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if ((await client.getCode({ address }).catch(() => undefined)) !== undefined) return true;
    await sleep(2000);
  }
  return false;
}

/**
 * Re-read until the expected value shows up. Returns whatever it last saw rather than throwing, so
 * the caller's own `check` decides pass or fail — a genuinely wrong value should be reported as a
 * failed check, not disguised as a timeout.
 */
async function settle<T>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 20): Promise<T> {
  let last = await read();
  for (let i = 1; i < tries && !ok(last); i++) {
    await sleep(2000);
    last = await read();
  }
  return last;
}

// ---------- monotonic stage clock ----------
//
// CrossPermit orders allowance updates by the signed `timestamp`: an increase only moves the
// expiration when `timestamp > allowed.timestamp`, and an UNLOCK is only honoured when it is
// strictly newer than the LOCK it undoes. So each stage needs a timestamp strictly greater than the
// last — while still never exceeding `block.timestamp` on any chain, or the contract reverts with
// InvalidTimestamp. Start 120s back to absorb chain clock skew, then step forward monotonically.

let lastStamp = 0;
const stageStamp = (): number => {
  const floor = Math.floor(Date.now() / 1000) - 120;
  lastStamp = Math.max(lastStamp + 1, floor);
  return lastStamp;
};

// ---------- chains ----------

type Chain = Awaited<ReturnType<typeof openChain>>;

async function openChain(c: (typeof CHAINS)[number], owner: Address) {
  const transport = http(env(c.rpc));
  const client = createPublicClient({ transport });
  const wallet = createWalletClient({ transport });
  const router = readJson(`deployments/router-${c.key}.json`).universalRouter as Address;
  // The LiquidityDesk is the other spender a real mandate names, so every stage that retracts
  // authority has to name it too. Optional because `deploy-liquidity.ts` may not have run yet;
  // absent, this script simply has one spender to revoke instead of two.
  const deskFile = `deployments/liquidity-${c.key}.json`;
  const desk = existsSync(here(deskFile)) ? (readJson(deskFile).address as Address) : null;
  // sepolia.unichain.org answers `pending` with 0 while `latest` is correct, so take the max.
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address: owner, blockTag: "latest" }),
    client.getTransactionCount({ address: owner, blockTag: "pending" }),
  ]);
  return { ...c, client, wallet, router, desk, nextNonce: Math.max(latest, pending) };
}

/**
 * Every spender a revocation has to cover on this chain.
 *
 * A LOCK is per (owner, token, SPENDER), so retracting "the mandate" means one entry per spender the
 * mandate ever named. Locking the router alone leaves the desk holding a live allowance that the
 * report below would not mention — the exact shape of a revocation that looks complete and is not.
 */
const spendersOf = (c: Chain): Address[] => (c.desk ? [c.router, c.desk] : [c.router]);

const ctxOf = (c: Chain): ChainCtx => ({
  chainId: c.chainId,
  client: c.client,
  wallet: c.wallet,
  crossPermit: CROSS_PERMIT,
});

/** Wait for a transaction and refuse to continue on a revert. */
async function sent(c: Chain, hash: Hex, what: string): Promise<Hex> {
  const r = await c.client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted on ${c.name}: ${hash}`);
  return hash;
}

const allowanceOf = async (c: Chain, token: Address, spender: Address) => {
  const [amount, expiration, timestamp] = await c.client.readContract({
    address: CROSS_PERMIT,
    abi: crossPermitAbi,
    functionName: "allowance",
    args: [OWNER.address, token, spender],
  });
  return { amount, expiration, timestamp };
};

const balanceOf = (c: Chain, token: Address, who: Address) =>
  c.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

// ---------- one signature, N chains ----------

/**
 * The core move, used by five of the eight stages: build one bundle per chain, fold the leaves into
 * one root, sign it ONCE, then submit each chain's bundle plus its proof.
 *
 * Leaves are computed locally and only then confirmed against each live deployment. A leaf that came
 * back FROM an RPC would let a hostile endpoint choose what the owner signs, with the wallet showing
 * nothing but an opaque merkleRoot.
 */
async function oneSignature(
  stage: Stage,
  chains: Chain[],
  build: (c: Chain, i: number) => Entry[],
  opts: { label: string; salt?: Hex; submit?: boolean } = { label: "" },
): Promise<{ salt: Hex; root: Hex; signature: Hex; bundles: ChainPermits[]; proofs: Hex[][]; timestamp: number; deadline: number }> {
  const timestamp = stageStamp();
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const bundles: ChainPermits[] = chains.map((c, i) => ({ chainId: BigInt(c.chainId), permits: build(c, i) }));
  const leaves = await Promise.all(bundles.map((b, i) => leafOfChecked(ctxOf(chains[i]!), b)));
  const { root, proofs } = buildUnbalancedTree(leaves);

  check(
    leaves.every((l, i) => processProof(l, proofs[i]!) === root),
    `${opts.label}: every proof rebuilds the signed root`,
  );
  check(proofs[proofs.length - 1]!.length === 1, `${opts.label}: the dearest chain gets the 1-node proof`);

  const salt = opts.salt ?? randomSalt();
  const signature = await signRoot(chains[0]!.wallet, OWNER, CROSS_PERMIT, {
    owner: OWNER.address,
    salt,
    deadline,
    timestamp,
    merkleRoot: root,
  });
  console.log(`       root      ${root}`);
  console.log(`       signature ${signature}`);

  if (opts.submit !== false) {
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      const tx = relayerUrl
        ? await submitViaRelayer(chains, { salt, deadline, timestamp, root, signature, bundles, proofs }, i)
        : await submitPermit(ctxOf(c), OWNER, {
            owner: OWNER.address,
            salt,
            deadline,
            timestamp,
            cp: bundles[i]!,
            proof: proofs[i]!,
            signature,
            nonce: c.nextNonce++,
          });
      record(stage, c, `${opts.label} applied`, tx);
    }
  }

  return { salt, root, signature, bundles, proofs, timestamp, deadline };
}

/**
 * Hand the whole intent to a running relayer and let it fan out. One POST covers every chain, so
 * this is the one-click path; the direct path above stays as the fallback that keeps the relayer
 * non-custodial — anything the relayer can do, the client can still do alone.
 */
const relayed = new Map<string, Record<number, Hex>>();

async function submitViaRelayer(
  chains: Chain[],
  a: { salt: Hex; deadline: number; timestamp: number; root: Hex; signature: Hex; bundles: ChainPermits[]; proofs: Hex[][] },
  legIndex: number,
): Promise<Hex> {
  const key = `${a.salt}:${a.root}`;
  if (!relayed.has(key)) {
    const intent = {
      crossPermit: CROSS_PERMIT,
      owner: OWNER.address,
      salt: a.salt,
      deadline: a.deadline,
      timestamp: a.timestamp,
      root: a.root,
      signature: a.signature,
      legs: chains.map((c, i) => ({ chainId: c.chainId, bundle: a.bundles[i]!, proof: a.proofs[i]! })),
    };
    // The relayer may require an API key. Sent when one is configured, omitted when it is not, so
    // the same script drives an open relayer and a closed one.
    // Named apiKey, not key: `key` is already the (salt, root) cache key in the enclosing scope, and
    // shadowing it stored the result under the wrong one.
    const apiKey = process.env.RELAYER_API_KEY?.trim();
    const res = await fetch(`${relayerUrl}/v1/intents?wait=1`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(toWire(intent)),
    });
    const body = (await res.json()) as { legs?: { chainId: number; txHash?: Hex; error?: string }[]; error?: string };
    if (!res.ok) throw new Error(`relayer rejected the intent: ${body.error ?? res.status}`);
    const byChain: Record<number, Hex> = {};
    for (const leg of body.legs ?? []) {
      if (!leg.txHash) throw new Error(`relayer failed chain ${leg.chainId}: ${leg.error ?? "no tx"}`);
      byChain[leg.chainId] = leg.txHash;
    }
    relayed.set(key, byChain);
  }
  const tx = relayed.get(key)![chains[legIndex]!.chainId];
  if (!tx) throw new Error(`relayer returned no tx for chain ${chains[legIndex]!.chainId}`);
  return tx;
}

// ---------- fixtures ----------

/** Deploy a fixture contract per chain once, then reuse it across runs. */
async function deployCached(
  c: Chain,
  path: string,
  artifact: { abi: unknown[]; bytecode: { object: Hex } },
  args: readonly unknown[] = [],
): Promise<Address> {
  if (existsSync(here(path))) {
    const cached = readJson(path).address as Address;
    if ((await c.client.getCode({ address: cached })) !== undefined) return cached;
  }
  const hash = await c.wallet.deployContract({
    account: OWNER,
    chain: null,
    nonce: c.nextNonce++,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args,
  });
  const { contractAddress } = await c.client.waitForTransactionReceipt({ hash });
  if (!contractAddress) throw new Error(`deployment produced no address (${path})`);
  if (!(await hasCode(c.client, contractAddress))) throw new Error(`no code at ${contractAddress} (${path})`);
  writeFileSync(here(path), `${JSON.stringify({ chain: c.key, address: contractAddress }, null, 2)}\n`);
  return contractAddress;
}

/**
 * A v4 pool holding `tokenIn` and a second test token, created and funded once per chain.
 *
 * Liquidity goes in through `V4PoolSeeder`, which calls `PoolManager.unlock` directly rather than
 * going through `PositionManager`: the position NFT and its own Permit2 approvals have nothing to do
 * with what CrossPermit is proving, and leaving them out removes four transactions and an encoding
 * to get wrong.
 */
async function v4Pool(c: Chain, tokenIn: Address): Promise<{ poolKey: PoolKey; tokenOut: Address }> {
  const tokenOut = await deployCached(c, `deployments/token2-${c.key}.json`, MOCK_USDC);
  const poolKey = poolKeyFor(tokenIn, tokenOut, V4.fee, V4.tickSpacing);

  // A pool is its whole PoolKey on one PoolManager — change the fee or the tick spacing and this is
  // a different, uninitialised pool. Compare every field rather than a hand-maintained subset: a
  // record matching on currencies alone would send the swap at a pool that was never seeded.
  const identity = { poolManager: c.poolManager, ...poolKey };
  const path = `deployments/v4pool-${c.key}.json`;
  if (existsSync(here(path))) {
    const cached = readJson(path);
    if (Object.entries(identity).every(([k, v]) => cached[k] === v)) {
      console.log(`  ok   ${c.name}: v4 pool already seeded`);
      return { poolKey, tokenOut };
    }
  }

  const seeder = await deployCached(c, `deployments/v4seeder-${c.key}.json`, V4_SEEDER, [c.poolManager]);
  for (const token of [tokenIn, tokenOut]) {
    await sent(
      c,
      await c.wallet.writeContract({
        account: OWNER, chain: null, nonce: c.nextNonce++, address: token,
        abi: mintAbi, functionName: "mint", args: [seeder, V4.seedFunding],
      }),
      "seeder funding",
    );
    // `seed` spends these and viem estimates gas first. An estimate served by a node that has not
    // seen the mint yet fails as ERC20InsufficientBalance, so wait for the balance to be visible.
    const funded = await settle(() => balanceOf(c, token, seeder), (b) => b >= V4.seedFunding);
    if (funded < V4.seedFunding) throw new Error(`${c.name}: seeder holds ${funded}, need ${V4.seedFunding}`);
  }
  const hash = await c.wallet.writeContract({
    account: OWNER, chain: null, nonce: c.nextNonce++, address: seeder,
    abi: V4_SEEDER.abi, functionName: "seed",
    args: [poolKey, V4.sqrtPriceX96, V4.tickLower, V4.tickUpper, V4.liquidity],
  });
  await sent(c, hash, "pool seed");
  writeFileSync(
    here(path),
    `${JSON.stringify({ chain: c.key, ...identity, seeder, liquidity: String(V4.liquidity), tx: hash }, null, 2)}\n`,
  );
  console.log(`  ok   ${c.name}: v4 pool seeded, ${c.explorer}/tx/${hash}`);
  return { poolKey, tokenOut };
}

// ---------- the run ----------

const OWNER: PrivateKeyAccount = privateKeyToAccount(env("PRIVATE_KEY") as Hex);

async function main() {
  console.log(`owner        ${OWNER.address}`);
  console.log(`crossPermit  ${CROSS_PERMIT}`);
  console.log(`submission   ${relayerUrl ? `relayer at ${relayerUrl}` : "direct from this process"}`);
  console.log(`stages       ${STAGES.filter(wanted).join(" -> ")}\n`);

  const chains: Chain[] = [];
  for (const c of CHAINS) chains.push(await openChain(c, OWNER.address));

  const tokens: Address[] = [];
  const pools: { poolKey: PoolKey; tokenOut: Address }[] = [];

  // ---- setup ----
  if (wanted("setup")) {
    console.log("--- setup ---");
    for (const c of chains) {
      const live = await c.client.getChainId();
      check(live === c.chainId, `${c.name}: RPC serves chainId ${live}`);
      check(await hasCode(c.client, CROSS_PERMIT), `${c.name}: CrossPermit code present at ${CROSS_PERMIT}`);
      check(await hasCode(c.client, c.router), `${c.name}: router code present at ${c.router}`);
    }
    if (failures) throw new Error("setup checks failed — refusing to spend gas");

    for (const c of chains) {
      const token = await deployCached(c, `deployments/token-${c.key}.json`, MOCK_USDC);
      tokens.push(token);
      if ((await balanceOf(c, token, OWNER.address)) < MINT) {
        await sent(c, await c.wallet.writeContract({
          account: OWNER, chain: null, nonce: c.nextNonce++, address: token,
          abi: mintAbi, functionName: "mint", args: [OWNER.address, MINT],
        }), "mint");
      }
      // One-time infinite ERC20 approval to CrossPermit, exactly like Permit2. Every later stage
      // moves value through signatures alone; this is the last on-chain approval the owner makes.
      await sent(c, await c.wallet.writeContract({
        account: OWNER, chain: null, nonce: c.nextNonce++, address: token,
        abi: erc20Abi, functionName: "approve", args: [CROSS_PERMIT, 2n ** 256n - 1n],
      }), "approve");
      console.log(`  ok   ${c.name}: token ${token}, funded and approved to CrossPermit`);
      pools.push(await v4Pool(c, token));
    }
  } else {
    for (const c of chains) {
      tokens.push(readJson(`deployments/token-${c.key}.json`).address as Address);
      const tokenOut = readJson(`deployments/token2-${c.key}.json`).address as Address;
      pools.push({ tokenOut, poolKey: poolKeyFor(tokens[tokens.length - 1]!, tokenOut, V4.fee, V4.tickSpacing) });
    }
  }

  // ---- authorize: one signature, three chains ----
  const granted = chains.map((c) => c.pull + V4.swapIn + SURPLUS);
  const before: { allowance: bigint; recipient: bigint }[] = [];

  if (wanted("authorize")) {
    console.log("\n--- authorize: ONE signature over three chains ---");
    for (let i = 0; i < chains.length; i++) {
      before.push({
        allowance: (await allowanceOf(chains[i]!, tokens[i]!, chains[i]!.router)).amount,
        recipient: await balanceOf(chains[i]!, tokens[i]!, RECIPIENT),
      });
    }

    const expiry = Math.floor(Date.now() / 1000) + 86_400;
    await oneSignature("authorize", chains, (c, i) => [
      // One allowance covers both spends the router makes in the next stage.
      approveEntry(tokens[i]!, c.router, granted[i]!, expiry),
      ...(c.chainId === TRANSFER_ON ? [transferEntry(tokens[i]!, RECIPIENT, TRANSFER_AMOUNT)] : []),
    ], { label: "authorize" });

    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      // Deltas, not absolutes: increase mode accumulates, and reruns reuse the same recipient, so a
      // rerun must still measure exactly what this run did.
      const after = await settle(
        () => allowanceOf(c, tokens[i]!, c.router).then((a) => a.amount),
        (a) => a - before[i]!.allowance === granted[i]!,
      );
      check(after - before[i]!.allowance === granted[i]!, `${c.name}: one signature granted ${granted[i]} to the router`);
      if (c.chainId === TRANSFER_ON) {
        const got = await settle(() => balanceOf(c, tokens[i]!, RECIPIENT), (b) => b - before[i]!.recipient >= TRANSFER_AMOUNT);
        check(got - before[i]!.recipient >= TRANSFER_AMOUNT, `${c.name}: the same signature also moved ${TRANSFER_AMOUNT} immediately`);
      }
    }
  }

  // ---- spend: the router pulls, then swaps, out of that one allowance ----
  if (wanted("spend")) {
    console.log("\n--- spend: the real Uniswap router settles out of the allowance ---");
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      const token = tokens[i]!;
      const { poolKey, tokenOut } = pools[i]!;
      console.log(`  ${c.name}`);

      const recipientBefore = await balanceOf(c, token, RECIPIENT);
      const allowBefore = (await allowanceOf(c, token, c.router)).amount;

      // PERMIT2_TRANSFER_FROM goes straight through the router's PERMIT2 immutable, which has no
      // getter: making the router spend is the only way to read what it was deployed with.
      const pull = await sent(c, await c.wallet.sendTransaction({
        account: OWNER, chain: null, nonce: c.nextNonce++, to: c.router,
        data: encodePermit2TransferFrom({
          token, recipient: RECIPIENT, amount: c.pull, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
        }),
      }), "router pull");
      record("spend", c, `router pulled ${c.pull} through CrossPermit`, pull);
      const got = await settle(() => balanceOf(c, token, RECIPIENT), (b) => b - recipientBefore === c.pull);
      check(got - recipientBefore === c.pull, `${c.name}: recipient received ${got - recipientBefore} from the router pull`);

      // V4_SWAP is the path a dApp actually uses: the router hands the swap to V4SwapRouter, whose
      // SETTLE_ALL pays the PoolManager via payOrPermit2Transfer -> PERMIT2.transferFrom. A swap
      // that settles therefore proves the substitution on the real payment path.
      const [inBefore, outBefore] = await Promise.all([balanceOf(c, token, OWNER.address), balanceOf(c, tokenOut, OWNER.address)]);
      const swap = await sent(c, await c.wallet.sendTransaction({
        account: OWNER, chain: null, nonce: c.nextNonce++, to: c.router,
        data: encodeV4ExactInSingleSwap({
          poolKey,
          zeroForOne: token === poolKey.currency0,
          amountIn: V4.swapIn,
          minOut: V4.minOut,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
        }),
      }), "v4 swap");
      record("spend", c, `real Uniswap v4 swap settled from the allowance`, swap);

      const outAfter = await settle(() => balanceOf(c, tokenOut, OWNER.address), (b) => b - outBefore >= V4.minOut);
      check(outAfter - outBefore >= V4.minOut, `${c.name}: v4 delivered ${outAfter - outBefore} (min ${V4.minOut})`);
      const inAfter = await settle(() => balanceOf(c, token, OWNER.address), (b) => inBefore - b === V4.swapIn);
      check(inBefore - inAfter === V4.swapIn, `${c.name}: the pool was paid ${inBefore - inAfter} out of the allowance`);

      const left = await settle(() => allowanceOf(c, token, c.router).then((a) => a.amount), (a) => a === allowBefore - c.pull - V4.swapIn);
      check(left === allowBefore - c.pull - V4.swapIn, `${c.name}: allowance consumed exactly, not bypassed (${left} left)`);

      // The router holds no plain ERC20 approval, so the input can only have come through
      // CrossPermit. Without this the two checks above would also pass on a direct approval.
      const direct = await c.client.readContract({
        address: token, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]),
        functionName: "allowance", args: [OWNER.address, c.router],
      });
      check(direct === 0n, `${c.name}: the router has no direct ERC20 approval (${direct}), so it spent via CrossPermit`);
    }
  }

  // ---- decrease: one signature retires the remainder on every chain ----
  if (wanted("decrease")) {
    console.log("\n--- decrease: ONE signature retires the leftover allowance everywhere ---");
    // Per spender, not just the router: a decrease that retires one spender's remainder and leaves
    // another's is the same hole as a partial lock.
    const remaining = await Promise.all(
      chains.map((c, i) => Promise.all(spendersOf(c).map((s) => allowanceOf(c, tokens[i]!, s).then((a) => a.amount)))),
    );
    for (let i = 0; i < chains.length; i++) {
      const left = remaining[i]![0]!;
      check(left > 0n, `${chains[i]!.name}: ${left} left to retire, so the decrease below is a real test`);
    }

    await oneSignature("decrease", chains, (c, i) =>
      // Mode 1 is DECREASE, and amountDelta is the amount to subtract. Pass each spender's exact
      // remainder so the assertion below is "reached zero", not "went down a bit".
      spendersOf(c).map((s, j) => ({
        modeOrExpiration: MODE.DECREASE,
        tokenKey: tokenKey(tokens[i]!),
        account: s,
        amountDelta: remaining[i]![j]!,
      })), { label: "decrease" });

    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      for (const [j, s] of spendersOf(c).entries()) {
        const left = await settle(() => allowanceOf(c, tokens[i]!, s).then((a) => a.amount), (a) => a === 0n);
        check(left === 0n, `${c.name}: ${s} allowance decreased from ${remaining[i]![j]} to ${left}`);
      }
    }
  }

  // ---- lock: the cross-chain kill switch ----
  if (wanted("lock")) {
    console.log("\n--- lock: ONE signature disables every spender on every chain ---");
    await oneSignature("lock", chains, (c, i) => spendersOf(c).map((s) => lockEntry(tokens[i]!, s)), { label: "lock" });

    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      for (const s of spendersOf(c)) {
        const x = await settle(() => allowanceOf(c, tokens[i]!, s), (v) => v.expiration === 2);
        check(x.expiration === 2, `${c.name}: ${s} is LOCKED (expiration sentinel ${x.expiration}, amount ${x.amount})`);
      }

      // A lock that does not actually stop a spend is decoration, so prove the spend fails. Simulate
      // rather than broadcast: the revert is the assertion, and there is no reason to pay for it.
      const blocked = await c.client
        .call({
          account: OWNER.address,
          to: c.router,
          data: encodePermit2TransferFrom({
            token: tokens[i]!, recipient: RECIPIENT, amount: RELOCK_PULL,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          }),
        })
        .then(() => false)
        .catch(() => true);
      check(blocked, `${c.name}: the router can no longer pull while locked`);
    }
  }

  // ---- unlock: and prove spending resumes ----
  if (wanted("unlock")) {
    console.log("\n--- unlock: ONE signature restores every spender on every chain ---");
    const expiry = Math.floor(Date.now() / 1000) + 86_400;

    // Order matters inside a bundle: entries are processed in sequence against live storage, so the
    // UNLOCK clears the lock sentinel and the increase in the same bundle then passes lock
    // validation. An increase alone would revert with AllowanceLocked.
    await oneSignature("unlock", chains, (c, i) => [
      // Every spender the lock stage covered, or the desk stays locked for good once this script
      // has run against a deployment.
      ...spendersOf(c).map((s) => ({ modeOrExpiration: MODE.UNLOCK, tokenKey: tokenKey(tokens[i]!), account: s, amountDelta: 0n })),
      // Only the router is re-granted: the pull below is the proof that spending resumes, and
      // handing the desk an allowance nothing in this script spends would assert nothing.
      approveEntry(tokens[i]!, c.router, RELOCK_PULL, expiry),
    ], { label: "unlock + re-grant" });

    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      for (const s of spendersOf(c)) {
        const x = await settle(() => allowanceOf(c, tokens[i]!, s), (v) => v.expiration !== 2);
        check(x.expiration !== 2, `${c.name}: ${s} lock cleared (expiration ${x.expiration})`);
      }
      const a = await settle(() => allowanceOf(c, tokens[i]!, c.router), (x) => x.expiration !== 2 && x.amount >= RELOCK_PULL);
      check(a.amount >= RELOCK_PULL, `${c.name}: re-granted ${a.amount} in the same signature`);

      const recipientBefore = await balanceOf(c, tokens[i]!, RECIPIENT);
      const tx = await sent(c, await c.wallet.sendTransaction({
        account: OWNER, chain: null, nonce: c.nextNonce++, to: c.router,
        data: encodePermit2TransferFrom({
          token: tokens[i]!, recipient: RECIPIENT, amount: RELOCK_PULL,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
        }),
      }), "post-unlock pull");
      record("unlock", c, "router spends again after unlock", tx);
      const got = await settle(() => balanceOf(c, tokens[i]!, RECIPIENT), (b) => b - recipientBefore === RELOCK_PULL);
      check(got - recipientBefore === RELOCK_PULL, `${c.name}: the router spends again after unlock`);
    }
  }

  // ---- cancel: retract a signed permit before it is ever submitted ----
  if (wanted("cancel")) {
    console.log("\n--- cancel: sign a permit, then retract its salt on every chain ---");
    const expiry = Math.floor(Date.now() / 1000) + 86_400;

    // 1. Sign a real multichain permit. Do NOT submit it — this is the intent being retracted.
    const doomed = await oneSignature("cancel", chains, (c, i) => [
      approveEntry(tokens[i]!, c.router, 42_000000n, expiry),
    ], { label: "permit to be retracted", submit: false });
    console.log(`       salt      ${doomed.salt}  (signed, never submitted)`);

    // 2. One signature burns that salt on every chain. Different signed struct, same merkle trick.
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const invs: Invalidation[] = chains.map((c) => ({ chainId: BigInt(c.chainId), salts: [doomed.salt] }));
    const leaves = await Promise.all(invs.map((inv, i) => invalidationLeafChecked(ctxOf(chains[i]!), inv)));
    const { root, proofs } = buildUnbalancedTree(leaves);
    check(leaves.every((l, i) => processProof(l, proofs[i]!) === root), "cancel: every proof rebuilds the cancel root");

    const cancelSig = await signCancelRoot(chains[0]!.wallet, OWNER, CROSS_PERMIT, {
      owner: OWNER.address, deadline, merkleRoot: root,
    });
    console.log(`       cancelRoot ${root}`);

    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      const tx = await submitInvalidation(ctxOf(c), OWNER, {
        owner: OWNER.address, deadline, inv: invs[i]!, proof: proofs[i]!, signature: cancelSig, nonce: c.nextNonce++,
      });
      record("cancel", c, "salt retracted", tx);

      const used = await settle(
        () => c.client.readContract({ address: CROSS_PERMIT, abi: cancelAbi, functionName: "isNonceUsed", args: [OWNER.address, doomed.salt] }),
        (u) => u === true,
      );
      check(used === true, `${c.name}: salt is burned`);

      // 3. The retracted permit must now be unredeemable. Simulate the submission and require it to
      // revert — this is the check that makes cancellation meaningful rather than cosmetic.
      const dead = await c.client
        .simulateContract({
          account: OWNER.address,
          address: CROSS_PERMIT,
          abi: crossPermitAbi,
          functionName: "permit",
          args: [OWNER.address, doomed.salt, doomed.deadline, doomed.timestamp, doomed.bundles[i]!, doomed.proofs[i]!, doomed.signature],
        })
        .then(() => false)
        .catch(() => true);
      check(dead, `${c.name}: the retracted permit can never be redeemed`);
    }
  }

  // ---- report ----
  if (wanted("report")) {
    console.log("\n--- report ---");
    for (const stage of STAGES) {
      const rows = log.filter((r) => r.stage === stage);
      if (rows.length === 0) continue;
      console.log(`\n${stage}`);
      for (const r of rows) console.log(`  ${r.chain.padEnd(18)} ${r.what}${r.url ? `\n    ${r.url}` : ""}`);
    }
    console.log("\nfinal allowance state (owner -> router, per chain)");
    for (let i = 0; i < chains.length; i++) {
      const a = await allowanceOf(chains[i]!, tokens[i]!, chains[i]!.router);
      console.log(`  ${chains[i]!.name.padEnd(18)} amount=${a.amount} expiration=${a.expiration} timestamp=${a.timestamp}`);
    }
  }

  console.log(failures === 0 ? "\nLIFECYCLE OK" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e);
  process.exit(1);
});
