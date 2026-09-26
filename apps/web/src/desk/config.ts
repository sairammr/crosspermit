// What this layer has to be told, because nothing it talks to publishes it.
//
// Routers are the one case. The relayer's `/v1/chains` names chains, signers and audit coverage but
// not the Universal Router on each — that lives in the dashboard's own config. A swap mandate's
// spender IS a router, so without these every swap allowance would be flagged `unknown`, and a
// screen that cries wolf on every row is a screen nobody reads.

export type Routers = Record<number, string>;

/**
 * Base / OP / Ethereum Sepolia routers, as deployed by the crosspermit lifecycle script.
 *
 * Overridable with `DESK_ROUTERS` as JSON. Defaults are here rather than required because a desk
 * running against the reference deployment should not have to restate it — and a WRONG default is
 * loud (a real router shows as `unknown`) rather than quiet (a stranger shows as trusted).
 */
const DEFAULT_ROUTERS: Routers = {
  84532: "0x73ed10744987B65fAf6BD6FFdF1039Cb7eF97002",
  11155420: "0x2E03912851a0e442C77Ce00506aA7664E45560Ac",
  11155111: "0x7B68d6740C5C66967271966E62fd1A3E01743E3c",
};

export function routers(env: Record<string, string | undefined> = process.env): Routers {
  if (!env.DESK_ROUTERS) return DEFAULT_ROUTERS;
  try {
    const parsed = JSON.parse(env.DESK_ROUTERS) as Record<string, string>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [Number(k), v]));
  } catch {
    throw new Error("DESK_ROUTERS must be JSON of the form {\"84532\":\"0x…\"}");
  }
}
