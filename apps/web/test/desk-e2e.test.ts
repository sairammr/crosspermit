// End to end, against a stub relayer: two managers, two clients, and every refusal the layer exists
// to make. The stub stands in for the real one because what is under test is the gatehouse, not the
// relayer — the stub is deliberately as permissive as the real thing (it asks for nothing), which is
// the point.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import { reset } from "../src/desk/db";

const A = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const B = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const CLIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const MY_DESK = "0xE666e3F7000000000000000000000000000000E1";
const THEIR_DESK = "0x012a1236000000000000000000000000000000E2";
const ROUTER = "0x73ed10744987B65fAf6BD6FFdF1039Cb7eF97002";

const UP = 8899;
const DESK = 8898;
const base = `http://localhost:${DESK}`;

const mandates = new Map<string, Record<string, unknown>>();

/** The relayer, as far as this test is concerned: creates mandates, answers reads, asks nothing. */
const upstream = Bun.serve({
  port: UP,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

    if (path === "/v1/clients" && req.method === "POST") {
      const body = (await req.json()) as { name: string; mandate?: string };
      const token = crypto.randomUUID().replace(/-/g, "");
      const client = { token, name: body.name, mandate: body.mandate ?? "", capUnits: "", ttlHours: 0, chainIds: [], owner: null, intentId: null, createdAt: Date.now(), linkedAt: null, revokedAt: null, status: "awaiting" };
      mandates.set(token, client);
      return j({ client }, 201);
    }
    if (path === "/v1/clients" && req.method === "GET") return j({ clients: [...mandates.values()] });

    const one = path.match(/^\/v1\/clients\/([0-9a-f]{32})$/);
    if (one) {
      const m = mandates.get(one[1]!);
      return m ? j({ client: m }) : j({ error: "no such client", code: "not_found" }, 404);
    }
    if (path.startsWith("/v1/treasury/")) {
      return j({
        owner: path.split("/").pop(),
        covered: [84532],
        uncovered: [11155111],
        rows: [
          { chainId: 84532, token: "0xaaaa000000000000000000000000000000000001", spender: MY_DESK, amount: "1000", expiration: 0 },
          { chainId: 84532, token: "0xaaaa000000000000000000000000000000000001", spender: ROUTER, amount: "2000", expiration: 0 },
          { chainId: 84532, token: "0xaaaa000000000000000000000000000000000001", spender: THEIR_DESK, amount: "3000", expiration: 0 },
        ],
      });
    }
    if (path.startsWith("/v1/activity/")) return j({ owner: path.split("/").pop(), covered: [84532], uncovered: [], rows: [] });
    return j({ error: `stub has no ${path}`, code: "not_found" }, 404);
  },
});

let desk: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  process.env.RELAYER_URL = `http://localhost:${UP}`;
  process.env.RELAYER_API_KEY = "upstream-secret";
  process.env.DESK_INSECURE_COOKIE = "1";
  await reset("file::memory:");
  // Imported after the env is set: `upstream.ts` reads RELAYER_URL at module load, exactly as it
  // does in the app, and importing it earlier would bind it to the default.
  const { handle } = await import("../src/desk/handler");
  desk = Bun.serve({ port: DESK, idleTimeout: 60, fetch: handle });
});

afterAll(() => {
  desk?.stop(true);
  upstream.stop(true);
});

/** Sign in for real: nonce, `personal_sign`, cookie. Returns the cookie to use as that manager. */
async function signIn(account: typeof A): Promise<string> {
  const nonceRes = await fetch(`${base}/v1/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const { nonce, message } = (await nonceRes.json()) as { nonce: string; message: string };
  const signature = await account.signMessage({ message });
  const res = await fetch(`${base}/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address, nonce, signature }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie).toStartWith("desk_session=");
  return cookie;
}

const as = (cookie: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) } });

test("no session reads nothing", async () => {
  // `/v1/intents` is the collection — every manager's fan-out. A prefix match once proxied it to
  // anyone; only the single-intent paths below it are open.
  for (const path of ["/v1/auth/me", "/v1/clients", "/v1/intents", `/v1/treasury/${CLIENT}`, `/v1/activity/${CLIENT}`]) {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(401);
  }
});

