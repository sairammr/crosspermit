// Put LiquidityDesk under the control plane, so LP activity has the same audit trail as authority.
//
// Without this, `add`/`remove` are calldata: the desk can prove a client's allowance was granted
// and consumed, but not what the capital was put into. One registration per deployment fixes that.
//
//   forge build && set -a && . ./.env && set +a && bun run packages/multibaas/scripts/register-liquidity.ts
import { readFileSync } from "node:fs";

import { MultiBaas, MultiBaasError } from "../src/client.js";

const root = new URL("../../../", import.meta.url).pathname;
const readJson = (p: string) => JSON.parse(readFileSync(`${root}${p}`, "utf8"));
const artifact = readJson("contracts/out/LiquidityDesk.sol/LiquidityDesk.json");

const DEPLOYMENTS = [
  { chainId: 84532, key: "BaseSepolia", name: "Base Sepolia", url: process.env.MULTIBAAS_URL, apiKey: process.env.MULTIBAAS_API_KEY },
  { chainId: 11155111, key: "Sepolia", name: "Ethereum Sepolia", url: process.env.MULTIBAAS_URL_11155111, apiKey: process.env.MULTIBAAS_API_KEY_11155111 },
];

const LABEL = "liquiditydesk";

for (const d of DEPLOYMENTS) {
  console.log(`\n${d.name}`);
  if (!d.url || !d.apiKey) {
    console.log("  no MultiBaas deployment configured — skipped");
    continue;
  }
  const mb = new MultiBaas({ url: d.url, apiKey: d.apiKey, chain: "ethereum" });
  const address = readJson(`deployments/liquidity-${d.key}.json`).address as string;

  const existing = await mb.listContracts().catch(() => []);
  if (!existing.some((c) => c.label === LABEL)) {
    await mb
      .createContract(LABEL, {
        label: LABEL,
        contractName: "LiquidityDesk",
        version: "1.0",
        // A JSON STRING, not an object — MultiBaas parses this field itself and answers
        // "unable to parse JSON" about the whole body if it is handed the parsed form.
        rawAbi: JSON.stringify(artifact.abi),
        // Must keep the 0x prefix; the column is NOT NULL.
        bin: artifact.bytecode.object,
      })
      .catch((e) => {
        if (e instanceof MultiBaasError && e.status === 409) return undefined;
        throw e;
      });
    console.log(`  registered ABI as ${LABEL}`);
  } else {
    console.log(`  ABI already registered as ${LABEL}`);
  }

  await mb.setAddress(LABEL, address).catch(() => undefined);
  // `-100` rather than "latest": the plan allows a 100-block backfill and nothing deeper, so this
  // is the most history this deployment can be asked for. Omitting it would index nothing at all.
  await mb.linkAddressContract(LABEL, LABEL, "-100").catch((e) => {
    console.log(`  link: ${(e as Error).message.slice(0, 120)}`);
  });
  console.log(`  linked ${address} — LiquidityAdded / LiquidityRemoved now indexed`);

  const count = await mb.eventCount().catch(() => -1);
  console.log(`  events on this deployment: ${count} (deployment-wide; the filters are ignored)`);
}
