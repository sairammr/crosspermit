// Assign existing upstream mandates to a manager.
//
// The relayer predates this layer, so its mandates have no manager and are therefore in nobody's
// book — visible to no session at all. This is the one-time migration for that.
//
// Deliberately a script and not an HTTP route: claiming a mandate you did not create is exactly the
// privilege this layer exists to withhold, so it is held by whoever already holds the relayer's API
// key rather than by anyone who can sign a message.
//
//   bun apps/desk/scripts/import.ts <manager-address> [--name "Desk name"] [--all|--token <t>…]
//
// Idempotent: a token already claimed by this manager is left alone, one claimed by someone else is
// reported and skipped rather than reassigned.
import { isAddress } from "viem";

import { key, open } from "../src/db.js";
import * as upstream from "../src/upstream.js";

const args = process.argv.slice(2);
const manager = args[0];
if (!manager || !isAddress(manager, { strict: false })) {
  console.error("usage: bun apps/desk/scripts/import.ts <manager-address> [--name \"…\"] [--all|--token <t>…]");
  process.exit(1);
}

const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const tokens = args.flatMap((a, i) => (a === "--token" && args[i + 1] ? [args[i + 1]!] : []));
const all = args.includes("--all");
if (!all && tokens.length === 0) {
  console.error("nothing to import: pass --all, or --token <token> one or more times");
  process.exit(1);
}

const db = open();
const addr = key(manager);
const name = flag("name") ?? "";
db.query("INSERT OR IGNORE INTO managers (address,name,createdAt) VALUES (?,?,?)").run(addr, name, Date.now());
if (name) db.query("UPDATE managers SET name = ? WHERE address = ?").run(name, addr);

const wanted: string[] = all
  ? (await upstream.call<{ clients: { token: string }[] }>("/v1/clients?limit=1000")).clients.map((c) => c.token)
  : tokens;

let claimed = 0;
let already = 0;
const conflicts: string[] = [];

for (const token of wanted) {
  const row = db.query("SELECT manager FROM client_links WHERE token = ?").get(token) as { manager: string } | undefined;
  if (row?.manager === addr) {
    already++;
    continue;
  }
  if (row) {
    conflicts.push(`${token} → ${row.manager}`);
    continue;
  }
  db.query("INSERT INTO client_links (token,manager,createdAt) VALUES (?,?,?)").run(token, addr, Date.now());
  claimed++;
}

console.log(`manager ${addr}${name ? ` (${name})` : ""}`);
console.log(`  claimed ${claimed}, already theirs ${already}, held by someone else ${conflicts.length}`);
for (const c of conflicts) console.log(`    skipped ${c}`);
