// The checks that matter: a nonce cannot be spent twice, a signature must recover to the address it
// claims, and the scoping functions refuse what they are supposed to refuse.
import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import { AuthError, burnNonce, challenge, issueNonce, session, signIn, NONCE_TTL_MS } from "../src/desk/auth";
import { reset } from "../src/desk/db";
import { canReadMandate, canReadOwner, classifySpender, scopeCheck } from "../src/desk/scope";

// A throwaway libSQL database per test. `reset` forgets the previous one, so no test can see
// another's rows — the same isolation `:memory:` gave when this was bun:sqlite.
const fresh = () => reset("file::memory:");
const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const bob = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

describe("nonce", () => {
  test("is single use", async () => {
    await fresh();
    const { nonce } = await issueNonce(alice.address);
    expect((await burnNonce(nonce)).address).toBe(alice.address.toLowerCase());
    await expect(burnNonce(nonce)).rejects.toThrow(/already been used/);
  });

  test("expires", async () => {
    await fresh();
    const now = Date.now();
    const { nonce } = await issueNonce(alice.address, now);
    await expect(burnNonce(nonce, now + NONCE_TTL_MS + 1)).rejects.toThrow(/expired/);
  });

  test("is spent even when the signature is wrong, so a bad attempt cannot be repeated", async () => {
    await fresh();
    const now = Date.now();
    const { nonce, message } = await issueNonce(alice.address, now);
    const wrong = await bob.signMessage({ message });
    await expect(signIn({ address: alice.address, nonce, signature: wrong }, now)).rejects.toThrow(/does not recover/);
    // Second attempt, this time with the right key: the nonce is gone regardless.
    const right = await alice.signMessage({ message });
    await expect(signIn({ address: alice.address, nonce, signature: right }, now)).rejects.toThrow(/never issued/);
  });
});

describe("sign in", () => {
  test("a valid signature opens a session and creates the manager", async () => {
    await fresh();
    const now = Date.now();
    const { nonce, message } = await issueNonce(alice.address, now);
    expect(message).toBe(challenge(alice.address, nonce, new Date(now)));

    const out = await signIn({ address: alice.address, nonce, signature: await alice.signMessage({ message }) }, now);
    expect(out.address).toBe(alice.address.toLowerCase());
    expect(await session(`desk_session=${out.sessionId}`, now)).toBe(alice.address.toLowerCase());
    expect(await session(`desk_session=${out.sessionId}`, now + 25 * 3_600_000)).toBeNull();
    expect(await session("desk_session=nope", now)).toBeNull();
    expect(await session(null, now)).toBeNull();
  });

  test("a signature from another key over the same challenge is refused", async () => {
    await fresh();
    const now = Date.now();
    const { nonce, message } = await issueNonce(alice.address, now);
    await expect(
      signIn({ address: alice.address, nonce, signature: await bob.signMessage({ message }) }, now),
    ).rejects.toBeInstanceOf(AuthError);
  });

  test("a nonce issued to one address cannot be used by another", async () => {
    await fresh();
    const now = Date.now();
    const { nonce } = await issueNonce(alice.address, now);
    const message = challenge(bob.address, nonce, new Date(now));
    await expect(
      signIn({ address: bob.address, nonce, signature: await bob.signMessage({ message }) }, now),
    ).rejects.toThrow(/different address/);
  });
});

describe("who may read what", () => {
  const A = "0x1111111111111111111111111111111111111111";
  const B = "0x2222222222222222222222222222222222222222";
  const C = "0x3333333333333333333333333333333333333333";

  test("your own address, always", () => {
    expect(canReadOwner(A, A.toUpperCase(), [])).toBe(true);
  });

  test("a client bound to you, yes; a stranger, no", () => {
    const bound = [{ token: "t1", owner: B }];
    expect(canReadOwner(A, B, bound)).toBe(true);
    expect(canReadOwner(A, C, bound)).toBe(false);
    // The hole this closes: knowing the address is not a way in.
    expect(canReadOwner(A, C, [{ token: "t1", owner: null }])).toBe(false);
  });

  test("a mandate is readable by its manager or by the owner who signed it", () => {
    expect(canReadMandate(A, { owner: null }, true)).toBe(true);
    expect(canReadMandate(A, { owner: A }, false)).toBe(true);
    expect(canReadMandate(A, { owner: B }, false)).toBe(false);
  });
});

describe("spender classification", () => {
  const MY_DESK = "0xE666e3F7000000000000000000000000000000E1";
  const THEIR_DESK = "0x012a1236000000000000000000000000000000E2";
  const ROUTER = "0x73ed1074000000000000000000000000000000E3";
  const known = { myDesks: [MY_DESK], otherDesks: [{ desk: THEIR_DESK, manager: "0xdead" }], routers: [ROUTER] };

  test("names mine, theirs and the router, and refuses to guess at the rest", () => {
    expect(classifySpender(MY_DESK.toLowerCase(), known).kind).toBe("mine");
    expect(classifySpender(THEIR_DESK, known)).toMatchObject({ kind: "other_desk", manager: "0xdead" });
    expect(classifySpender(ROUTER, known).kind).toBe("router");
    expect(classifySpender("0x9999999999999999999999999999999999999999", known).kind).toBe("unknown");
  });

  test("scope-check flags every allowance that is not mine and not a router", () => {
    const rows = [
      { chainId: 84532, token: "0xaa", spender: MY_DESK, amount: "1" },
      { chainId: 84532, token: "0xaa", spender: ROUTER, amount: "2" },
      { chainId: 84532, token: "0xaa", spender: THEIR_DESK, amount: "3" },
      { chainId: 84532, token: "0xaa", spender: "0x9999999999999999999999999999999999999999", amount: "4" },
    ];
    const out = scopeCheck(rows, known);
    expect(out.ok).toBe(false);
    expect(out.foreign.map((f) => f.kind)).toEqual(["other_desk", "unknown"]);
    expect(scopeCheck(rows.slice(0, 2), known).ok).toBe(true);
  });
});
