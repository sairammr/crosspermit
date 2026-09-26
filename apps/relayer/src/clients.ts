// Client mandates: the desk's side of "add a client, send them a link".
//
// A mandate is an *invitation*, not authority. Nothing here can move a token or grant an allowance;
// it is a record of what the desk intends to ask for, addressed to one client, so the page they
// open can render the request and their wallet can sign it. The authority is created only when the
// client signs, on chain, and this table then records which owner answered which invitation.
//
// That separation is why the token in the URL is not a credential in the usual sense: whoever holds
// it can *read* an offer and *sign their own* permission. It cannot be replayed into anyone else's
// funds, and losing it costs the client nothing they had not already agreed to be asked for.
import { Database } from "bun:sqlite";

export type ClientRow = {
  token: string;
  name: string;
  mandate: string;
  /** Per-chain allowance cap, in the token's smallest unit, as a decimal string. */
  capUnits: string;
  ttlHours: number;
  /** JSON array of chain ids the desk is asking to operate on. */
  chainIds: string;
  owner: string | null;
  intentId: string | null;
  createdAt: number;
  linkedAt: number | null;
  revokedAt: number | null;
};

export type ClientView = Omit<ClientRow, "chainIds"> & { chainIds: number[]; status: ClientStatus };
export type ClientStatus = "awaiting" | "active" | "revoked";

const MAX_NAME = 120;
const MAX_MANDATE = 400;

export class Clients {
  constructor(private readonly db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        token     TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        mandate   TEXT NOT NULL,
        capUnits  TEXT NOT NULL,
        ttlHours  INTEGER NOT NULL,
        chainIds  TEXT NOT NULL,
        owner     TEXT,
        intentId  TEXT,
        createdAt INTEGER NOT NULL,
        linkedAt  INTEGER,
        revokedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS clients_created ON clients(createdAt DESC);
    `);
  }

  /**
   * Validate and store one invitation.
   *
   * Throws on bad input rather than coercing it. A mandate whose cap silently became 0, or whose
   * chain list silently lost a chain, is a document the desk would later show a client as though
   * they had agreed to it.
   */
  create(input: Record<string, unknown>): ClientView {
    const name = text(input.name, "name", MAX_NAME);
    const mandate = text(input.mandate, "mandate", MAX_MANDATE);

    // Kept as a string end to end. The cap is a token amount in base units and can exceed 2^53;
    // parsing it to a JS number to "check" it is how a 6-decimal cap quietly changes value.
    const capUnits = String(input.capUnits ?? "").trim();
    if (!/^[0-9]{1,30}$/.test(capUnits) || capUnits === "0") {
      throw new ClientError("cap must be a positive integer in the token's base units");
    }

    const ttlHours = Number(input.ttlHours);
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 8760) {
      throw new ClientError("ttlHours must be a whole number of hours between 1 and 8760");
    }

    const chainIds = Array.isArray(input.chainIds) ? input.chainIds.map(Number) : [];
    if (!chainIds.length || chainIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new ClientError("chainIds must be a non-empty array of chain ids");
    }

    const row: ClientRow = {
      // 128 bits from the platform CSPRNG. Guessable tokens would let anyone enumerate the desk's
      // client list, which is itself confidential even though it grants nothing.
      token: crypto.randomUUID().replace(/-/g, ""),
      name,
      mandate,
      capUnits,
      ttlHours,
      chainIds: JSON.stringify([...new Set(chainIds)]),
      owner: null,
      intentId: null,
      createdAt: Date.now(),
      linkedAt: null,
      revokedAt: null,
    };

    this.db
      .query(
        "INSERT INTO clients (token,name,mandate,capUnits,ttlHours,chainIds,owner,intentId,createdAt,linkedAt,revokedAt)" +
          " VALUES (?,?,?,?,?,?,NULL,NULL,?,NULL,NULL)",
      )
      .run(row.token, row.name, row.mandate, row.capUnits, row.ttlHours, row.chainIds, row.createdAt);

    return view(row);
  }

  get(token: string): ClientView | null {
    const row = this.db.query("SELECT * FROM clients WHERE token = ?").get(token) as ClientRow | undefined;
    return row ? view(row) : null;
  }

  list(limit = 100): ClientView[] {
    return (this.db.query("SELECT * FROM clients ORDER BY createdAt DESC LIMIT ?").all(limit) as ClientRow[]).map(view);
  }

  /**
   * Bind the owner who answered an invitation.
   *
   * Conditional on the mandate still being unlinked and unrevoked, in one statement, so two clients
   * racing the same link cannot both claim it — the desk would otherwise show one name against
   * another account's funds.
   */
  link(token: string, owner: string, intentId: string): ClientView | null {
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new ClientError("owner must be an address");
    const res = this.db
      .query("UPDATE clients SET owner=?, intentId=?, linkedAt=? WHERE token=? AND owner IS NULL AND revokedAt IS NULL")
      .run(owner, intentId, Date.now(), token);
    if (res.changes === 0) return null;
    return this.get(token);
  }

  /**
   * Withdraw an invitation.
   *
   * This is the *link* being withdrawn, not the allowance. An allowance the client already signed
   * is on chain and is retracted by a cross-chain LOCK, which is a different act entirely — so the
   * response says so rather than letting the desk believe a revoked row means closed exposure.
   */
  revoke(token: string): ClientView | null {
    const res = this.db.query("UPDATE clients SET revokedAt=? WHERE token=? AND revokedAt IS NULL").run(Date.now(), token);
    if (res.changes === 0) return null;
    return this.get(token);
  }
}

export class ClientError extends Error {
  readonly code = "invalid_mandate";
}

function text(value: unknown, field: string, max: number): string {
  const s = String(value ?? "").trim();
  if (!s) throw new ClientError(`${field} is required`);
  if (s.length > max) throw new ClientError(`${field} must be ${max} characters or fewer`);
  return s;
}

function view(row: ClientRow): ClientView {
  return {
    ...row,
    chainIds: JSON.parse(row.chainIds) as number[],
    status: row.revokedAt ? "revoked" : row.owner ? "active" : "awaiting",
  };
}
