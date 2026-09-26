// Live smoke test against a real MultiBaas deployment.
//
//   set -a && . ./.env && set +a && bun run packages/multibaas/scripts/smoke.ts
//
// Registers CrossPermit so its events are indexed, then exercises every primitive the treasury layer
// depends on. Read-only apart from the registration, which is idempotent.
import { readFileSync } from "node:fs";
import type { Address } from "viem";

import { MultiBaas, Treasury, multibaasFromEnv, verifyWebhook } from "../src/index.js";
import { registerCrossPermit, servedChains } from "./register-crosspermit.js";

const here = (p: string) => new URL(`../../../${p}`, import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(here(p), "utf8"));

let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  const cfg = multibaasFromEnv();
  if (!cfg) {
    console.log("MULTIBAAS_URL / MULTIBAAS_API_KEY unset — nothing to smoke test.");
    console.log("That is a supported mode: the relayer runs on a local signer and says so at boot.");
    return;
  }

  const mb = new MultiBaas(cfg);
  const chainId = Number(process.env.MULTIBAAS_CHAIN_ID ?? 84532);
  const crossPermit = readJson("deployments/crosspermit.json").address as Address;
  const owner = (process.env.SMOKE_OWNER ?? "0x9673afB923d556979E4dfe6854d8C6e2D9994Eb4") as Address;

  console.log("--- identity ---");
  console.log(`  ${await mb.describe()}`);
  const status = await mb.chainStatus();
  check(status.chainID === chainId, `deployment serves chainId ${status.chainID}`, `expected ${chainId}`);

  console.log("\n--- primitives ---");
  const contracts = await mb.listContracts();
  check(Array.isArray(contracts), "listContracts", `${contracts.length} contract(s) known`);
  const addresses = await mb.listAddresses();
  check(Array.isArray(addresses), "listAddresses", `${addresses.length} alias(es)`);
  const queries = await mb.listQueries();
  check(Array.isArray(queries), "listQueries", `${queries.length} saved`);
  const hooks = await mb.listWebhooks();
  check(Array.isArray(hooks), "listWebhooks", `${hooks.length} configured`);
  const txm = await mb.listWalletTransactions(owner).catch(() => null);
  check(txm !== null, "transaction manager reachable", txm ? `${txm.length} tracked` : "");

  console.log("\n--- register CrossPermit on every configured chain ---");
  // The same step the deploy runs, called rather than reimplemented: a smoke test that registers
  // its own way proves the smoke test works, not the deploy.
  const served = servedChains();
  const treasury = Treasury.fromEnv(process.env, served);
  for (const line of await treasury.describe(served)) console.log(line);

  for (const reg of await registerCrossPermit(treasury)) {
    check(reg.address === crossPermit, `chain ${reg.chainId}: CrossPermit registered as "${reg.label}"`);
    check(reg.linked, `chain ${reg.chainId}: address alias resolves to the deployed CrossPermit`);
  }

  console.log("\n--- treasury view ---");
  const ledger = await treasury.allowanceLedgerAllChains(owner);
  console.log(`  ${ledger.length} allowance row(s) for ${owner} across ${treasury.chains().length} chain(s)`);
  for (const r of ledger.slice(0, 5)) {
    console.log(`    chain ${r.chainId}  ${r.token} -> ${r.spender}  amount=${r.amount} state=${r.state}`);
  }
  // Indexing starts at "latest", so a fresh registration legitimately has nothing yet. Say which it
  // is rather than letting an empty ledger read as "no exposure".
  console.log(
    ledger.length === 0
      ? "  (empty: indexing starts at the registration block, so only activity from now on appears)"
      : "  (rows above are decoded from indexed Permit events)",
  );

  console.log("\n--- webhook signature verification ---");
  const secret = "smoke-secret";
  const body = JSON.stringify({ hello: "world" });
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}${body}`));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  check(await verifyWebhook({ secret, signature: sig, timestamp: ts, rawBody: body }), "a correct signature verifies");
  check(!(await verifyWebhook({ secret, signature: sig, timestamp: ts, rawBody: `${body} ` })), "a tampered body is rejected");
  check(!(await verifyWebhook({ secret: "wrong", signature: sig, timestamp: ts, rawBody: body })), "a wrong secret is rejected");
  check(
    !(await verifyWebhook({ secret, signature: sig, timestamp: String(Number(ts) - 3600), rawBody: body })),
    "a replayed old delivery is rejected",
  );

  console.log(failures === 0 ? "\nMULTIBAAS SMOKE OK" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
