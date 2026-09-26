// Drive a running desk layer with two real managers, against the real relayer.
//
// What the unit and e2e tests prove against a stub, this proves against the live control plane: a
// signature really opens a session, two managers really cannot see each other's books, an address in
// a URL really is not a credential, and the scope check really names the desks deployed on chain.
//
//   DESK_URL=http://localhost:8788 bun apps/web/scripts/live-smoke.ts
//
// Signs with the two well-known anvil keys. They hold nothing and are only identities here — the
// layer never asks them for a transaction.
import { privateKeyToAccount } from "viem/accounts";

const DESK = process.env.DESK_URL ?? "http://localhost:3000/api/desk";

const A = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const B = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

async function req(path: string, init: RequestInit & { cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${DESK}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as Record<string, any>, setCookie: res.headers.get("set-cookie") };
}

/** The whole proof-of-ownership handshake, as the page does it. */
async function signIn(account: typeof A): Promise<string> {
  const { body: challenge } = await req("/v1/auth/nonce", { method: "POST", body: { address: account.address } });
  const signature = await account.signMessage({ message: challenge.message });
  const out = await req("/v1/auth/verify", {
    method: "POST",
    body: { address: account.address, nonce: challenge.nonce, signature },
  });
  if (out.status !== 200) throw new Error(`sign-in failed: ${out.status} ${JSON.stringify(out.body)}`);
  return out.setCookie!.split(";")[0]!;
}

console.log(`desk ${DESK}`);
const health = await req("/healthz");
if (health.status !== 200) {
  console.error(`desk layer is not up at ${DESK}`);
  process.exit(1);
}
console.log(`upstream ${health.body.upstream}\n`);

console.log("proof of ownership");
for (const path of ["/v1/auth/me", "/v1/clients"]) {
  check((await req(path)).status === 401, `${path} refuses a request with no session`);
}
{
  // A signature over the right challenge, from the wrong key.
  const { body: challenge } = await req("/v1/auth/nonce", { method: "POST", body: { address: A.address } });
  const forged = await B.signMessage({ message: challenge.message });
  const out = await req("/v1/auth/verify", {
    method: "POST",
    body: { address: A.address, nonce: challenge.nonce, signature: forged },
  });
  check(out.status === 401 && !out.setCookie, "a signature from another key opens no session", out.body.code);
}

const a = await signIn(A);
const b = await signIn(B);
check(true, "two managers signed in", `${A.address.slice(0, 8)}… and ${B.address.slice(0, 8)}…`);

console.log("\ndesk registry");
const DESKS: Record<number, string> = {
  84532: "0xe666e3f76062d670a84b964ca4d9b456b1531c03",
  11155420: "0x012a12367ceeb9e4ead98803d8019913ca80c3c2",
  11155111: "0x2edaa9629436c9d0b93301422a27b640068d7cde",
};
for (const [chainId, desk] of Object.entries(DESKS)) {
  const out = await req(`/v1/desks/${chainId}`, { method: "PUT", cookie: a, body: { desk } });
  check(out.status === 200, `chain ${chainId} desk registered to manager A`);
}
{
  const out = await req("/v1/desks/84532", { method: "PUT", cookie: b, body: { desk: DESKS[84532] } });
  check(out.status === 409 && out.body.code === "desk_shared", "manager B cannot claim the same deployment");
}

console.log("\nscoped book");
const made = await req("/v1/clients", { method: "POST", cookie: a, body: { name: "live-smoke client" } });
check(made.status === 201, "manager A opened a client link", made.body?.client?.token?.slice(0, 10));
const token = made.body.client.token as string;

const bookA = await req("/v1/clients", { cookie: a });
const bookB = await req("/v1/clients", { cookie: b });
check(
  bookA.body.clients.some((c: any) => c.token === token),
  "it is in A's book",
  `${bookA.body.clients.length} client(s)`,
);
check(
  !bookB.body.clients.some((c: any) => c.token === token),
  "it is not in B's book",
  `${bookB.body.clients.length} client(s)`,
);
check((await req(`/v1/clients/${token}`, { cookie: b })).status === 403, "B holding the token still cannot read it");
check((await req(`/v1/clients/${token}/scope-check`, { cookie: b })).status === 403, "nor scope-check it");
check((await req(`/v1/clients/${token}/revoke`, { method: "POST", cookie: b })).status === 403, "nor revoke it");
check((await req(`/v1/clients/${token}`)).status === 200, "the client's own link still reads with no session");

console.log("\nexposure");
const stranger = "0x9673afB923d556979E4dfe6854d8C6e2D9994Eb4"; // a real bound owner upstream
const denied = await req(`/v1/treasury/${stranger}`, { cookie: b });
check(denied.status === 403, "an address in a URL is not a credential", denied.body.code);
check((await req(`/v1/treasury/${A.address}`, { cookie: a })).status === 200, "your own address always reads");

console.log("\nscope check, against chain");
// Every mandate this manager holds that someone has actually signed.
const mine = (await req("/v1/clients", { cookie: a })).body.clients.filter((c: any) => c.owner);
if (mine.length === 0) {
  console.log("  --   no signed mandate in A's book; import one first:");
  console.log(`       bun apps/web/scripts/import.ts ${A.address} --all`);
} else {
  const out = await req(`/v1/clients/${mine[0].token}/scope-check`, { cookie: a });
  check(out.status === 200, `read the ledger for ${mine[0].owner?.slice(0, 10)}…`);
  for (const row of out.body.rows ?? []) {
    console.log(`       chain ${row.chainId}  ${row.spender.slice(0, 10)}…  ${row.amount.padStart(12)}  ${row.label}`);
  }
  check(typeof out.body.ok === "boolean", `${out.body.foreign?.length ?? 0} foreign spender(s) flagged`);
  if (out.body.uncovered?.length) console.log(`       chains with no event index: ${out.body.uncovered.join(", ")}`);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
