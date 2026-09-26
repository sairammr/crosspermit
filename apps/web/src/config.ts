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
    router: "0x73ed10744987B65fAf6BD6FFdF1039Cb7eF97002",
    token: "0x974727EA649Ee0EfBB6A1b1A584614838B832cB3",
  },
  {
    id: 11155420,
    name: "Optimism Sepolia",
    short: "OP",
    rpc: "https://optimism-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia-optimism.etherscan.io",
    router: "0x2E03912851a0e442C77Ce00506aA7664E45560Ac",
    token: "0x903321db019c620a9907e76e29927e0e7acc4764",
  },
  {
    id: 11155111,
    name: "Ethereum Sepolia",
    short: "ETH",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    router: "0x7B68d6740C5C66967271966E62fd1A3E01743E3c",
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
