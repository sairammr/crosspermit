/**
 * What a desk can honestly propose to do with one client's mandate.
 *
 * Two rules hold this file together, and both exist because the alternative is a screen that
 * quietly lies to a treasury:
 *
 *  1. A strategy that is not deployed on a chain the client actually signed for is never
 *     *routable*, however good its numbers look. It can be shown; it cannot be armed.
 *  2. Every figure carries where it came from. A recorded fork measurement and a live reading are
 *     different kinds of fact, and a yield number without its provenance is the first thing a risk
 *     committee should attack.
 *
 * Nothing here touches the chain. It is a pure ranking over the mandate's own terms, which is what
 * makes it testable — see `strategies.test.ts`.
 */

export type StrategyKind = "amm" | "lending" | "equity" | "hedge";

export type Strategy = {
  key: string;
  venue: string;
  kind: StrategyKind;
  what: string;
  /** Deployed and reachable on these chain ids. Empty means nowhere this dashboard can route. */
  liveOn: number[];
  /** Annualised return as a fraction, or null when the honest answer is "it depends on volume". */
  apy: number | null;
  /** Where `apy` came from. Rendered next to it, always. */
  evidence: string;
  /** Shortest sensible holding period. A 24h mandate cannot be put into a 30-day position. */
  minHours: number;
  /** Below this the position is dust against gas. In the token's smallest unit, 6dp assumed. */
  minUnits: bigint;
  risks: string[];
  /** Legs the strategy needs. A leg this product cannot sign for is why something stays designed. */
  legs: string[];
};

/** Chains this dashboard can route into — Uniswap v4 is deployed on all three testnets. */
const TESTNETS = [84532, 11155420, 11155111];

/**
 * The catalogue.
 *
 * `liveOn: []` is the honest state for most of it. Aave v4 and the equity desk are proved against
 * mainnet by `FORK=1 forge test` and have no testnet deployment; the hedge overlays need a perp
 * venue and an options venue that do not exist on these chains at all. They are listed because a
 * client asking "what could this mandate do" deserves the real answer, and each one says on its
 * own row why it is not a button.
 */
export const STRATEGIES: Strategy[] = [
  {
    key: "v4-swap",
    venue: "Uniswap v4 — swap",
    kind: "amm",
    what: "Rotate the mandate's asset through the Universal Router, settled straight out of the allowance.",
    liveOn: TESTNETS,
    apy: null,
    evidence: "1,000,000 in → 996,999 out per chain, measured. Execution, not yield: the 0.30% is a cost here.",
    minHours: 1,
    minUnits: 1_000n,
    risks: ["price impact at size", "the fee is paid, not earned"],
    legs: ["V4_SWAP", "SETTLE_ALL", "CrossPermit.transferFrom"],
  },
  {
    key: "v4-lp",
    venue: "Uniswap v4 — provide liquidity",
    kind: "amm",
    what: "Quote a two-sided range on the pair and collect the fee on everything that crosses it.",
    liveOn: TESTNETS,
    apy: null,
    evidence:
      "0.30% of volume. No APY quoted: fee income depends on volume and realised volatility, and a testnet pool has neither.",
    minHours: 24,
    minUnits: 100_000n,
    risks: [
      "impermanent loss, in proportion to how tight the band is",
      "a narrow range on a volatile pair is market making, not passive yield",
    ],
    legs: ["MODIFY_LIQUIDITY", "SETTLE_ALL", "CrossPermit.transferFrom"],
  },
  {
    key: "aave-supply",
    venue: "Aave v4 — supply",
    kind: "lending",
    what: "Put the idle cash leg into the Core Hub through the MAIN Spoke and take the supply rate.",
    liveOn: [],
    apy: 0.04056,
    evidence:
      "FORK=1 forge test --match-contract TreasuryFork, live Ethereum mainnet: APR 3.976%, APY 4.056%, utilisation 90.16%. 10,000 USDC supplied and withdrawn after 30 days returned +32.65.",
    minHours: 24,
    minUnits: 1_000_000n,
    risks: ["protocol risk", "a withdrawal step stands between the position and the next trade", "the rate floats with utilisation"],
    legs: ["Spoke.supply", "CrossPermit.transferFrom", "aToken minted to the client, never to the desk"],
  },
  {
    key: "equity-fill",
    venue: "Tokenized equities",
    kind: "equity",
    what: "Take equity exposure against an oracle price, bounded by minOut, a staleness window and a deviation band.",
    liveOn: [],
    apy: null,
    evidence:
      "NVDAon (Ondo) read live on mainnet in the fork suite. The guards are proved against the real token; the venue is still a mock, because NVDAon's on-chain route is the issuer's gated mint/redeem window rather than an AMM.",
    minHours: 168,
    minUnits: 1_000_000n,
    risks: ["the underlying market is shut at weekends while the token trades", "compliance gate denies when unset", "oracle staleness"],
    legs: ["compliance gate", "oracle read", "issuer mint/redeem window"],
  },
  {
    key: "cash-carry",
    venue: "Cash-and-carry basis",
    kind: "hedge",
    what: "Hold the spot asset and sell the dated future or perp against it, earning the basis and the funding.",
    liveOn: [],
    apy: null,
    evidence: "Not measured. The short leg needs a perp venue, and none of these three testnets has one.",
    minHours: 168,
    minUnits: 5_000_000n,
    risks: ["funding can invert", "the two legs sit on different venues, so margin is a separate mandate", "liquidation on the short leg"],
    legs: ["spot buy under the writ", "perp short — no venue", "margin management — a second authority this product does not grant"],
  },
  {
    key: "delta-neutral-lp",
    venue: "Delta-neutral LP",
    kind: "hedge",
    what: "Provide the range, then short the drifting leg so the position earns fees without taking the direction.",
    liveOn: [],
    apy: null,
    evidence: "Not measured. Needs the v4 LP leg (live) plus a short leg (absent), so it is half a strategy here.",
    minHours: 168,
    minUnits: 5_000_000n,
    risks: ["the hedge has to be rebalanced as the range fills — that is an ongoing mandate, not one signature", "two venues, two failure modes"],
    legs: ["MODIFY_LIQUIDITY", "perp short — no venue", "rebalancing authority"],
  },
  {
    key: "covered-call",
    venue: "Covered call overlay",
    kind: "hedge",
    what: "Sell upside against a holding the client already has, and take the premium.",
    liveOn: [],
    apy: null,
    evidence: "Not measured. No options venue on these chains, and writing a call requires posting the underlying as collateral — which a mandate that forbids withdrawal cannot do without a custody adapter.",
    minHours: 720,
    minUnits: 5_000_000n,
    risks: ["caps the upside the client was holding the asset for", "collateral posting is a custody question, not a trading one"],
    legs: ["options venue — none", "collateral escrow — conflicts with the no-withdrawal rule"],
  },
  {
    key: "ladder",
    venue: "Maturity ladder",
    kind: "lending",
    what: "Split the cash leg across staggered supply positions so a withdrawal never waits on the whole book.",
    liveOn: [],
    apy: 0.04056,
    evidence: "Same Aave v4 measurement as above, split into tranches. The rate is the fork reading; the laddering is arithmetic on top of it.",
    minHours: 720,
    minUnits: 4_000_000n,
    risks: ["more positions, more gas", "the rate on each tranche is the rate on the day it is opened"],
    legs: ["Spoke.supply ×N", "CrossPermit.transferFrom ×N"],
  },
];

