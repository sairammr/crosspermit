/**
 * Chart series, folded from records the control plane actually holds.
 *
 * No smoothing, no interpolation between made-up points, no "projected" line. Every series here is
 * a step function over events that happened, because the moment a treasury chart invents a point
 * it stops being evidence and starts being decoration.
 *
 * Pure, so `series.test.ts` can hold it to that.
 */

export type Act = {
  chainId: number;
  kind: "granted" | "locked" | "cleared" | "cancelled";
  /** The timestamp the owner signed, which is the ordering CrossPermit applies. */
  timestamp?: number;
  amount?: string;
  token?: string;
};

export type Point = { t: number; v: number };

/** How many decimals a token carries. Defaults to 6 — the only assumption this file used to make. */
export type Decimals = (token?: string) => number;
const SIX: Decimals = () => 6;

/**
 * Authority outstanding over time, in token units.
 *
 * A grant sets the (token, chain) pair's amount — it does not add to it, because each `Permit`
 * event carries the resulting allowance, not a delta. A lock or a clear takes it to zero. The
 * series is the sum across pairs after each event, which is the only number a risk committee ever
 * asks for: how much authority was outstanding at time T.
 *
 * `decimals` exists because this file used to divide every amount by 1e6. That held exactly as
 * long as every token in the book was USDC; the first 18-decimal token made the total 1e12 too
 * large and the chart a solid block. Pass a resolver, and note that summing across tokens is only
 * meaningful when they are the same asset — `token` is how a caller keeps it that way.
 */
export function authorityOverTime(acts: Act[], token?: string, decimals: Decimals = SIX): Point[] {
  const rows = acts
    .filter((a) => a.timestamp && (!token || a.token?.toLowerCase() === token.toLowerCase()))
    .sort((a, b) => a.timestamp! - b.timestamp!);

  const held = new Map<string, number>();
  const out: Point[] = [];

  for (const a of rows) {
    const key = `${a.chainId}:${(a.token ?? "").toLowerCase()}`;
    if (a.kind === "granted") held.set(key, Number(a.amount ?? 0) / 10 ** decimals(a.token));
    else if (a.kind === "locked" || a.kind === "cleared") held.set(key, 0);
    else continue; // a burned salt retracts an unsubmitted permit; nothing outstanding changed
    let total = 0;
    for (const v of held.values()) total += v;
    // Two events in the same signature share a timestamp. Keep the last state at that instant
    // rather than drawing a spurious step between them.
    if (out.length && out[out.length - 1]!.t === a.timestamp) out[out.length - 1]!.v = total;
    else out.push({ t: a.timestamp!, v: total });
  }
  return out;
}

/** Totals per chain, for a bar row. Keys are chain ids in the order given. */
export function perChain(acts: Act[], chainIds: number[], decimals: Decimals = SIX): number[] {
  return chainIds.map((id) => {
    const held = new Map<string, number>();
    for (const a of acts.filter((x) => x.chainId === id).sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0))) {
      const key = (a.token ?? "").toLowerCase();
      if (a.kind === "granted") held.set(key, Number(a.amount ?? 0) / 10 ** decimals(a.token));
      else if (a.kind === "locked" || a.kind === "cleared") held.set(key, 0);
    }
    let total = 0;
    for (const v of held.values()) total += v;
    return total;
  });
}

/**
 * Resample a step series onto `n` evenly spaced points so a chart can draw it.
 *
 * Step, not linear: authority does not ramp between two signatures, it jumps at one of them. A
 * linear interpolation would draw a client as half-authorised for hours they were fully
 * authorised, which is the wrong direction to be wrong in.
 */
export function resample(points: Point[], n = 64): number[] {
  if (points.length === 0) return [];
  if (points.length === 1) return Array(n).fill(points[0]!.v);
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = t1 - t0 || 1;
  const out: number[] = [];
  let i = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + (span * k) / (n - 1);
    while (i + 1 < points.length && points[i + 1]!.t <= t) i++;
    out.push(points[i]!.v);
  }
  return out;
}

/** How much of each granted allowance has been spent, as a 0–1 fraction per row. */
export function consumption(rows: { granted: number; remaining?: number }[]): number[] {
  return rows.map((r) => {
    if (r.granted <= 0 || r.remaining === undefined) return 0;
    return Math.min(1, Math.max(0, 1 - r.remaining / r.granted));
  });
}
