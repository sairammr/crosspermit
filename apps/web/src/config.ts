import { type Address, getAddress } from "viem";

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
  /**
   * Every token a client may grant over on this chain, `token` first.
   *
   * The client picks one on their own screen, so the list is the menu they are offered. Symbol and
   * decimals are read from the contract rather than written here: a label typed into a config is
   * the one thing on that screen the chain cannot contradict.
   */
  tokens: Address[];
  /** Brand colour of the chain, for the badge on a token's icon. */
  color: string;
  /**
   * The chain's own mark, served from this app rather than from a logo CDN.
   *
   * A third-party image host that is down or blocked would leave a row of broken badges on the one
   * screen where knowing which chain you are granting on matters most.
   */
  logo: string;
};

/** Cheapest first, dearest last — the last leaf carries the shortest merkle proof. */
export const CHAINS: ChainInfo[] = [
  {
    id: 84532,
    name: "Base Sepolia",
    short: "BASE",
    color: "#0052FF",
    logo: "/logos/base.png",
    rpc: "https://base-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.basescan.org",
    router: "0x73ed10744987B65fAf6BD6FFdF1039Cb7eF97002",
    token: "0x974727EA649Ee0EfBB6A1b1A584614838B832cB3",
    tokens: ["0x974727EA649Ee0EfBB6A1b1A584614838B832cB3", "0x4c309fD174629eE7Ac8eEceae8669FBaFD9953A2"],
  },
  {
    id: 11155420,
    name: "Optimism Sepolia",
    short: "OP",
    color: "#FF0420",
    logo: "/logos/optimism.png",
    rpc: "https://optimism-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia-optimism.etherscan.io",
    router: "0x2E03912851a0e442C77Ce00506aA7664E45560Ac",
    token: "0x903321dB019c620A9907E76e29927E0e7ACc4764",
    tokens: ["0x903321dB019c620A9907E76e29927E0e7ACc4764", "0xC2aB86958061e874DD211a9d7c6860D2Bf5C92F1"],
  },
  {
    id: 11155111,
    name: "Ethereum Sepolia",
    short: "ETH",
    color: "#627EEA",
    logo: "/logos/ethereum.png",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    router: "0x7B68d6740C5C66967271966E62fd1A3E01743E3c",
    token: "0x496C39F509a1ec2B63cBE689e7FD52D56Ee02C17",
    tokens: ["0x496C39F509a1ec2B63cBE689e7FD52D56Ee02C17", "0x98feA3a8eC2c4075470dF4d5c497E2DFF31feD88"],
  },
];

/**
 * Fail at import if any address above is not a valid EIP-55 checksum.
 *
 * viem rejects a mis-checksummed address, and the rejection surfaces as one chain quietly showing
 * no data — which on a treasury screen reads as "this client has nothing here". A hand-typed
 * address should break the build instead, which is what this does.
 */
for (const c of CHAINS) {
  for (const [field, value] of [
    ["crossPermit", CROSS_PERMIT],
    ["router", c.router],
    ["token", c.token],
    ...c.tokens.map((t, i) => [`tokens[${i}]`, t] as const),
  ] as const) {
    if (getAddress(value) !== value) {
      throw new Error(`${c.name}: ${field} ${value} is not a valid checksummed address (expected ${getAddress(value)})`);
    }
  }
}

export const chainById = (id: number) => CHAINS.find((c) => c.id === id);

/**
 * The tokens offered on every chain this app can address, indexed by position.
 *
 * One grant covers one asset across the chains the client picks, so the choice has to be a single
 * pick that is meaningful on each of them. The lifecycle script deploys the same tokens in the same
 * order everywhere, which is what makes an index a valid cross-chain name for an asset.
 */
export const TOKEN_SLOTS = Math.min(...CHAINS.map((c) => c.tokens.length));
export const tokenAt = (c: ChainInfo, slot: number) => c.tokens[slot] ?? c.token;

export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:8787";

/**
 * WalletConnect project id. Without one, AppKit falls back to injected wallets only — which is a
 * working dashboard, not a broken one, so the UI says which mode it is in rather than failing.
 */
export const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";
