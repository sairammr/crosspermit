// The whole thing, once, on a live testnet: link → signature → allowance → LP → withdrawal.
//
// Three identities, deliberately distinct, because the point of the product is what each of them
// cannot do:
//
//   MANAGER  proves a wallet to the desk layer, opens a client link, and later sends the `add`
//            transaction. Never holds the client's tokens and cannot withdraw the position.
//   CLIENT   signs one writ naming the LiquidityDesk on both sides of the pair. Sends no
//            transaction until they take the position back.
//   RELAYER  pays gas for the writ. Its only privilege.
//
//   set -a && . ./.env && set +a && bun apps/web/scripts/lifecycle.ts [--keep] [--size 1.0]
//
// Reads DESK_URL (default the web origin, so the Next rewrite is exercised too), PRIVATE_KEY as the
// client and RELAYER_PRIVATE_KEY as the manager's transaction signer.
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

import { CHAINS } from "../src/config";
import { POOLS, amountsForLiquidity, decodeSlot0, liquidityForAmounts, poolManagerAbi, poolStateSlot, positionSlot } from "../src/pools";
import { approveEntry, crossPermitAbi, prepareIntent, toWire } from "@crosspermit/sdk";

const DESK = process.env.DESK_URL ?? "http://localhost:3000/api/desk";
const CHAIN_ID = 84532;
const SIZE = process.env.SIZE ?? arg("size") ?? "1.0";
const KEEP = process.argv.includes("--keep");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const need = (name: string): Hex => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set — source .env first`);
  return (v.startsWith("0x") ? v : `0x${v}`) as Hex;
};

const client = privateKeyToAccount(need("PRIVATE_KEY"));
const manager = privateKeyToAccount(need("RELAYER_PRIVATE_KEY"));

const chain = CHAINS.find((c) => c.id === CHAIN_ID)!;
const pool = POOLS.find((p) => p.chainId === CHAIN_ID)!;
const CROSS_PERMIT = "0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B" as Address;

const pub = createPublicClient({ transport: http(chain.rpc) });
const desk = createWalletClient({ account: manager, transport: http(chain.rpc), chain: { id: CHAIN_ID, name: chain.name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [chain.rpc] } } } });
const clientWallet = createWalletClient({ account: client, transport: http(chain.rpc), chain: desk.chain });

const liquidityDeskAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function add(address owner, PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity, uint128 max0, uint128 max1)",
  "function remove(PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity)",
  "function collect(PoolKey key, int24 tickLower, int24 tickUpper)",
]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

let step = 0;
const say = (what: string) => console.log(`\n${String(++step).padStart(2, "0")}  ${what}`);
const ok = (what: string, detail = "") => console.log(`    ok   ${what}${detail ? ` — ${detail}` : ""}`);
let failures = 0;
const check = (cond: boolean, what: string, detail = "") => {
  if (!cond) failures++;
  console.log(`    ${cond ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------- desk layer, as the manager

let cookie = "";
async function layer<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${DESK}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

console.log(`lifecycle on ${chain.name}`);
console.log(`  layer   ${DESK}`);
console.log(`  manager ${manager.address}`);
console.log(`  client  ${client.address}`);

say("manager proves a wallet to the desk layer");
{
  const anon = await layer("/clients");
  check(anon.status === 401, "the book refuses an unproven browser");
  const ch = await layer<{ nonce: string; message: string }>("/auth/nonce", { method: "POST", body: { address: manager.address } });
  const signature = await manager.signMessage({ message: ch.body.message });
  const v = await layer("/auth/verify", { method: "POST", body: { address: manager.address, nonce: ch.body.nonce, signature } });
  check(v.status === 200 && cookie.startsWith("desk_session="), "one signature opens a session", "no gas, no spender");
  const me = await layer<{ address: string }>("/auth/me");
  check(me.body.address === manager.address.toLowerCase(), "the layer recovered the manager's address");
}

say("manager registers the LiquidityDesk it deployed");
{
  const r = await layer<{ desk: string; error?: string; code?: string }>(`/desks/${CHAIN_ID}`, {
    method: "PUT",
    body: { desk: pool.liquidityDesk },
  });
  // A 409 here is the layer doing its job: someone else has claimed this deployment, which is exactly
  // the shared-desk problem. It is reported with the reason rather than as a bare failure.
  check(r.status === 200, "desk registered", r.status === 200 ? pool.liquidityDesk : `${r.body.code}: ${r.body.error}`);
}

say("manager opens a client link");
let token = "";
{
  const made = await layer<{ client: { token: string; status: string } }>("/clients", {
    method: "POST",
    body: { name: "Lifecycle client", mandate: "Provide liquidity on the USDC pair" },
  });
  token = made.body.client.token;
  check(made.status === 201 && made.body.client.status === "awaiting", "link opened, granting nothing", `/c/${token.slice(0, 10)}…`);
  const read = await layer<{ client: { name: string } }>(`/clients/${token}`);
  check(read.status === 200, "the client can read it with no session of their own");
}

// ---------------------------------------------------------------- client signs one writ

const [dec0, dec1, sym0, sym1] = await Promise.all([
  pub.readContract({ address: pool.key.currency0, abi: erc20, functionName: "decimals" }),
  pub.readContract({ address: pool.key.currency1, abi: erc20, functionName: "decimals" }),
  pub.readContract({ address: pool.key.currency0, abi: erc20, functionName: "symbol" }),
  pub.readContract({ address: pool.key.currency1, abi: erc20, functionName: "symbol" }),
]);

const slot0 = decodeSlot0(
  (await pub.readContract({ address: pool.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [poolStateSlot(pool.key)] })) as Hex,
);
const sqrtP = Number(slot0.sqrtPriceX96) / 2 ** 96;
const want0 = Number(parseUnits(SIZE, Number(dec0)));
const want1 = Number(parseUnits(SIZE, Number(dec1)));
const liquidity = BigInt(liquidityForAmounts(want0, want1, sqrtP, pool.tickLower, pool.tickUpper));
const quote = amountsForLiquidity(Number(liquidity), sqrtP, pool.tickLower, pool.tickUpper);
// The pool price moves between this quote and the block that executes it, so the caps carry headroom
// and the writ is granted over the caps, not the quote.
const max0 = BigInt(Math.ceil(quote.amount0 * 1.02));
const max1 = BigInt(Math.ceil(quote.amount1 * 1.02));

say("client signs ONE writ naming the desk on both sides");
let intentId = "";
{
  const now = Math.floor(Date.now() / 1000);
  const { intent, typedData } = prepareIntent({
    crossPermit: CROSS_PERMIT,
    owner: client.address,
    now,
    ttl: 3600,
    chains: [
      {
        chainId: CHAIN_ID,
        permits: [
          approveEntry(pool.key.currency0, pool.liquidityDesk, max0 * 4n, now + 24 * 3600),
          approveEntry(pool.key.currency1, pool.liquidityDesk, max1 * 4n, now + 24 * 3600),
        ],
      },
    ],
  });
  const signature = await client.signTypedData(typedData as never);
  const submitted = await layer<{ intentId: string; legs: { chainId: number; status: string; txHash: string | null }[] }>(
    "/intents?wait=1",
    { method: "POST", body: toWire({ ...intent, signature }) },
  );
  intentId = submitted.body.intentId;
  const leg = submitted.body.legs?.[0];
  check(submitted.status < 400 && leg?.status === "confirmed", "relayer paid gas and the permit landed", leg?.txHash ?? "");
  ok("the client sent no transaction");
}

say("the allowance is now on chain, and the layer binds the mandate");
{
  const [amount, expiration] = (await pub.readContract({
    address: CROSS_PERMIT,
    abi: crossPermitAbi,
    functionName: "allowance",
    args: [client.address, pool.key.currency0, pool.liquidityDesk],
  })) as [bigint, number, number];
  check(amount >= max0, `allowance[client][${sym0}][desk] = ${formatUnits(amount, Number(dec0))}`, `expires ${new Date(expiration * 1000).toISOString()}`);

  const bound = await layer(`/clients/${token}/link`, {
    method: "POST",
    body: { owner: client.address, intentId, capUnits: (max0 * 4n).toString(), ttlHours: 24, chainIds: [CHAIN_ID] },
  });
  check(bound.status === 200, "mandate bound by recovering the signer of that intent");

  const wrong = await layer(`/clients/${token}/link`, { method: "POST", body: { owner: manager.address, intentId } });
  check(wrong.status >= 400, "a different address cannot claim the same intent", String(wrong.status));
}

say("the manager can see it; another manager cannot");
{
  const book = await layer<{ clients: { token: string; owner: string | null }[] }>("/clients");
  check(book.body.clients.some((c) => c.token === token && c.owner?.toLowerCase() === client.address.toLowerCase()), "in the manager's book, owner bound");

  const scope = await layer<{ ok: boolean; rows: { kind: string; label: string }[] }>(`/clients/${token}/scope-check`);
  const mine = scope.body.rows?.filter((r) => r.kind === "mine").length ?? 0;
  check(mine >= 2, `scope check names ${mine} allowance(s) as this manager's own desk`);

  const saved = cookie;
  cookie = "";
  const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const ch = await layer<{ nonce: string; message: string }>("/auth/nonce", { method: "POST", body: { address: other.address } });
  await layer("/auth/verify", { method: "POST", body: { address: other.address, nonce: ch.body.nonce, signature: await other.signMessage({ message: ch.body.message }) } });
  const peek = await layer(`/clients/${token}`);
  const peekExposure = await layer(`/treasury/${client.address}`);
  check(peek.status === 403, "another manager holding the token is refused");
  check(peekExposure.status === 403, "and cannot read the client's exposure");
  cookie = saved;
}

// ---------------------------------------------------------------- the LP leg

/**
 * Every read here is pinned to a block, and the node is waited for before it is asked.
 *
 * A public RPC endpoint is a load balancer over several nodes, so a read issued the instant a receipt
 * arrives is routinely answered by a node that has not seen that block — which looks exactly like a
 * transaction that did nothing. The first run of this script "failed" four checks that way while the
 * transactions had in fact succeeded. Pinning the block turns that into a wait instead of a lie.
 */
async function atBlock(blockNumber: bigint) {
  for (let i = 0; i < 60; i++) {
    if ((await pub.getBlockNumber()) >= blockNumber) break;
    await Bun.sleep(500);
  }
  return blockNumber;
}

const balances = async (blockNumber?: bigint) =>
  (await Promise.all([
    pub.readContract({ address: pool.key.currency0, abi: erc20, functionName: "balanceOf", args: [client.address], blockNumber }),
    pub.readContract({ address: pool.key.currency1, abi: erc20, functionName: "balanceOf", args: [client.address], blockNumber }),
    pub.readContract({ address: pool.key.currency0, abi: erc20, functionName: "balanceOf", args: [pool.liquidityDesk], blockNumber }),
  ])) as [bigint, bigint, bigint];

const posSlot = positionSlot(pool.key, pool.liquidityDesk, pool.tickLower, pool.tickUpper, client.address);
const position = async (blockNumber?: bigint) =>
  BigInt(
    (await pub.readContract({
      address: pool.poolManager,
      abi: poolManagerAbi,
      functionName: "extsload",
      args: [posSlot],
      blockNumber,
    })) as Hex,
  );

say("manager sends add() — the only transaction the desk ever sends");
{
  const hash = await desk.writeContract({
    address: pool.liquidityDesk,
    abi: liquidityDeskAbi,
    functionName: "add",
    args: [client.address, pool.key, pool.tickLower, pool.tickUpper, liquidity, max0, max1],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  check(receipt.status === "success", "add() confirmed", `${chain.explorer}/tx/${hash}`);

  // Before and after, either side of the block that did it. Both pinned, so neither can be answered
  // by a node that is behind.
  await atBlock(receipt.blockNumber);
  const [b0, b1] = await balances(receipt.blockNumber - 1n);
  const before = await position(receipt.blockNumber - 1n);
  const [a0, a1, deskBal] = await balances(receipt.blockNumber);
  const after = await position(receipt.blockNumber);
  check(after - before === liquidity, `the client now holds ${liquidity} more liquidity`, `${before} → ${after}`);
  check(a0 < b0 && a1 < b1, `paid ${formatUnits(b0 - a0, Number(dec0))} ${sym0} + ${formatUnits(b1 - a1, Number(dec1))} ${sym1} straight to the PoolManager`);
  check(deskBal === 0n, "the desk contract holds no balance at any point");

  // Two Transfer logs on the token, both client -> PoolManager. The desk is in neither.
  const transfers = receipt.logs.filter((l) => l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  const toDesk = transfers.filter((l) => `0x${(l.topics[2] ?? "").slice(26)}`.toLowerCase() === pool.liquidityDesk.toLowerCase());
  check(toDesk.length === 0, `${transfers.length} token transfer(s), none of them to the desk`);
}

say("the manager cannot take it out — the asymmetry the product rests on");
{
  const failed = await pub
    .simulateContract({
      account: manager,
      address: pool.liquidityDesk,
      abi: liquidityDeskAbi,
      functionName: "remove",
      args: [pool.key, pool.tickLower, pool.tickUpper, liquidity],
    })
    .then(() => null)
    .catch((e) => e as Error);
  check(failed !== null, "desk's own remove() reverts", failed ? failed.message.split("\n")[0]!.slice(0, 72) : "IT SUCCEEDED");
}

if (KEEP) {
  console.log("\n--keep: the position is left in place.");
} else {
  say("client takes it back, and sweeps what it earned");
  {
    // Exactly what this run added, not everything the client holds: the account may carry positions
    // from earlier runs, and a test that closes those is a test that destroys evidence.
    const rm = await clientWallet.writeContract({
      address: pool.liquidityDesk,
      abi: liquidityDeskAbi,
      functionName: "remove",
      args: [pool.key, pool.tickLower, pool.tickUpper, liquidity],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash: rm });
    check(receipt.status === "success", "client's remove() confirmed", `${chain.explorer}/tx/${rm}`);
    await atBlock(receipt.blockNumber);
    const [b0, b1] = await balances(receipt.blockNumber - 1n);
    const [a0, a1] = await balances(receipt.blockNumber);
    const before = await position(receipt.blockNumber - 1n);
    const after = await position(receipt.blockNumber);
    check(a0 > b0 && a1 > b1, `returned ${formatUnits(a0 - b0, Number(dec0))} ${sym0} + ${formatUnits(a1 - b1, Number(dec1))} ${sym1}`);
    check(before - after === liquidity, "the position this run opened is closed", `${before} → ${after}`);
  }
}

console.log(`\n${failures === 0 ? "FULL LIFECYCLE PASSED" : `${failures} step(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
