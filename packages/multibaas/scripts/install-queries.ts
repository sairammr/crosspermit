// Install the saved event query the dashboard's allowance ledger is defined by.
//
// `Treasury.installAllowanceQuery` existed and nothing ever called it, so every deployment ran with
// zero saved queries while the docs claimed otherwise. One definition, queried by the UI and the
// relayer, is the point: two hand-rolled reducers drift.
//
//   set -a && . ./.env && set +a && bun run packages/multibaas/scripts/install-queries.ts
import { Treasury } from "../src/treasury.js";

const CHAINS = [84532, 11155111];
const treasury = Treasury.fromEnv(process.env, CHAINS);

for (const chainId of CHAINS) {
  if (!treasury.has(chainId)) {
    console.log(`chain ${chainId}: no deployment configured — skipped`);
    continue;
  }
  try {
    await treasury.installAllowanceQuery(chainId);
    const labels = (await treasury.get(chainId)!.listQueries()).map((q) => q.label);
    console.log(`chain ${chainId}: saved queries = ${labels.join(", ")}`);
  } catch (e) {
    console.log(`chain ${chainId}: FAILED ${(e as Error).message.slice(0, 200)}`);
  }
}
