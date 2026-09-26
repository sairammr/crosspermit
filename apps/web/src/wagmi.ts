"use client";

import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createAppKit } from "@reown/appkit/react";
import { baseSepolia, optimismSepolia, sepolia } from "viem/chains";

import { CHAINS, WC_PROJECT_ID } from "./config";

const networks = [baseSepolia, optimismSepolia, sepolia] as const;

export const wagmiAdapter = new WagmiAdapter({
  networks: [...networks],
  projectId: WC_PROJECT_ID || "00000000000000000000000000000000",
  ssr: true,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

let started = false;

/**
 * AppKit is a singleton and throws if constructed twice, which React's strict mode will happily do.
 * Guarded rather than moved to module scope so it never runs during SSR.
 */
export function initAppKit() {
  if (started || typeof window === "undefined") return;
  started = true;
  createAppKit({
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

export const CHAIN_IDS = CHAINS.map((c) => c.id);
