// Who may read what, and what a spender address means.
//
// Pure on purpose. Every refusal this layer makes is one of these functions returning false, so the
// rules are readable in one screen and testable without a server, a database or a chain.

export type Bound = { token: string; owner: string | null };

export type SpenderKind =
  /** This manager's own LiquidityDesk on this chain. The only spender a mandate of theirs should name. */
  | "mine"
  /** A router this platform publishes. Expected for swap mandates; not a liquidity desk. */
  | "router"
  /** A desk registered here, belonging to someone else. The allowance is real and is not yours. */
  | "other_desk"
  /** Nothing here knows this address. The single most important row on the page. */
  | "unknown";

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * May `caller` read the exposure of `owner`?
 *
 * Two ways in, and no third: it is your own address, or it is an owner who answered one of your
 * mandates. Note what is NOT a way in — knowing the address. That is the hole this closes
 * (`server.ts:127` upstream takes an owner in the path and asks nothing).
 */
export function canReadOwner(caller: string, owner: string, bound: Bound[]): boolean {
  if (eq(caller, owner)) return true;
  return bound.some((b) => eq(b.owner, owner));
}

/** May `caller` read this mandate? Theirs to manage, or theirs to have signed. */
export function canReadMandate(caller: string, mandate: { owner: string | null }, isMine: boolean): boolean {
  return isMine || eq(mandate.owner, caller);
}

/**
 * Name a spender, from this manager's point of view.
 *
 * `myDesks` and `otherDesks` come from the desk registry, `routers` from the platform. The default
 * is `unknown` rather than anything reassuring: an allowance to an address nobody here can name is
 * the row that needs reading, and it must not be able to hide behind a friendly label.
 */
export function classifySpender(
  spender: string,
  known: { myDesks: string[]; otherDesks: { desk: string; manager: string }[]; routers: string[] },
): { kind: SpenderKind; label: string; manager?: string } {
  if (known.myDesks.some((d) => eq(d, spender))) return { kind: "mine", label: "your liquidity desk" };
  if (known.routers.some((r) => eq(r, spender))) return { kind: "router", label: "execution router" };
  const other = known.otherDesks.find((d) => eq(d.desk, spender));
  if (other) return { kind: "other_desk", label: "another manager's liquidity desk", manager: other.manager };
  return { kind: "unknown", label: "unrecognised spender" };
}

/**
 * Does this client's on-chain authority match what it was supposed to be?
 *
 * The check item 4 needs from outside the contracts. A client who signed a writ naming a shared desk
 * deployment has, in fact, authorised every manager on it — nothing off-chain can undo that. What
 * this can do is refuse to let it pass unremarked: anything not `mine` and not a router is called
 * out, with the manager named where one is known.
 */
export function scopeCheck(
  rows: { chainId: number; token: string; spender: string; amount: string; expiration?: number }[],
  known: { myDesks: string[]; otherDesks: { desk: string; manager: string }[]; routers: string[] },
) {
  const named = rows.map((r) => ({ ...r, ...classifySpender(r.spender, known) }));
  const foreign = named.filter((r) => r.kind === "other_desk" || r.kind === "unknown");
  return {
    rows: named,
    foreign,
    // A count, not a boolean, because "3 allowances name a desk that is not yours" is the sentence
    // a manager needs; "not clean" is not.
    ok: foreign.length === 0,
  };
}
