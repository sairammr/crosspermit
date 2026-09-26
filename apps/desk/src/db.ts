// Every table this layer owns. Five of them, in one file, created on open.
//
// The relayer keeps its own database and this one never touches it: a client mandate lives upstream,
// and what lives here is only the fact that some manager created it. That split is deliberate — the
// relayer can be redeployed, or replaced by someone else's, without taking the tenancy with it.
import { Database } from "bun:sqlite";

export type Manager = { address: string; name: string; createdAt: number };
export type Desk = { manager: string; chainId: number; desk: string };

export function open(path = process.env.DESK_DB ?? "desk.sqlite"): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
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
  `);
  return db;
}

/** Addresses are compared, never displayed, at this layer. One canonical form removes the question. */
export const key = (address: string) => address.toLowerCase();
