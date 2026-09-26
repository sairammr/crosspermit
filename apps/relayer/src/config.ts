// Relayer configuration: which chains, which RPCs, which key, which control plane.
//
// Everything is explicit and logged at boot. An operator must never have to guess whether the
// relayer is signing with a local key or a Cloud Wallet, or which chains it is actually serving.
import { readFileSync } from "node:fs";
import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, http } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

import { type Signer, Treasury, cloudWalletSigner, localSigner } from "@crosspermit/multibaas";

export type ChainConfig = {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer?: string;
};

/** The chains this relayer knows how to serve, with the env var holding each RPC URL. */
const KNOWN_CHAINS: (ChainConfig & { rpcEnv: string })[] = [
  { chainId: 11155111, name: "Ethereum Sepolia", rpcEnv: "RPC_ETH_SEPOLIA", rpcUrl: "", explorer: "https://sepolia.etherscan.io" },
  { chainId: 84532, name: "Base Sepolia", rpcEnv: "RPC_BASE_SEPOLIA", rpcUrl: "", explorer: "https://sepolia.basescan.org" },
  { chainId: 1301, name: "Unichain Sepolia", rpcEnv: "RPC_UNI_SEPOLIA", rpcUrl: "", explorer: "https://sepolia.uniscan.xyz" },
];

export type ChainRuntime = ChainConfig & {
  client: PublicClient;
  signer: Signer;
  /** Serialises submission per chain so two intents cannot race the same nonce. */
  queue: Promise<unknown>;
};

export type RelayerConfig = {
  port: number;
  crossPermit: Address;
  chains: Map<number, ChainRuntime>;
  treasury: Treasury;
  account: PrivateKeyAccount | null;
  dbPath: string;
  /** Refuse an intent whose deadline is closer than this — it would expire mid-fan-out. */
  minSecondsLeft: number;
};

const env = (k: string, fallback?: string): string => {
  const v = process.env[k]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing env ${k}`);
};

export async function loadConfig(repoRoot: URL): Promise<{ config: RelayerConfig; banner: string[] }> {
  const crossPermit = JSON.parse(readFileSync(new URL("deployments/crosspermit.json", repoRoot), "utf8")).address as Address;

  const wanted = env("RELAYER_CHAINS", "11155111,84532,1301")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Number.isFinite);

  const pk = process.env.RELAYER_PRIVATE_KEY?.trim();
  const account = pk ? privateKeyToAccount(pk as Hex) : null;
  const treasury = Treasury.fromEnv(process.env, wanted);

  const banner: string[] = [`crossPermit ${crossPermit}`];
  const chains = new Map<number, ChainRuntime>();

  for (const chainId of wanted) {
    const known = KNOWN_CHAINS.find((c) => c.chainId === chainId);
    if (!known) {
      banner.push(`  chain ${chainId}: UNKNOWN, skipped — add it to KNOWN_CHAINS`);
      continue;
    }
    const rpcUrl = process.env[known.rpcEnv]?.trim();
    if (!rpcUrl) {
      banner.push(`  chain ${chainId} (${known.name}): no ${known.rpcEnv}, skipped`);
      continue;
    }

    const transport = http(rpcUrl);
    const client: PublicClient = createPublicClient({ transport });
    const mb = treasury.get(chainId);

    // A Cloud Wallet is preferred when one exists on this chain's deployment: the key never enters
    // this process. Fall back to the local key, and say plainly which one is in use — custody is
    // the single most important thing an operator needs to know about a relayer.
    let signer: Signer | null = null;
    if (mb) {
      const wallets = await mb.listHsmWallets().catch(() => [] as { address: string }[]);
      const first = wallets[0]?.address;
      if (first) signer = cloudWalletSigner({ multibaas: mb, address: first as Address });
    }
    if (!signer && account) {
      signer = localSigner({
        account,
        wallet: createWalletClient({ transport }),
        client,
        ...(mb ? { multibaas: mb } : {}),
        onFallback: (why) => console.warn(`[chain ${chainId}] MultiBaas submit failed, broadcasting via RPC: ${why}`),
      });
    }
    if (!signer) {
      banner.push(`  chain ${chainId} (${known.name}): no signer (set RELAYER_PRIVATE_KEY or a Cloud Wallet), read-only`);
      continue;
    }

    chains.set(chainId, { ...known, rpcUrl, client, signer, queue: Promise.resolve() });
    banner.push(
      `  chain ${chainId} (${known.name}): signer ${signer.address} [${signer.custody}]` +
        `${mb ? " + MultiBaas audit trail" : " — no MultiBaas deployment, no control-plane audit trail"}`,
    );
  }

  if (chains.size === 0) throw new Error("no chains configured — the relayer would accept intents it cannot serve");

  return {
    config: {
      port: Number(env("RELAYER_PORT", "8787")),
      crossPermit,
      chains,
      treasury,
      account,
      dbPath: env("RELAYER_DB", new URL("apps/relayer/relayer.sqlite", repoRoot).pathname),
      minSecondsLeft: Number(env("RELAYER_MIN_SECONDS_LEFT", "60")),
    },
    banner,
  };
}
