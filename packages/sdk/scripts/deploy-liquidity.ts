// Deploy LiquidityDesk — the v4 LP adapter funded by a CrossPermit writ — on all three testnets.
//
// One contract per chain, because it is bound to that chain's PoolManager. Cached in
// deployments/liquidity-<key>.json, so re-running is a no-op once code is there.
//
//   forge build && set -a && . ./.env && set +a && bun run packages/sdk/scripts/deploy-liquidity.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Address, type Hex, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = new URL("../../../", import.meta.url).pathname;
const here = (p: string) => `${root}${p}`;
const readJson = (p: string) => JSON.parse(readFileSync(here(p), "utf8"));

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (run: set -a && . ./.env && set +a)`);
  return v;
};

const CHAINS = [
  { key: "BaseSepolia", name: "Base Sepolia", rpc: "RPC_BASE_SEPOLIA", explorer: "https://sepolia.basescan.org", poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408" },
  { key: "OPSepolia", name: "Optimism Sepolia", rpc: "RPC_OP_SEPOLIA", explorer: "https://sepolia-optimism.etherscan.io", poolManager: "0xf7F5aB3DcA35e17dE187b459159BC643853B3c67" },
  { key: "Sepolia", name: "Ethereum Sepolia", rpc: "RPC_ETH_SEPOLIA", explorer: "https://sepolia.etherscan.io", poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543" },
] as const;

const artifact = readJson("contracts/out/LiquidityDesk.sol/LiquidityDesk.json");
const crossPermit = readJson("deployments/crosspermit.json").address as Address;
const account = privateKeyToAccount(env("PRIVATE_KEY") as Hex);

console.log(`LiquidityDesk deploy — CrossPermit ${crossPermit}, from ${account.address}`);

for (const c of CHAINS) {
  const transport = http(env(c.rpc));
  const client = createPublicClient({ transport });
  const wallet = createWalletClient({ account, transport });
  const path = `deployments/liquidity-${c.key}.json`;

  // Cached only when there is actually code at the recorded address. A JSON file is not evidence
  // of a deployment; a code hash is.
  if (existsSync(here(path))) {
    const cached = readJson(path).address as Address;
    const code = await client.getCode({ address: cached });
    if (code && code !== "0x") {
      console.log(`  ok   ${c.name}: already at ${cached}`);
      continue;
    }
  }

  const balance = await client.getBalance({ address: account.address });
  if (balance === 0n) {
    console.log(`  SKIP ${c.name}: deployer has no gas`);
    continue;
  }

  const hash = await wallet.deployContract({
    account,
    chain: null,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [crossPermit, c.poolManager],
  });
  const { contractAddress } = await client.waitForTransactionReceipt({ hash });
  if (!contractAddress) throw new Error(`${c.name}: deployment produced no address`);

  writeFileSync(
    here(path),
    `${JSON.stringify(
      { chain: c.key, address: contractAddress, crossPermit, poolManager: c.poolManager, tx: hash },
      null,
      2,
    )}\n`,
  );
  console.log(`  ok   ${c.name}: ${contractAddress}  ${c.explorer}/address/${contractAddress}`);
}