test("a forged signature buys no session", async () => {
  const { nonce, message } = (await (
    await fetch(`${base}/v1/auth/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: A.address }),
    })
  ).json()) as { nonce: string; message: string };
  const res = await fetch(`${base}/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: A.address, nonce, signature: await B.signMessage({ message }) }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("set-cookie")).toBeNull();
});

test("two managers, two books, no crossover", async () => {
  const a = await signIn(A);
  const b = await signIn(B);

  const made = (await (await as(a, "/v1/clients", { method: "POST", body: JSON.stringify({ name: "Meridian Capital" }) })).json()) as {
    client: { token: string };
  };
  await as(b, "/v1/clients", { method: "POST", body: JSON.stringify({ name: "Someone Else" }) });

  // The upstream relayer holds both. Each manager sees one.
  expect((await (await fetch(`http://localhost:${UP}/v1/clients`)).json()).clients).toHaveLength(2);
  const bookA = (await (await as(a, "/v1/clients")).json()) as { clients: { name: string }[] };
  const bookB = (await (await as(b, "/v1/clients")).json()) as { clients: { name: string }[] };
  expect(bookA.clients.map((c) => c.name)).toEqual(["Meridian Capital"]);
  expect(bookB.clients.map((c) => c.name)).toEqual(["Someone Else"]);

  // B knows A's token — guessing it, or being told it — and still cannot read it as a manager.
  const peek = await as(b, `/v1/clients/${made.client.token}`);
  expect(peek.status).toBe(403);
  expect((await peek.json()).code).toBe("not_yours");

  // Nor scope-check it, nor revoke it.
  expect((await as(b, `/v1/clients/${made.client.token}/scope-check`)).status).toBe(403);
  expect((await as(b, `/v1/clients/${made.client.token}/revoke`, { method: "POST" })).status).toBe(403);
  expect((await as(a, `/v1/clients/${made.client.token}/scope-check`)).status).toBe(200);
});

test("an address in a URL is not a credential", async () => {
  const a = await signIn(A);
  // A is signed in, and asks for a stranger's exposure. Upstream would answer it happily.
  const denied = await as(a, `/v1/treasury/${CLIENT}`);
  expect(denied.status).toBe(403);
  expect((await (await fetch(`http://localhost:${UP}/v1/treasury/${CLIENT}`)).json()).rows).toHaveLength(3);

  // Their own address, always readable.
  expect((await as(a, `/v1/treasury/${A.address}`)).status).toBe(200);

  // Bind the client to A's mandate upstream, and the same request now succeeds.
  const made = (await (await as(a, "/v1/clients", { method: "POST", body: JSON.stringify({ name: "Bound" }) })).json()) as {
    client: { token: string };
  };
  const row = mandates.get(made.client.token)!;
  mandates.set(made.client.token, { ...row, owner: CLIENT, status: "active" });
  expect((await as(a, `/v1/treasury/${CLIENT}`)).status).toBe(200);
  expect((await as(a, `/v1/activity/${CLIENT}`)).status).toBe(200);

  // And B, who has no such client, still cannot.
  expect((await as(await signIn(B), `/v1/treasury/${CLIENT}`)).status).toBe(403);
});

test("a desk deployment cannot be shared, and a foreign spender is flagged", async () => {
  const a = await signIn(A);
  const b = await signIn(B);

  expect((await as(a, "/v1/desks/84532", { method: "PUT", body: JSON.stringify({ desk: MY_DESK }) })).status).toBe(200);
  const shared = await as(b, "/v1/desks/84532", { method: "PUT", body: JSON.stringify({ desk: MY_DESK }) });
  expect(shared.status).toBe(409);
  expect((await shared.json()).code).toBe("desk_shared");
  await as(b, "/v1/desks/84532", { method: "PUT", body: JSON.stringify({ desk: THEIR_DESK }) });

  const made = (await (await as(a, "/v1/clients", { method: "POST", body: JSON.stringify({ name: "Checked" }) })).json()) as {
    client: { token: string };
  };
  mandates.set(made.client.token, { ...mandates.get(made.client.token)!, owner: CLIENT, status: "active" });

  const out = (await (await as(a, `/v1/clients/${made.client.token}/scope-check`)).json()) as {
    ok: boolean;
    rows: { kind: string; label: string; manager?: string }[];
    foreign: { kind: string }[];
    uncovered: number[];
  };
  expect(out.rows.map((r) => r.kind)).toEqual(["mine", "router", "other_desk"]);
  expect(out.ok).toBe(false);
  expect(out.foreign).toHaveLength(1);
  expect(out.rows[2]!.manager).toBe(B.address.toLowerCase());
  // Chains with no event index are named, not silently dropped.
  expect(out.uncovered).toEqual([11155111]);
});

test("the upstream key never leaves the layer", async () => {
  // Against the answers that actually travel upstream with the key attached, not against a 404.
  // A 404 body cannot contain the secret whatever the layer does, so asserting on one is an
  // assertion that passes for any implementation — which is the same as no assertion at all.
  const a = await signIn(A);
  const made = (await (await as(a, "/v1/clients", { method: "POST", body: JSON.stringify({ name: "Keyless" }) })).json()) as {
    client: { token: string };
  };
  mandates.set(made.client.token, { ...mandates.get(made.client.token)!, owner: CLIENT, status: "active" });

  const seen = async (res: Response) =>
    `${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${await res.text()}`;

  // The book, with the mandate the stub really returned in it.
  const book = await as(a, "/v1/clients");
  expect(book.status).toBe(200);
  const bookText = await seen(book);
  expect(bookText).toInclude("Keyless");

  // The two gated reads the layer fetches upstream with `authorization: Bearer upstream-secret`.
  const treasury = await as(a, `/v1/treasury/${CLIENT}`);
  expect(treasury.status).toBe(200);
  const treasuryText = await seen(treasury);
  expect(treasuryText).toInclude(ROUTER);

  const activity = await as(a, `/v1/activity/${CLIENT}`);
  expect(activity.status).toBe(200);

  // And the venues, read off chain by this layer itself. Offline it answers with a per-pool
  // `error`, which is still a body this layer composed and so is still worth scanning.
  const pools = await as(a, "/v1/pools");
  const poolsText = await seen(pools);
  expect(poolsText).toInclude("poolManager");

  // Headers as well as bodies: a proxy that echoed the request's `authorization` back would leak
  // it somewhere no body assertion looks.
  for (const text of [bookText, treasuryText, await seen(activity), poolsText]) {
    expect(text).not.toInclude("upstream-secret");
    expect(text).not.toInclude("NEXT_PUBLIC_RELAYER_API_KEY");
  }
});
