// Durable state, one row per (intent, chain).
//
// A relayer that keeps fan-out state only in memory double-submits after a restart: the client
// retries, the relayer has no record, and the owner pays twice for an allowance they granted once.
// bun:sqlite is built in, so this costs no dependency.
import { Database } from "bun:sqlite";
import type { Hex } from "viem";

export type LegStatus = "pending" | "submitting" | "submitted" | "confirmed" | "failed";

export type LegRow = {
  intentId: string;
  chainId: number;
  status: LegStatus;
  txHash: Hex | null;
  error: string | null;
  attempts: number;
  updatedAt: number;
};

export type IntentRow = {
  intentId: string;
  owner: string;
  root: string;
  salt: string;
  deadline: number;
  payload: string;
  createdAt: number;
};

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        intentId  TEXT PRIMARY KEY,
        owner     TEXT NOT NULL,
        root      TEXT NOT NULL,
        salt      TEXT NOT NULL,
        deadline  INTEGER NOT NULL,
        payload   TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legs (
        intentId  TEXT NOT NULL,
        chainId   INTEGER NOT NULL,
        status    TEXT NOT NULL,
        txHash    TEXT,
        error     TEXT,
        attempts  INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (intentId, chainId)
      );
      CREATE INDEX IF NOT EXISTS legs_status ON legs(status);
    `);
  }

  /**
   * Record an intent and its legs, but only if it is new.
   *
   * Returns false when the intent id already exists, which is the whole idempotency story: the same
   * signed intent submitted twice is answered from state rather than broadcast again. The insert and
   * the check are one transaction, so two concurrent POSTs cannot both win.
   */
  create(intent: IntentRow, chainIds: number[]): boolean {
    const tx = this.db.transaction(() => {
      const existing = this.db.query("SELECT intentId FROM intents WHERE intentId = ?").get(intent.intentId);
      if (existing) return false;
      this.db
        .query("INSERT INTO intents (intentId, owner, root, salt, deadline, payload, createdAt) VALUES (?,?,?,?,?,?,?)")
        .run(intent.intentId, intent.owner, intent.root, intent.salt, intent.deadline, intent.payload, intent.createdAt);
      const ins = this.db.query(
        "INSERT INTO legs (intentId, chainId, status, txHash, error, attempts, updatedAt) VALUES (?,?,'pending',NULL,NULL,0,?)",
      );
      for (const chainId of chainIds) ins.run(intent.intentId, chainId, Date.now());
      return true;
    });
    return tx() as boolean;
  }

  /**
   * Move a leg to `submitting`, but only from `pending` or `failed`.
   *
   * The conditional UPDATE is the lock: whoever's statement changes a row owns that leg. Two workers
   * racing the same leg cannot both proceed, which is what keeps a restart mid-fan-out from
   * submitting a second transaction for a leg that already has one in flight.
   */
  claim(intentId: string, chainId: number): boolean {
    const res = this.db
      .query(
        "UPDATE legs SET status='submitting', attempts = attempts + 1, updatedAt=? " +
          "WHERE intentId=? AND chainId=? AND status IN ('pending','failed')",
      )
      .run(Date.now(), intentId, chainId);
    return res.changes > 0;
  }

  finish(intentId: string, chainId: number, status: LegStatus, txHash: Hex | null, error: string | null): void {
    this.db
      .query("UPDATE legs SET status=?, txHash=?, error=?, updatedAt=? WHERE intentId=? AND chainId=?")
      .run(status, txHash, error, Date.now(), intentId, chainId);
  }

  legs(intentId: string): LegRow[] {
    return this.db.query("SELECT * FROM legs WHERE intentId = ? ORDER BY chainId").all(intentId) as LegRow[];
  }

  intent(intentId: string): IntentRow | null {
    return (this.db.query("SELECT * FROM intents WHERE intentId = ?").get(intentId) as IntentRow) ?? null;
  }

  /**
   * Legs left mid-flight by a crash: `submitting` with nothing recorded.
   *
   * Deliberately NOT auto-retried on boot. A leg in `submitting` may well have a transaction in the
   * mempool that this process never saw the hash for, and resubmitting it blind is how one signed
   * allowance becomes two on-chain. Surface them for an operator instead.
   */
  stranded(olderThanMs = 120_000): LegRow[] {
    return this.db
      .query("SELECT * FROM legs WHERE status='submitting' AND updatedAt < ?")
      .all(Date.now() - olderThanMs) as LegRow[];
  }

  /**
   * The underlying handle, so sibling tables live in the same file and the same WAL.
   *
   * A second `Database` on the same path would work, but then a mandate and the intent that
   * answered it could be committed by different connections — and the pair either both exist or
   * the desk is showing a client a link to authority nobody recorded.
   */
  get database(): Database {
    return this.db;
  }

  recent(limit = 50): IntentRow[] {
    return this.db.query("SELECT * FROM intents ORDER BY createdAt DESC LIMIT ?").all(limit) as IntentRow[];
  }

  close() {
    this.db.close();
  }
}
