// Proof of ownership, and what a proof buys.
//
// The only identity this layer trusts is a signature over a challenge it issued. No passwords, no
// API keys handed to browsers, no address typed into a URL. A session is a receipt for one such
// signature and nothing more — everything about what it may READ is decided per request, in
// `scope.ts`, against the tables.
import { isAddress, verifyMessage } from "viem";

import { get, key, type Manager, run } from "./db";

export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 24 * 3_600_000;
export const COOKIE = "desk_session";

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * The exact bytes the wallet is asked to sign.
 *
 * Says what it is for and, in the last line, what it is not for. A signing prompt that only shows
 * hex is how people learn to approve anything, and this one costs a client nothing — so it should
 * read like it.
 */
export function challenge(address: string, nonce: string, issued: Date): string {
  return [
    "crosspermit-desk wants you to sign in.",
    "",
    `address: ${address}`,
    `nonce:   ${nonce}`,
    `issued:  ${issued.toISOString()}`,
    "",
    "Signing proves you hold this key. It grants nothing, moves nothing and costs no gas.",
  ].join("\n");
}

export async function issueNonce(address: string, now = Date.now()): Promise<{ nonce: string; message: string }> {
  if (!isAddress(address)) throw new AuthError("bad_address", "address is not an address");
  const nonce = crypto.randomUUID().replace(/-/g, "");
  await run("INSERT INTO nonces (nonce,address,issuedAt,expiresAt) VALUES (?,?,?,?)", [
    nonce,
    key(address),
    now,
    now + NONCE_TTL_MS,
  ]);
  // Sweep here rather than on a timer: the table is only ever read by nonce, so the only cost of a
  // stale row is disk, and a timer is a process that can stop without anyone noticing.
  await run("DELETE FROM nonces WHERE expiresAt < ?", [now]);
  return { nonce, message: challenge(address, nonce, new Date(now)) };
}

/**
 * Burn a nonce and return the address it was issued to.
 *
 * Deleted conditionally, in one statement, so two requests racing the same nonce cannot both spend
 * it. The delete happens BEFORE the signature is checked: a nonce presented with a bad signature is
 * spent anyway, because letting it survive turns a failed attempt into an unlimited number of them.
 */
export async function burnNonce(nonce: string, now = Date.now()): Promise<{ address: string; issuedAt: number }> {
  const row = await get<{ address: string; issuedAt: number; expiresAt: number }>(
    "SELECT address, issuedAt, expiresAt FROM nonces WHERE nonce = ?",
    [nonce],
  );
  await run("DELETE FROM nonces WHERE nonce = ?", [nonce]);
  if (!row) throw new AuthError("unknown_nonce", "that challenge was never issued, or has already been used", 401);
  if (row.expiresAt < now) throw new AuthError("expired_nonce", "that challenge has expired; ask for another", 401);
  return { address: row.address, issuedAt: row.issuedAt };
}

/**
 * Verify a signed challenge and open a session.
 *
 * `verifyMessage` covers contract accounts too when given a client, but this layer has no chain
 * connection of its own and a desk operator holding a Safe can sign with an owner key — so EOA
 * recovery is all that is offered, and the refusal says which case it is.
 */
export async function signIn(
  input: { address: string; nonce: string; signature: string },
  now = Date.now(),
): Promise<{ sessionId: string; address: string; manager: Manager }> {
  if (!isAddress(input.address)) throw new AuthError("bad_address", "address is not an address");
  const issued = await burnNonce(String(input.nonce), now);
  if (issued.address !== key(input.address)) {
    throw new AuthError("wrong_address", "that challenge was issued to a different address", 401);
  }

  // Rebuilt from the stored issue time, not from the clock: the text the wallet signed is the text
  // that was handed out, and the signature only reproduces if this is byte-identical.
  const message = challenge(input.address, String(input.nonce), new Date(issued.issuedAt));
  const ok = await verifyMessage({
    address: input.address,
    message,
    signature: input.signature as `0x${string}`,
  }).catch(() => false);
  // The client never sends the text back; it is rebuilt here from what was issued. A mismatch is
  // therefore a bad signature or the wrong key, and neither deserves a distinguishing error.
  if (!ok) throw new AuthError("bad_signature", "that signature does not recover to this address", 401);

  const manager = await upsertManager(input.address, now);
  const sessionId = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await run("INSERT INTO sessions (id,address,expiresAt) VALUES (?,?,?)", [sessionId, manager.address, now + SESSION_TTL_MS]);
  await run("DELETE FROM sessions WHERE expiresAt < ?", [now]);
  return { sessionId, address: manager.address, manager };
}

/**
 * Anyone who proves an address gets a row.
 *
 * ponytail: self-serve tenancy, no invite gating. Holding a row grants nothing on its own — a
 * manager with no clients can read nothing but their own exposure. Gate signup here if the desk
 * ever needs to be a closed set.
 */
export async function upsertManager(address: string, now = Date.now()): Promise<Manager> {
  const addr = key(address);
  await run("INSERT OR IGNORE INTO managers (address,name,createdAt) VALUES (?,?,?)", [addr, "", now]);
  return (await get<Manager>("SELECT * FROM managers WHERE address = ?", [addr]))!;
}

export async function session(cookieHeader: string | null, now = Date.now()): Promise<string | null> {
  const id = readCookie(cookieHeader, COOKIE);
  if (!id) return null;
  const row = await get<{ address: string; expiresAt: number }>("SELECT address, expiresAt FROM sessions WHERE id = ?", [id]);
  if (!row) return null;
  if (row.expiresAt < now) {
    await run("DELETE FROM sessions WHERE id = ?", [id]);
    return null;
  }
  return row.address;
}

export async function signOut(cookieHeader: string | null): Promise<void> {
  const id = readCookie(cookieHeader, COOKIE);
  if (id) await run("DELETE FROM sessions WHERE id = ?", [id]);
}

/** Only the one cookie matters, so this reads that one rather than parsing the whole header. */
export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name && rest.length) return rest.join("=");
  }
  return null;
}

/**
 * `SameSite=Lax` and `HttpOnly`, and `Secure` unless explicitly told this is plain-http local dev.
 *
 * HttpOnly because a session here can read a client's whole exposure, and a page that can read its
 * own cookie hands that to any script it ever loads.
 */
export const setCookie = (id: string, maxAgeMs = SESSION_TTL_MS) =>
  [
    `${COOKIE}=${id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    process.env.DESK_INSECURE_COOKIE === "1" ? "" : "Secure",
  ]
    .filter(Boolean)
    .join("; ");

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
