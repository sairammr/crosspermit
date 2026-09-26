"use client";

import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createAppKit } from "@reown/appkit/react";
import { http } from "viem";
import { baseSepolia, mainnet, optimismSepolia, sepolia } from "viem/chains";

import { SIGNING_CHAIN_ID } from "@crosspermit/sdk";

import { CHAINS, WC_PROJECT_ID } from "./config";

/**
 * The three testnets the desk trades on, plus Ethereum mainnet.
 *
 * Mainnet is here as a signing domain only. The CrossPermit domain pins `chainId = 1` so one
 * signature ports to every chain, and MetaMask refuses `eth_signTypedData_v4` whenever the domain's
 * chain is not the one the wallet is on — so the wallet has to be switchable onto chain 1. Nothing
 * is ever read from or broadcast to it.
 */
const networks = [baseSepolia, optimismSepolia, sepolia, mainnet] as const;

/**
 * The same endpoints the rest of this repository uses, rather than whichever default wagmi picks.
 *
 * Defaults are not uniformly reliable across these three testnets, and a read that fails renders as
 * a number on a treasury screen. Naming the transports makes the reads agree with what `cast` sees
 * from the same machine.
 */
const transports = Object.fromEntries(CHAINS.map((c) => [c.id, http(c.rpc)]));

export const wagmiAdapter = new WagmiAdapter({
  networks: [...networks],
  transports,
  projectId: WC_PROJECT_ID || "00000000000000000000000000000000",
  ssr: true,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

let started = false;
let appKit: ReturnType<typeof createAppKit> | undefined;

/**
 * AppKit is a singleton and throws if constructed twice, which React's strict mode will happily do.
 * Guarded rather than moved to module scope so it never runs during SSR.
 */
export function initAppKit() {
  if (started || typeof window === "undefined") return;
  started = true;
  appKit = createAppKit({
    adapters: [wagmiAdapter],
    networks: [...networks],
    projectId: WC_PROJECT_ID || "00000000000000000000000000000000",
    metadata: {
      name: "CrossPermit",
      description: "One signature. Every chain.",
      url: typeof location === "undefined" ? "http://localhost:3000" : location.origin,
      icons: [],
    },
    features: { analytics: false, email: false, socials: false },
    themeMode: "light",
    // AppKit ships its own blue. The connect button sits next to the sign button on the client's
    // mandate page, and two different accents there read as two different products.
    themeVariables: {
      "--w3m-accent": "#F45108",
      "--w3m-color-mix": "#171717",
      "--w3m-color-mix-strength": 8,
      "--w3m-border-radius-master": "1px",
      "--w3m-font-family": "var(--font-ui), Helvetica, Arial, sans-serif",
    },
  });
}

/**
 * The wallet modal, driven through the instance rather than AppKit's React hooks.
 *
 * `useAppKit`/`useAppKitTheme` throw outright when AppKit has not been constructed, and it is
 * constructed only in the browser (see `initAppKit`) — so a page that calls either hook during
 * render fails to prerender and the whole build stops on that route. Reading the instance instead
 * is a no-op on the server and identical in the browser.
 */
export const openAppKit = (options?: Parameters<NonNullable<typeof appKit>["open"]>[0]) => appKit?.open(options);

export const CHAIN_IDS = CHAINS.map((c) => c.id);

/**
 * Put the wallet on the signing domain's chain before asking it for a signature.
 *
 * `signTypedData({ chainId })` does not switch for you — it asserts, and a wallet sitting on Base
 * Sepolia answers a domain pinned to chain 1 with
 * `Provided chainId "1" must match the active chainId "84532"`. Nothing is read from or broadcast
 * to chain 1; the switch exists only so the wallet will sign the cross-chain domain at all.
 */
export async function onSigningChain(
  current: number | undefined,
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>,
): Promise<void> {
  if (current === SIGNING_CHAIN_ID) return;
  await switchChainAsync({ chainId: SIGNING_CHAIN_ID });
}
