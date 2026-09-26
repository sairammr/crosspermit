"use client";

import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createAppKit } from "@reown/appkit/react";
import { defineChain } from "viem";
import { baseSepolia, sepolia } from "viem/chains";

import { CHAINS, WC_PROJECT_ID } from "./config";

/** Unichain Sepolia is not in viem's chain list at this pin, so it is defined here. */
export const unichainSepolia = defineChain({
  id: 1301,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.unichain.org"] } },
  blockExplorers: { default: { name: "Uniscan", url: "https://sepolia.uniscan.xyz" } },
  testnet: true,
});

const networks = [baseSepolia, unichainSepolia, sepolia] as const;

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
    themeMode: "dark",
  });
}

export const CHAIN_IDS = CHAINS.map((c) => c.id);
