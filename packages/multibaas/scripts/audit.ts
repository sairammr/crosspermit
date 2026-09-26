// What each MultiBaas deployment is actually being used for, read from the deployment itself.
//
//   set -a && . ./.env && set +a && bun run packages/multibaas/scripts/audit.ts
import { MultiBaas } from "../src/client.js";

const deployments = [
  { chainId: 84532, name: "Base Sepolia", url: process.env.MULTIBAAS_URL, key: process.env.MULTIBAAS_API_KEY },
  { chainId: 11155111, name: "Ethereum Sepolia", url: process.env.MULTIBAAS_URL_11155111, key: process.env.MULTIBAAS_API_KEY_11155111 },
];

for (const d of deployments) {
  console.log(`\n=== ${d.name} (${d.chainId})`);
  if (!d.url || !d.key) {
    console.log("  no deployment configured");
    continue;
  }
  const mb = new MultiBaas({ url: d.url, apiKey: d.key, chain: "ethereum" });
  const tryIt = async <T>(what: string, f: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await f();
    } catch (e) {
      console.log(`  ${what}: FAILED ${(e as Error).message.slice(0, 160)}`);
      return undefined;
    }
  };

  const user = await tryIt("identity", () => mb.currentUser());
  if (user) console.log(`  identity: ${user.email} groups=[${(user.groups ?? []).map((g) => g.name).join(",")}]`);
  const status = await tryIt("chain", () => mb.chainStatus());
  if (status) console.log(`  chain: id ${status.chainID} block ${status.blockNumber} v${status.version}`);

  const contracts = (await tryIt("contracts", () => mb.listContracts())) ?? [];
  console.log(`  contracts registered: ${contracts.map((c) => `${c.label}@${c.version}`).join(", ") || "none"}`);

  const addresses = (await tryIt("addresses", () => mb.listAddresses())) ?? [];
  console.log(`  address aliases: ${addresses.map((a) => `${a.alias}=${a.address.slice(0, 10)}…`).join(", ") || "none"}`);

  for (const c of contracts) {
    const n = await tryIt(`events(${c.label})`, () => mb.eventCount({ contractLabel: c.label }));
    if (n !== undefined) console.log(`  events indexed for ${c.label}: ${n}`);
  }

  const queries = (await tryIt("queries", () => mb.listQueries())) ?? [];
  console.log(`  saved event queries: ${queries.map((q) => q.label).join(", ") || "none"}`);

  const hooks = (await tryIt("webhooks", () => mb.listWebhooks())) ?? [];
  console.log(`  webhooks: ${hooks.length ? hooks.map((h) => `${h.url} [${h.subscriptions?.length ?? 0} subs]`).join(", ") : "none"}`);

  const wallets = (await tryIt("cloud wallets", () => mb.listHsmWallets())) ?? [];
  console.log(`  cloud wallets: ${wallets.length ? wallets.map((w) => w.address).join(", ") : "none"}`);
}
