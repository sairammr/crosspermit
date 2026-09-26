// Every table this layer owns. Five of them, in one file, created on first use.
//
// The relayer keeps its own database and this one never touches it: a client mandate lives upstream,
// and what lives here is only the fact that some manager created it. That split is deliberate — the
// relayer can be redeployed, or replaced by someone else's, without taking the tenancy with it.
//
// libSQL rather than `bun:sqlite`, because the same client speaks both `file:` and a remote Turso
// URL. Locally that is a plain SQLite file next to the repo and there is nothing to set up; on a
// host with no durable filesystem, set TURSO_DATABASE_URL and the only thing that changes is where
// the bytes land.
import { type Client, createClient } from "@libsql/client";

export type Manager = { address: string; name: string; createdAt: number };
export type Desk = { manager: string; chainId: number; desk: string };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS managers (
    address   TEXT PRIMARY KEY,   -- lowercase, checksum is a display concern
    name      TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  -- A manager's own LiquidityDesk deployment, per chain. This is the whole of item 4's fix:
  -- the spender address IS the manager's identity on chain, so recording which address belongs
  -- to whom is what lets an allowance be attributed, or flagged as belonging to nobody here.
  CREATE TABLE IF NOT EXISTS desks (
    manager TEXT NOT NULL,
    chainId INTEGER NOT NULL,
    desk    TEXT NOT NULL,
    PRIMARY KEY (manager, chainId)
  );

  -- Which manager created which upstream mandate. The mandate itself stays upstream.
  CREATE TABLE IF NOT EXISTS client_links (
    token     TEXT PRIMARY KEY,
    manager   TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS client_links_manager ON client_links(manager);

  -- Challenges. Single use, short lived, and deleted rather than marked: a used nonce that is
  -- still in the table is one bad query away from being reusable.
  CREATE TABLE IF NOT EXISTS nonces (
    nonce     TEXT PRIMARY KEY,
    address   TEXT NOT NULL,
    -- The issue time is part of the signed text, so it has to come back at verify time. Rebuilding
    -- the challenge from the clock instead is a message that can never be reproduced.
    issuedAt  INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id        TEXT PRIMARY KEY,
    address   TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );
`;

/**
 * One client per process, and the schema applied once against it.
 *
 * Kept as the promise rather than the client so that concurrent first requests on a cold start wait
 * on the same `executeMultiple` instead of racing five `CREATE TABLE`s each.
 */
let opening: Promise<Client> | null = null;

/** No TURSO_DATABASE_URL means running locally, where a SQLite file is the whole of the setup. */
const LOCAL_FILE = "file:.desk.db";

/**
 * …which is true on a laptop and false on a serverless host, where the filesystem is read only.
 *
 * Left as a fallback there, the first `CREATE TABLE` fails somewhere inside libSQL on whichever
 * request happened to be first, and the operator reads an EROFS rather than the one sentence that
 * fixes it. Said here instead, at the first touch of the store, in words.
 */
export const configError =
  (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) && !process.env.TURSO_DATABASE_URL
    ? "TURSO_DATABASE_URL is not set. This host has a read-only filesystem, so the local SQLite fallback cannot be created: point TURSO_DATABASE_URL, and TURSO_AUTH_TOKEN, at a Turso database."
    : null;

if (configError) console.error(`crosspermit-desk: ${configError}`);

export function open(
  url = process.env.TURSO_DATABASE_URL || LOCAL_FILE,
  authToken = process.env.TURSO_AUTH_TOKEN,
): Promise<Client> {
  if (configError && url === LOCAL_FILE) throw new Error(configError);
  if (!opening) {
    const client = createClient({ url, authToken });
    opening = client.executeMultiple(SCHEMA).then(() => client);
  }
  return opening;
}

/** Used by the tests to point this at a throwaway database, and to forget the previous one. */
export function reset(url?: string, authToken?: string): Promise<Client> {
  opening = null;
  return open(url, authToken);
}

export async function all<T>(sql: string, args: unknown[] = []): Promise<T[]> {
  const db = await open();
  const res = await db.execute({ sql, args: args as never[] });
  return res.rows as unknown as T[];
}

export async function get<T>(sql: string, args: unknown[] = []): Promise<T | undefined> {
  return (await all<T>(sql, args))[0];
}

export async function run(sql: string, args: unknown[] = []): Promise<void> {
  const db = await open();
  await db.execute({ sql, args: args as never[] });
}

/** Addresses are compared, never displayed, at this layer. One canonical form removes the question. */
export const key = (address: string) => address.toLowerCase();
