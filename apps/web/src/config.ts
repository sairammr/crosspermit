import type { Address } from "viem";

/**
 * Deployed addresses and the chains this dashboard speaks to.
 *
 * Hard-coded rather than fetched, because the whole scheme depends on CrossPermit being at one known
 * address everywhere: a UI that learns its verifying contract from the network it is talking to
 * would sign against whatever that network claimed.
 */
export const CROSS_PERMIT = "0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B" as Address;

export type ChainInfo = {
  id: number;
  name: string;
  short: string;
  rpc: string;
  explorer: string;
  router: Address;
  /** Test token deployed by the lifecycle script; the dashboard reads balances against it. */
  token: Address;
};

/** Cheapest first, dearest last — the last leaf carries the shortest merkle proof. */
export const CHAINS: ChainInfo[] = [
  {
    id: 84532,
    name: "Base Sepolia",
    short: "BASE",
    rpc: "https://base-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.basescan.org",
    router: "0xd72f799E1af27E0d95aB4B9658A277A7811Fbcd0",
    token: "0x974727EA649Ee0EfBB6A1b1A584614838B832cB3",
  },
  {
    id: 1301,
    name: "Unichain Sepolia",
    short: "UNI",
    rpc: "https://sepolia.unichain.org",
    explorer: "https://sepolia.uniscan.xyz",
    router: "0xda3ab7325840F2d1E01cA66dBBEF88078FE34287",
    token: "0x012a12367cEeB9E4EAd98803D8019913CA80c3c2",
  },
  {
    id: 11155111,
    name: "Ethereum Sepolia",
    short: "ETH",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    router: "0x010C1aB71984b7D53b0941d4A7537AE3B806078D",
    token: "0x496c39f509a1EC2b63cBE689e7fD52d56eE02c17",
  },
];

export const chainById = (id: number) => CHAINS.find((c) => c.id === id);

export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:8787";

/**
 * WalletConnect project id. Without one, AppKit falls back to injected wallets only — which is a
 * working dashboard, not a broken one, so the UI says which mode it is in rather than failing.
 */
export const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";
