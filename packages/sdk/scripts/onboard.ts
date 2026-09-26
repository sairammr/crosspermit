#!/usr/bin/env bun
//
// The desk's client loop, end to end, against the live relayer and the live testnets.
//
//   1  the desk opens a link — a name and nothing else
//   2  the client opens that link, with no key of any kind, and chooses the terms themselves
//   3  the client signs every token they chose, on every chain, ONCE
//   4  the relayer fans the one signature out to every chain in the mandate
//   5  the desk records which owner answered which link
//   6  the allowance is read back off each chain and checked against what was offered
//
// This is the product claim, so every step is asserted rather than printed. The negative cases
// matter as much as the positive ones: a link that can be claimed twice, or a mandate that grants
// more than it offered, would both look like success in a log that only reported what happened.
//
//   set -a && . ./.env && set +a
//   bun run apps/relayer/src/server.ts &
//   bun run packages/sdk/scripts/onboard.ts
//
import { http, type Address, createPublicClient, createWalletClient, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

import {
  approveEntry,
  crossPermitAbi,
  leafOf,
  leafOfChecked,
  processProof,
  signRoot,
} from "../src/crosspermit.js";
import { prepareIntent, toWire } from "../src/intent.js";

const here = (p: string) => new URL(`../../../${p}`, import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(here(p), "utf8"));

const CROSS_PERMIT = readJson("deployments/crosspermit.json").address as Address;

const CHAINS = [
  { key: "BaseSepolia", name: "Base Sepolia", chainId: 84532, rpc: "RPC_BASE_SEPOLIA" },
  { key: "OPSepolia", name: "Optimism Sepolia", chainId: 11155420, rpc: "RPC_OP_SEPOLIA" },
  { key: "Sepolia", name: "Ethereum Sepolia", chainId: 11155111, rpc: "RPC_ETH_SEPOLIA" },
] as const;

/** Small enough that a re-run costs nothing, large enough that a truncation would show. */
const CAP = 7_654321n;
const TTL_HOURS = 6;

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (run: set -a && . ./.env && set +a)`);
  return v;
};
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const RELAYER = arg("relayer") ?? "http://localhost:8787";
const DESK_KEY = process.env.RELAYER_API_KEYS?.split(",")[0]?.trim() ?? "";

let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const deskHeaders = (): HeadersInit => ({
  "content-type": "application/json",
  ...(DESK_KEY ? { authorization: `Bearer ${DESK_KEY}` } : {}),
});

async function main() {
  const client = privateKeyToAccount(env("PRIVATE_KEY") as `0x${string}`);
  console.log(`crosspermit onboarding — client ${client.address}`);
  console.log(`  relayer     ${RELAYER}`);
  console.log(`  crossPermit ${CROSS_PERMIT}\n`);

  const chains = CHAINS.map((c) => {
    const transport = http(env(c.rpc));
    return {
      ...c,
      // Both tokens the lifecycle script deploys on this chain. The mandate page lists every one of
      // them and lets the client pick, so the script grants on both: a leg carrying two permit
      // entries is the case a single-token test would never exercise.
      tokens: [
        readJson(`deployments/token-${c.key}.json`).address as Address,
        readJson(`deployments/token2-${c.key}.json`).address as Address,
      ],
      // Both spenders a real mandate names. The page grants the router AND the LiquidityDesk, so a
      // script that granted only the router would prove a path no client actually walks.
      spenders: [
        readJson(`deployments/router-${c.key}.json`).universalRouter as Address,
        readJson(`deployments/liquidity-${c.key}.json`).address as Address,
      ],
      public: createPublicClient({ transport }),
      wallet: createWalletClient({ account: client, transport }),
    };
  });

  // ---------------------------------------------------------------- 1. the desk creates a mandate
  console.log("1. the desk opens a link");
  const created = await fetch(`${RELAYER}/v1/clients`, {
    method: "POST",
    headers: deskHeaders(),
    body: JSON.stringify({ name: "Meridian Capital" }),
  });
  const createdBody = (await created.json()) as {
    client?: { token: string; status: string; capUnits: string; ttlHours: number; chainIds: number[] };
    error?: string;
  };
  check(created.status === 201, "the desk can open a link with a name and nothing else", createdBody.error ?? `HTTP ${created.status}`);
  if (!createdBody.client) throw new Error(createdBody.error ?? "no mandate returned");
  const link = createdBody.client.token;
  check(createdBody.client.status === "awaiting", "a new link is awaiting, not active");
  // The desk did not choose any of this, so none of it may exist yet. A default cap invented here
  // is a term the client never agreed to that the desk could later point at.
  check(createdBody.client.capUnits === "", "the desk set no cap");
  check(createdBody.client.ttlHours === 0, "the desk set no expiry");
  check(createdBody.client.chainIds.length === 0, "the desk named no chains");
  console.log(`       link      /c/${link}\n`);

  // ---------------------------------------------------------------- 2. the client reads the offer
  console.log("2. the client opens the link and chooses the terms");
  const offerRes = await fetch(`${RELAYER}/v1/clients/${link}`);
  const offer = ((await offerRes.json()) as { client: { name: string; capUnits: string; ttlHours: number } }).client;
  check(offerRes.ok, "the link is readable with no key at all");
  check(offer.name === "Meridian Capital", "the client sees who is asking");
  check(offer.capUnits === "" && offer.ttlHours === 0, "there is nothing to accept — the terms are the client's to set");

  // What the page's own controls produce: every token on every chain, one shared amount, one expiry.
  const grants = chains.flatMap((c) => c.tokens.flatMap((token) => c.spenders.map((spender) => ({ chain: c, token, spender }))));
  console.log(
    `       choosing  ${grants.length} grants across ${chains.length} chains` +
      ` (${chains[0]!.tokens.length} tokens x ${chains[0]!.spenders.length} spenders), ${formatUnits(CAP, 6)} each, ${TTL_HOURS}h\n`,
  );

  // ---------------------------------------------------------------- 3. the client signs, once
  console.log("3. the client signs once");
  const before = await Promise.all(grants.map((g) => allowanceOf(g.chain, g.token, g.spender, client.address)));

  const now = Math.floor(Date.now() / 1000);
  const expiry = now + TTL_HOURS * 3600;

  // Built with the same call the mandate page uses, so this script proves the path a real client
  // takes rather than a parallel one that could drift from it. Every token times every spender on
  // one chain is ONE leg — one signature, and one transaction per chain rather than per grant.
  const { intent } = prepareIntent({
    crossPermit: CROSS_PERMIT,
    owner: client.address,
    now,
    ttl: 3600,
    chains: chains.map((c) => ({
      chainId: c.chainId,
      permits: c.tokens.flatMap((token) => c.spenders.map((spender) => approveEntry(token, spender, CAP, expiry))),
    })),
  });

  // The leaves the client signed are computed locally; the chain is asked only to agree. A leaf that
  // arrived FROM an RPC would let a hostile endpoint choose what the client is about to sign.
  const onChainLeaves = await Promise.all(
    intent.legs.map((leg, i) =>
      leafOfChecked(
        { chainId: chains[i]!.chainId, client: chains[i]!.public, wallet: chains[i]!.wallet, crossPermit: CROSS_PERMIT },
        leg.bundle,
      ),
    ),
  );
  check(
    onChainLeaves.every((l, i) => l === leafOf(intent.legs[i]!.bundle)),
    "each chain agrees with the leaf computed on the client",
  );
  check(
    intent.legs.every((leg, i) => leg.bundle.permits.length === chains[i]!.tokens.length * chains[i]!.spenders.length),
    "each chain's leg carries a permit entry per token per spender chosen on it",
  );
  check(
    intent.legs.every((leg) => processProof(leafOf(leg.bundle), leg.proof) === intent.root),
    "every proof rebuilds the one root the client is signing",
  );
  check(
    intent.timestamp < now,
    "the signed ordering timestamp is behind wall clock",
    `${now - intent.timestamp}s, so a chain whose head block is a few seconds old still accepts it`,
  );

  const signature = await signRoot(chains[0]!.wallet, client, CROSS_PERMIT, {
    owner: client.address,
    salt: intent.salt,
    deadline: intent.deadline,
    timestamp: intent.timestamp,
    merkleRoot: intent.root,
  });
  console.log(`       root      ${intent.root}`);
  console.log(`       signature ${signature}`);
  check(signature.length === 132, "exactly one 65-byte signature was produced for every token on every chain");
  console.log("");

  // ---------------------------------------------------------------- 4. one POST, every chain
  console.log("4. the relayer fans it out");
  const submitted = await fetch(`${RELAYER}/v1/intents?wait=1`, {
    method: "POST",
    headers: deskHeaders(),
    body: JSON.stringify(toWire({ ...intent, signature })),
  });
  const result = (await submitted.json()) as {
    intentId: string;
    ok?: boolean;
    legs?: { chainId: number; status: string; txHash: string | null; error: string | null }[];
    error?: string;
  };
  check(submitted.status < 400, "the relayer accepted the intent", result.error ?? `HTTP ${submitted.status}`);
  for (const leg of result.legs ?? []) {
    check(leg.status === "confirmed", `chain ${leg.chainId} confirmed`, leg.txHash ?? leg.error ?? "");
  }
  check((result.legs?.length ?? 0) === chains.length, `one POST produced ${chains.length} legs`);
  console.log("");

  // ---------------------------------------------------------------- 5. the desk records the client
  console.log("5. the desk records who answered, and on what terms");
  // Binding is the DESK's write, not the client's, so it carries the desk key. The client's own
  // authority came from their signature, which the relayer already matched against the intent.
  const linked = await fetch(`${RELAYER}/v1/clients/${link}/link`, {
    method: "POST",
    headers: deskHeaders(),
    body: JSON.stringify({
      owner: client.address,
      intentId: result.intentId,
      capUnits: CAP.toString(),
      ttlHours: TTL_HOURS,
      chainIds: chains.map((c) => c.chainId),
    }),
  });
  const linkedBody = (await linked.json()) as {
    client?: { status: string; owner: string; capUnits: string; ttlHours: number; chainIds: number[] };
    error?: string;
  };
  check(linked.ok, "the mandate binds to the owner who signed it", linkedBody.error ?? `HTTP ${linked.status}`);
  check(linkedBody.client?.status === "active", "the mandate is now active");
  check(linkedBody.client?.owner === client.address, "it is bound to the signer, not to whoever posted");
  // The ledger has to show what the client granted, not what anyone asked for.
  check(linkedBody.client?.capUnits === CAP.toString(), "the desk's ledger shows the cap the client chose", linkedBody.client?.capUnits);
  check(linkedBody.client?.ttlHours === TTL_HOURS, "and the expiry the client chose");
  check(
    (linkedBody.client?.chainIds ?? []).join(",") === chains.map((c) => c.chainId).join(","),
    "and the chains the client chose",
  );

  // Someone else holding the same link must not be able to repoint it at their own address.
  const second = await fetch(`${RELAYER}/v1/clients/${link}/link`, {
    method: "POST",
    headers: deskHeaders(),
    body: JSON.stringify({ owner: "0x000000000000000000000000000000000000bEEF", intentId: result.intentId }),
  });
  check(second.status >= 400, "a second claim on the same link is refused", `HTTP ${second.status}`);

  // And an intent this owner did not sign must not be bindable to them.
  const forged = await fetch(`${RELAYER}/v1/clients/${link}/link`, {
    method: "POST",
    headers: deskHeaders(),
    body: JSON.stringify({ owner: "0x000000000000000000000000000000000000bEEF", intentId: "not-an-intent" }),
  });
  check(forged.status >= 400, "an unknown intent cannot bind a mandate", `HTTP ${forged.status}`);
  console.log("");

  // ---------------------------------------------------------------- 6. read the authority back
  console.log("6. the authority is real, on every token, on every chain");
  const after = await Promise.all(grants.map((g) => allowanceOf(g.chain, g.token, g.spender, client.address)));
  for (let i = 0; i < grants.length; i++) {
    const g = grants[i]!;
    const granted = after[i]!.amount - before[i]!.amount;
    // Exactly the cap, not merely "at least". A mandate that granted more than the client was shown
    // is the failure this whole flow exists to prevent. Note this is the DELTA: an allowance entry
    // with an expiry is an increase, so the resulting allowance is whatever was already outstanding
    // plus the cap — which is why the mandate page has to show both numbers, not just the cap.
    check(
      granted === CAP,
      `${g.chain.name} ${g.token.slice(0, 8)} -> ${g.spender.slice(0, 8)}: the allowance rose by exactly the amount chosen`,
      `${formatUnits(before[i]!.amount, 6)} -> ${formatUnits(after[i]!.amount, 6)} (delta ${formatUnits(granted, 6)})`,
    );
    check(
      Math.abs(after[i]!.expiration - expiry) <= 1,
      `${g.chain.name} ${g.token.slice(0, 8)} -> ${g.spender.slice(0, 8)}: expiry is the one the client agreed to`,
      `${after[i]!.expiration} vs ${expiry}`,
    );
  }

  // The desk's own list has to show the client it just onboarded.
  const list = await fetch(`${RELAYER}/v1/clients`, { headers: deskHeaders() });
  const listed = ((await list.json()) as { clients: { token: string; status: string }[] }).clients ?? [];
  check(
    listed.some((c) => c.token === link && c.status === "active"),
    "the client appears on the desk as active",
  );

  console.log("");
  console.log(failures === 0 ? "ONBOARDING OK" : `ONBOARDING FAILED — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

async function allowanceOf(
  c: { public: ReturnType<typeof createPublicClient> },
  token: Address,
  spender: Address,
  owner: Address,
): Promise<{ amount: bigint; expiration: number }> {
  const [amount, expiration] = (await c.public.readContract({
    address: CROSS_PERMIT,
    abi: crossPermitAbi,
    functionName: "allowance",
    args: [owner, token, spender],
  })) as [bigint, number, number];
  return { amount, expiration };
}

await main();
