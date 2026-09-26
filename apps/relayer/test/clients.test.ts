import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ClientError, Clients } from "../src/clients.js";

const OWNER = "0x9673afB923d556979E4dfe6854d8C6e2D9994Eb4";
const OTHER = "0xd72f799E1af27E0d95aB4B9658A277A7811Fbcd0";

const fresh = () => new Clients(new Database(":memory:"));

const valid = {
  name: "Meridian Capital",
  mandate: "USDC yield, three chains",
  capUnits: "250000000000",
  ttlHours: 720,
  chainIds: [84532, 11155420, 11155111],
};

const rejectMessage = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ClientError) return e.message;
    return `wrong error type: ${String(e)}`;
  }
  return "no error thrown";
};

describe("client mandates", () => {
  test("a created mandate is awaiting, not active", () => {
    const c = fresh().create(valid);
    expect(c.status).toBe("awaiting");
    expect(c.owner).toBeNull();
    expect(c.token).toMatch(/^[0-9a-f]{32}$/);
    expect(c.chainIds).toEqual(valid.chainIds);
  });

  test("the cap survives as an exact string past 2^53", () => {
    // 9_007_199_254_740_993 is the first integer a double cannot represent. A cap that round-trips
    // through a JS number comes back one unit short, which is a different mandate.
    const big = "9007199254740993";
    expect(fresh().create({ ...valid, capUnits: big }).capUnits).toBe(big);
  });

  test("bad input is refused rather than coerced", () => {
    const c = fresh();
    expect(rejectMessage(() => c.create({ ...valid, name: "   " }))).toContain("name is required");
    expect(rejectMessage(() => c.create({ ...valid, capUnits: "0" }))).toContain("positive integer");
    expect(rejectMessage(() => c.create({ ...valid, capUnits: "12.5" }))).toContain("positive integer");
    expect(rejectMessage(() => c.create({ ...valid, ttlHours: 0 }))).toContain("between 1 and 8760");
    expect(rejectMessage(() => c.create({ ...valid, chainIds: [] }))).toContain("non-empty");
  });

  test("duplicate chain ids collapse", () => {
    expect(fresh().create({ ...valid, chainIds: [84532, 84532, 11155111] }).chainIds).toEqual([84532, 11155111]);
  });

  test("only the first claim on a link wins", () => {
    const c = fresh();
    const { token } = c.create(valid);

    expect(c.link(token, OWNER, "intent-1")?.status).toBe("active");
    // The second caller must get nothing back, not a row silently repointed at their address.
    expect(c.link(token, OTHER, "intent-2")).toBeNull();
    expect(c.get(token)?.owner).toBe(OWNER);
  });

  test("a withdrawn invitation cannot then be claimed", () => {
    const c = fresh();
    const { token } = c.create(valid);

    expect(c.revoke(token)?.status).toBe("revoked");
    expect(c.link(token, OWNER, "intent-1")).toBeNull();
    // Withdrawing twice is not an error the desk should act on, but it is not a second withdrawal.
    expect(c.revoke(token)).toBeNull();
  });

  test("revoking does not pretend the client's on-chain allowance is gone", () => {
    const c = fresh();
    const { token } = c.create(valid);
    c.link(token, OWNER, "intent-1");
    const after = c.revoke(token);

    expect(after?.status).toBe("revoked");
    // The binding is kept on purpose: the desk still has to be able to see whose authority is live
    // so it can go and LOCK it.
    expect(after?.owner).toBe(OWNER);
    expect(after?.intentId).toBe("intent-1");
  });

  test("tokens do not repeat", () => {
    const c = fresh();
    const tokens = new Set(Array.from({ length: 200 }, () => c.create(valid).token));
    expect(tokens.size).toBe(200);
  });

  test("an unknown link reads as missing, not as an empty mandate", () => {
    expect(fresh().get("0".repeat(32))).toBeNull();
  });
});
