// crosspermit-desk — the gatehouse, now inside the app it guards.
//
// Mirrors the relayer's `/v1` surface so it can stand in front of it, and adds the two things the
// relayer has no business knowing: who the manager is, and which clients are theirs.
//
//   POST /v1/auth/nonce            a challenge to sign
//   POST /v1/auth/verify           the signature; opens a session
//   GET  /v1/auth/me               who this session is, and their desks
//   PUT  /v1/auth/me               set display name
//   POST /v1/auth/signout
//   PUT  /v1/desks/:chainId        register this manager's LiquidityDesk
//   GET  /v1/clients               MY clients only
//   GET  /v1/intents               the fan-out list — a session, like the book above
//   POST /v1/clients               create one, recorded as mine
//   GET  /v1/clients/:token        mine, or I am the owner who signed it
//   POST /v1/clients/:token/revoke mine only
//   GET  /v1/clients/:token/scope-check   every spender named; foreign ones flagged
//   GET  /v1/treasury/:owner       me, or a client bound to me
//   GET  /v1/activity/:owner       same
//   POST /v1/clients/:token/link   passthrough — the intent signature is the auth
//   POST /v1/intents               passthrough — same reason
//   GET  /v1/pools[?owner=0x…]     the venues, read off each chain's PoolManager
//   /v1/intents/:id[/sse], /v1/quota/*    passthrough with the key, including the SSE stream
//   GET  /v1/chains, /healthz      passthrough
//
// A plain `Request in, Response out` function rather than a route file, for two reasons: the route
// order below IS the access-control argument and is worth keeping in one readable piece, and a test
// can drive this directly without a framework or a port.
import { isAddress } from "viem";

import { AuthError, clearCookie, issueNonce, session, setCookie, signIn, signOut, upsertManager } from "./auth";
import { routers } from "./config";
import { all, configError as storeError, get, key, run } from "./db";
import { pools } from "./pools";
import { type Bound, canReadMandate, canReadOwner, scopeCheck } from "./scope";
import { type Mandate } from "./upstream";
import * as upstream from "./upstream";

const ROUTERS = routers();

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", ...headers } });

const deny = (code: string, message: string, status = 403) => json({ error: message, code }, status);

/** Every mandate this manager created, with whoever answered it. The basis of every read decision. */
async function myBound(manager: string): Promise<Bound[]> {
  const tokens = await all<{ token: string }>("SELECT token FROM client_links WHERE manager = ?", [manager]);
  return Promise.all(
    tokens.map((t) =>
      upstream
        .mandate(t.token)
        .then((m) => ({ token: m.token, owner: m.owner }))
        // A mandate the relayer has lost, or a relayer that is down, must not read as "this client
        // is not yours" — it reads as no owner, which grants nothing and hides nothing.
        .catch(() => ({ token: t.token, owner: null })),
    ),
  );
}

const myDesks = (manager: string) =>
  all<{ chainId: number; desk: string }>("SELECT chainId, desk FROM desks WHERE manager = ?", [manager]);

const otherDesks = (manager: string) =>
  all<{ manager: string; desk: string }>("SELECT manager, desk FROM desks WHERE manager != ?", [manager]);

