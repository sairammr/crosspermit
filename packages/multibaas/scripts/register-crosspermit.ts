// Put CrossPermit under the control plane, on every chain the relayer serves.
//
// This is a named deploy step, not a side effect of a smoke test. Without it MultiBaas indexes
// nothing: the `Permit` events the treasury view is decoded from never arrive, and the dashboard
// shows an owner with no outstanding authority rather than an owner nobody is watching.
//
//   forge build && set -a && . ./.env && set +a && bun run packages/multibaas/scripts/register-crosspermit.ts
//
// Idempotent, and safe to run after every deploy: an already-registered label is a 409, which
// `Treasury.registerCrossPermit` treats as success.
import { readFileSync } from "node:fs";
import type { Address } from "viem";

import { Treasury } from "../src/index.js";

const here = (p: string) => new URL(`../../../${p}`, import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(here(p), "utf8"));

/** The chains the relayer serves, which is the set that has to be indexed. Matches `config.ts`. */
export const servedChains = (env: Record<string, string | undefined> = process.env): number[] =>
  (env.RELAYER_CHAINS ?? "11155111,84532,11155420").split(",").map(Number);

export type Registration = { chainId: number; label: string; address: Address; linked: boolean };

/**
 * Register the deployed CrossPermit on every chain this treasury has a deployment for.
 *
 * `linked` is read back rather than assumed: `setAddress` and `linkAddressContract` both swallow
 * their errors to stay idempotent, so the only way to know indexing is really wired up is to ask
 * the deployment what addresses it now resolves.
 */
export async function registerCrossPermit(
  treasury: Treasury,
  opts: { startingBlock?: string } = {},
): Promise<Registration[]> {
  const address = readJson("deployments/crosspermit.json").address as Address;
  const artifact = readJson("contracts/out/CrossPermit.sol/CrossPermit.json");

  const out: Registration[] = [];
  for (const chainId of treasury.chains()) {
    const reg = await treasury.registerCrossPermit({
      chainId,
      address,
      abi: artifact.abi,
      bin: artifact.bytecode.object as string,
      startingBlock: opts.startingBlock ?? "latest",
    });
    const linked = (await treasury.get(chainId)!.listAddresses()).some(
      (a) => a.address?.toLowerCase() === address.toLowerCase(),
    );
    out.push({ ...reg, linked });
  }
  return out;
}

if (import.meta.main) {
  const served = servedChains();
  const treasury = Treasury.fromEnv(process.env, served);
  // Every chain the relayer serves, so a chain with no deployment is reported rather than skipped
  // silently — a missing audit trail nobody was told about is worse than none at all.
  for (const line of await treasury.describe(served)) console.log(line);

  const registrations = await registerCrossPermit(treasury);
  if (registrations.length === 0) console.log("  no MultiBaas deployment configured — nothing registered");
  for (const r of registrations) {
    console.log(`  chain ${r.chainId}: ${r.address} registered as "${r.label}"${r.linked ? "" : " — NOT linked"}`);
  }
  // Indexing starts at the registration block, so the ledger is legitimately empty until the next
  // permit lands. An operator who is not told that reads it as "no exposure".
  console.log("  indexing starts here: only Permit events from this block on will appear");
  if (registrations.some((r) => !r.linked)) process.exit(1);
}