export type Mandate = {
  /** Per-chain cap in the token's smallest unit. */
  capUnits: bigint;
  ttlHours: number;
  chainIds: number[];
};

export type Recommendation = {
  strategy: Strategy;
  /** True only when this dashboard could actually submit it for this mandate. */
  routable: boolean;
  /** Chains where the strategy is live AND the client signed. Empty when routable is false. */
  on: number[];
  /** 0–100. Fit against the mandate's own terms, not a prediction of returns. */
  score: number;
  /** Why it scored what it scored, in the order that mattered. */
  because: string[];
  /** The single reason it cannot be armed, or null. */
  blocked: string | null;
  /** Projected return over the mandate's life, in the token's smallest unit. Null when no APY. */
  projectedUnits: bigint | null;
};

/**
 * Simple interest over the mandate's life, not compounded.
 *
 * The APY figures are already compounded annual rates, so compounding them again over a fraction
 * of a year would overstate a 24-hour mandate's return. Understating is the safe direction for a
 * number a client may act on.
 */
export function projectUnits(capUnits: bigint, apy: number | null, ttlHours: number): bigint | null {
  if (apy === null || capUnits <= 0n || ttlHours <= 0) return null;
  // Fixed-point in basis-points-of-a-basis-point, so the arithmetic stays in bigint and a long
  // mandate on a large cap cannot lose precision to a float.
  const rate = BigInt(Math.round(apy * 1e8));
  return (capUnits * rate * BigInt(Math.round(ttlHours * 1e4))) / (BigInt(8760 * 1e4) * 100_000_000n);
}

/**
 * Rank the catalogue against one mandate.
 *
 * Routable first, always — a live venue with a mediocre score outranks a designed one with a
 * perfect score, because only one of them is a button. Within each group, score decides.
 */
export function recommend(m: Mandate): Recommendation[] {
  const out = STRATEGIES.map((s) => {
    const on = s.liveOn.filter((id) => m.chainIds.includes(id));
    const because: string[] = [];
    let score = 50;
    let blocked: string | null = null;

    if (s.liveOn.length === 0) {
      blocked = "no deployment on any chain this dashboard reaches";
    } else if (on.length === 0) {
      blocked = `deployed, but not on the ${m.chainIds.length === 0 ? "chains this mandate covers" : "chains the client signed for"}`;
    } else if (m.ttlHours > 0 && m.ttlHours < s.minHours) {
      blocked = `the mandate expires in ${m.ttlHours}h and this needs at least ${s.minHours}h`;
    } else if (m.capUnits > 0n && m.capUnits < s.minUnits) {
      blocked = "the cap is too small to be worth the gas";
    } else if (m.capUnits === 0n || m.ttlHours === 0) {
      blocked = "the client has not signed terms yet";
    }

    if (on.length > 0) {
      score += 20;
      because.push(`live on ${on.length} of the ${m.chainIds.length || "—"} chains signed`);
    }
    if (s.apy !== null) {
      score += 15;
      because.push(`a measured rate to quote (${(s.apy * 100).toFixed(2)}%)`);
    } else {
      because.push("no rate can be honestly quoted");
    }
    if (m.ttlHours >= s.minHours * 4) {
      score += 10;
      because.push("the mandate outlives the position comfortably");
    }
    if (m.capUnits >= s.minUnits * 10n) {
      score += 5;
      because.push("size is well clear of the gas floor");
    }
    score -= Math.min(15, s.risks.length * 5);

    return {
      strategy: s,
      routable: blocked === null,
      on: blocked === null ? on : [],
      score: Math.max(0, Math.min(100, score)),
      because,
      blocked,
      projectedUnits: projectUnits(m.capUnits, s.apy, m.ttlHours),
    };
  });

  return out.sort((a, b) => Number(b.routable) - Number(a.routable) || b.score - a.score);
}