const mine = async (manager: string, token: string) =>
  Boolean(await get("SELECT 1 FROM client_links WHERE token = ? AND manager = ?", [token, manager]));

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Mounted at /api/desk by the app, so the client needs no second origin and the session cookie
  // stays same-origin. Everything below still reasons in the relayer's own `/v1` terms.
  const path = url.pathname.replace(/^\/api\/desk/, "/v1");

  // Before anything is read. A deployed host with no relayer and no store does not degrade into a
  // quiet dashboard — every read fails on its own, each one looking like an empty book, and the
  // screen is fully populated and entirely wrong. One refusal, naming the variable, instead.
  const misconfigured = upstream.configError ?? storeError;
  if (misconfigured) return json({ error: misconfigured, code: "not_configured" }, 503);

  const cookie = req.headers.get("cookie");
  const me = await session(cookie);

  if (path === "/v1/healthz" || path === "/healthz") return json({ ok: true, upstream: upstream.RELAYER_URL });

  // ---------------------------------------------------------------- proof of ownership
  if (path === "/v1/auth/nonce" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { address?: string };
    try {
      return json(await issueNonce(String(body.address ?? "")));
    } catch (e) {
      return e instanceof AuthError ? json({ error: e.message, code: e.code }, e.status) : deny("internal", "failed", 500);
    }
  }

  if (path === "/v1/auth/verify" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { address?: string; nonce?: string; signature?: string };
    try {
      const out = await signIn({
        address: String(body.address ?? ""),
        nonce: String(body.nonce ?? ""),
        signature: String(body.signature ?? ""),
      });
      return json({ address: out.address, manager: out.manager }, 200, { "set-cookie": setCookie(out.sessionId) });
    } catch (e) {
      return e instanceof AuthError ? json({ error: e.message, code: e.code }, e.status) : deny("internal", "failed", 500);
    }
  }

  if (path === "/v1/auth/signout" && req.method === "POST") {
    await signOut(cookie);
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  if (path === "/v1/auth/me") {
    if (!me) return deny("no_session", "sign in with your wallet first", 401);
    if (req.method === "PUT") {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      const name = String(body.name ?? "").trim().slice(0, 120);
      await run("UPDATE managers SET name = ? WHERE address = ?", [name, me]);
    }
    return json({
      address: me,
      manager: await upsertManager(me),
      desks: await myDesks(me),
      clients: (await get<{ n: number }>("SELECT COUNT(*) n FROM client_links WHERE manager = ?", [me]))!.n,
      routers: ROUTERS,
    });
  }

  // ---------------------------------------------------------------- desk registry (item 4)
  //
  // Registering an address claims nothing on chain and takes nothing from anyone: the claim is
  // only "allowances naming this address are mine". Two managers claiming one address is exactly
  // the shared-deployment problem, so it is refused here and said plainly.
  const desk = path.match(/^\/v1\/desks\/(\d+)$/);
  if (desk && req.method === "PUT") {
    if (!me) return deny("no_session", "sign in with your wallet first", 401);
    const body = (await req.json().catch(() => ({}))) as { desk?: string };
    const address = String(body.desk ?? "");
    // Not checksum-strict: this field is pasted into, and viem's default would reject the
    // all-lowercase form that block explorers and `cast` both hand you. Stored lowercased.
    if (!isAddress(address, { strict: false })) return json({ error: "desk must be an address", code: "bad_address" }, 400);
    const chainId = Number(desk[1]);
    const claimed = await get<{ manager: string }>("SELECT manager FROM desks WHERE chainId = ? AND desk = ?", [
      chainId,
      key(address),
    ]);
    if (claimed && claimed.manager !== me) {
      return json(
        {
          error:
            "another manager here has already registered that desk. A deployment shared between managers cannot scope" +
            " either of them: deploy your own LiquidityDesk and register that.",
          code: "desk_shared",
        },
        409,
      );
    }
    await run("INSERT OR REPLACE INTO desks (manager,chainId,desk) VALUES (?,?,?)", [me, chainId, key(address)]);
    return json({ chainId, desk: key(address) });
  }

  // ---------------------------------------------------------------- client book, scoped
  if (path === "/v1/clients" && req.method === "GET") {
    if (!me) return deny("no_session", "sign in with your wallet first", 401);
    const tokens = await all<{ token: string }>(
      "SELECT token FROM client_links WHERE manager = ? ORDER BY createdAt DESC",
      [me],
    );
    const clients: Mandate[] = [];
    for (const t of tokens) {
      // One at a time rather than reading the relayer's whole list and filtering: the whole list
      // is every manager's book, and a proxy that fetches it is a proxy one bug away from
      // returning it.
      await upstream.mandate(t.token).then(
        (m) => clients.push(m),
        () => {},
      );
    }
    return json({ clients });
  }

  if (path === "/v1/clients" && req.method === "POST") {
    if (!me) return deny("no_session", "sign in with your wallet first", 401);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const out = await upstream.call<{ client: Mandate }>("/v1/clients", { method: "POST", body });
      await run("INSERT INTO client_links (token,manager,createdAt) VALUES (?,?,?)", [out.client.token, me, Date.now()]);
      return json(out, 201);
    } catch (e) {
      return passUpstream(e);
    }
  }

  const scope = path.match(/^\/v1\/clients\/([0-9a-f]{32})\/scope-check$/);
  if (scope && req.method === "GET") {
    if (!me) return deny("no_session", "sign in with your wallet first", 401);
    const token = scope[1]!;
    if (!(await mine(me, token))) return deny("not_yours", "that client belongs to another manager");
    try {
      const m = await upstream.mandate(token);
      if (!m.owner) return json({ status: m.status, owner: null, ok: true, rows: [], foreign: [] });
      const ledger = await upstream.treasury(m.owner);
      const checked = scopeCheck(ledger.rows, {
        myDesks: (await myDesks(me)).map((d) => d.desk),
        otherDesks: await otherDesks(me),
        routers: Object.values(ROUTERS),
      });
      return json({ status: m.status, owner: m.owner, covered: ledger.covered, uncovered: ledger.uncovered, ...checked });
    } catch (e) {
      return passUpstream(e);
    }
  }

  const revoke = path.match(/^\/v1\/clients\/([0-9a-f]{32})\/revoke$/);
  if (revoke && req.method === "POST") {
    if (!me) return deny("no_session", "sign in with your wallet first", 401);
    if (!(await mine(me, revoke[1]!))) return deny("not_yours", "that client belongs to another manager");
    try {
      return json(await upstream.call(`/v1/clients/${revoke[1]}/revoke`, { method: "POST" }));
    } catch (e) {
      return passUpstream(e);
    }
  }

  // Passthrough, deliberately open, for the same reason the relayer leaves them open: the client's
  // own signature is the authorisation, and a session requirement here would only mean a client
  // cannot sign a writ until the desk has onboarded them.
  const link = path.match(/^\/v1\/clients\/([0-9a-f]{32})\/link$/);
  if ((link && req.method === "POST") || (path === "/v1/intents" && req.method === "POST")) {
    try {
      return json(await upstream.call(path + url.search, { method: "POST", body: await req.json().catch(() => ({})) }));
    } catch (e) {
      return passUpstream(e);
    }
  }

  // One intent's status, its live stream, a quota read. Open upstream and streamed through
  // untouched, so a dashboard behind this layer needs no second origin to talk to.
  //
  // Matched exactly rather than by prefix: `/v1/intents` with nothing after it is the COLLECTION,
  // which is every manager's fan-out, and a prefix match proxied it to anyone who asked. It is
  // gated below for the same reason `/v1/clients` is.
  if (req.method === "GET" && (/^\/v1\/intents\/[^/]+(\/sse)?$/.test(path) || path.startsWith("/v1/quota/"))) {
    return upstream.proxy(path + url.search);
  }

  if (path === "/v1/intents" && req.method === "GET") {
    if (!me) return deny("no_session", "sign in with your wallet first", 401);
    return upstream.proxy(path + url.search);
  }

  const one = path.match(/^\/v1\/clients\/([0-9a-f]{32})$/);
  if (one && req.method === "GET") {
    const token = one[1]!;
    try {
      const m = await upstream.mandate(token);
      // A client opening their own link has no session yet — the link IS their way in, and what it
      // returns is an offer, not authority. A SESSION, though, is checked: a manager may not read
      // another manager's mandate just because they guessed the token.
      if (me && !canReadMandate(me, m, await mine(me, token))) {
        return deny("not_yours", "that client belongs to another manager");
      }
      return json({ client: m });
    } catch (e) {
      return passUpstream(e);
    }
  }

  // ---------------------------------------------------------------- exposure, gated (item 3)
  const owner = path.match(/^\/v1\/(treasury|activity)\/(0x[0-9a-fA-F]{40})$/);
  if (owner && req.method === "GET") {
    if (!me) return deny("no_session", "sign in with your wallet first", 401);
    const [, kind, addr] = owner as unknown as [string, string, string];
    if (!canReadOwner(me, addr, await myBound(me))) {
      return deny("not_yours", "that address is neither yours nor a client of yours");
    }
    try {
      return json(await upstream.call(`/v1/${kind}/${addr}`));
    } catch (e) {
      return passUpstream(e);
    }
  }

  // ---------------------------------------------------------------- the venues
  //
  // Behind a session, but not behind ownership: a pool's depth is public on chain and every manager
  // here needs the same figures. An `owner` is only honoured when that owner is readable to this
  // session — the position in a pool is a client's, not the venue's.
  if (path === "/v1/pools" && req.method === "GET") {
    if (!me) return deny("no_session", "sign in with your wallet first", 401);
    const asked = url.searchParams.get("owner");
    let owner: `0x${string}` | undefined;
    if (asked) {
      if (!isAddress(asked, { strict: false })) return json({ error: "owner must be an address", code: "bad_address" }, 400);
      if (!canReadOwner(me, asked, await myBound(me))) {
        return deny("not_yours", "that address is neither yours nor a client of yours");
      }
      owner = asked as `0x${string}`;
    }
    try {
      return json({ pools: await pools(owner), owner: owner ?? null });
    } catch (e) {
      console.error("pool read failed", e);
      return json({ error: "could not read the pools", code: "pools_unavailable" }, 502);
    }
  }

  if (path === "/v1/chains" && req.method === "GET") {
    try {
      const out = await upstream.chains();
      return json({ ...out, routers: ROUTERS });
    } catch (e) {
      return passUpstream(e);
    }
  }

  return json({ error: `no route for ${req.method} ${path}`, code: "not_found" }, 404);
}

/** The relayer's own refusal, forwarded. A proxy that rewrites reasons makes debugging guesswork. */
function passUpstream(e: unknown): Response {
  if (e instanceof upstream.UpstreamError) {
    const body = typeof e.body === "object" && e.body ? e.body : { error: String(e.body ?? "upstream error") };
    return json(body, e.status);
  }
  console.error(e);
  return json({ error: "internal error", code: "internal" }, 500);
}
