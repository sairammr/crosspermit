// crosspermit-desk — the gatehouse.
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
//   POST /v1/clients               create one, recorded as mine
//   GET  /v1/clients/:token        mine, or I am the owner who signed it
//   POST /v1/clients/:token/revoke mine only
//   GET  /v1/clients/:token/scope-check   every spender named; foreign ones flagged
//   GET  /v1/treasury/:owner       me, or a client bound to me
//   GET  /v1/activity/:owner       same
//   POST /v1/clients/:token/link   passthrough — the intent signature is the auth
//   POST /v1/intents               passthrough — same reason
//   GET  /v1/chains, /healthz      passthrough
import { isAddress } from "viem";

import { AuthError, clearCookie, issueNonce, session, setCookie, signIn, signOut, upsertManager } from "./auth.js";
import { PORT, routers } from "./config.js";
import { key, open } from "./db.js";
import { type Bound, canReadMandate, canReadOwner, scopeCheck } from "./scope.js";
import { type Mandate } from "./upstream.js";
import * as upstream from "./upstream.js";

const db = open();
const ROUTERS = routers();

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", ...headers } });

const deny = (code: string, message: string, status = 403) => json({ error: message, code }, status);

/** Every mandate this manager created, with whoever answered it. The basis of every read decision. */
function myBound(manager: string): Promise<Bound[]> {
  const tokens = db.query("SELECT token FROM client_links WHERE manager = ?").all(manager) as { token: string }[];
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
  (db.query("SELECT chainId, desk FROM desks WHERE manager = ?").all(manager) as { chainId: number; desk: string }[]);

const otherDesks = (manager: string) =>
  (db.query("SELECT manager, desk FROM desks WHERE manager != ?").all(manager) as { manager: string; desk: string }[]);

const mine = (manager: string, token: string) =>
  Boolean(db.query("SELECT 1 FROM client_links WHERE token = ? AND manager = ?").get(token, manager));

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cookie = req.headers.get("cookie");
    const me = session(db, cookie);

    if (path === "/healthz") return json({ ok: true, upstream: upstream.RELAYER_URL });

    // ---------------------------------------------------------------- the page
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return new Response(Bun.file(`${import.meta.dir}/../public/index.html`), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // ---------------------------------------------------------------- proof of ownership
    if (path === "/v1/auth/nonce" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { address?: string };
      try {
        return json(issueNonce(db, String(body.address ?? "")));
      } catch (e) {
        return e instanceof AuthError ? json({ error: e.message, code: e.code }, e.status) : deny("internal", "failed", 500);
      }
    }

    if (path === "/v1/auth/verify" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { address?: string; nonce?: string; signature?: string };
      try {
        const out = await signIn(db, {
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
      signOut(db, cookie);
      return json({ ok: true }, 200, { "set-cookie": clearCookie() });
    }

    if (path === "/v1/auth/me") {
      if (!me) return deny("no_session", "sign in with your wallet first", 401);
      if (req.method === "PUT") {
        const body = (await req.json().catch(() => ({}))) as { name?: string };
        const name = String(body.name ?? "").trim().slice(0, 120);
        db.query("UPDATE managers SET name = ? WHERE address = ?").run(name, me);
      }
      return json({
        address: me,
        manager: upsertManager(db, me),
        desks: myDesks(me),
        clients: (db.query("SELECT COUNT(*) n FROM client_links WHERE manager = ?").get(me) as { n: number }).n,
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
      const claimed = db.query("SELECT manager FROM desks WHERE chainId = ? AND desk = ?").get(chainId, key(address)) as
        | { manager: string }
        | undefined;
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
      db.query("INSERT OR REPLACE INTO desks (manager,chainId,desk) VALUES (?,?,?)").run(me, chainId, key(address));
      return json({ chainId, desk: key(address) });
    }

    // ---------------------------------------------------------------- client book, scoped
    if (path === "/v1/clients" && req.method === "GET") {
      if (!me) return deny("no_session", "sign in with your wallet first", 401);
      const tokens = db.query("SELECT token FROM client_links WHERE manager = ? ORDER BY createdAt DESC").all(me) as {
        token: string;
      }[];
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
        db.query("INSERT INTO client_links (token,manager,createdAt) VALUES (?,?,?)").run(out.client.token, me, Date.now());
        return json(out, 201);
      } catch (e) {
        return passUpstream(e);
      }
    }

    const scope = path.match(/^\/v1\/clients\/([0-9a-f]{32})\/scope-check$/);
    if (scope && req.method === "GET") {
      if (!me) return deny("no_session", "sign in with your wallet first", 401);
      const token = scope[1]!;
      if (!mine(me, token)) return deny("not_yours", "that client belongs to another manager");
      try {
        const m = await upstream.mandate(token);
        if (!m.owner) return json({ status: m.status, owner: null, ok: true, rows: [], foreign: [] });
        const ledger = await upstream.treasury(m.owner);
        const checked = scopeCheck(ledger.rows, {
          myDesks: myDesks(me).map((d) => d.desk),
          otherDesks: otherDesks(me),
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
      if (!mine(me, revoke[1]!)) return deny("not_yours", "that client belongs to another manager");
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

    const one = path.match(/^\/v1\/clients\/([0-9a-f]{32})$/);
    if (one && req.method === "GET") {
      const token = one[1]!;
      try {
        const m = await upstream.mandate(token);
        // A client opening their own link has no session yet — the link IS their way in, and what it
        // returns is an offer, not authority. A SESSION, though, is checked: a manager may not read
        // another manager's mandate just because they guessed the token.
        if (me && !canReadMandate(me, m, mine(me, token))) return deny("not_yours", "that client belongs to another manager");
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

    if (path === "/v1/chains" && req.method === "GET") {
      try {
        const out = await upstream.chains();
        return json({ ...out, routers: ROUTERS });
      } catch (e) {
        return passUpstream(e);
      }
    }

    return json({ error: `no route for ${req.method} ${path}`, code: "not_found" }, 404);
  },
});

/** The relayer's own refusal, forwarded. A proxy that rewrites reasons makes debugging guesswork. */
function passUpstream(e: unknown): Response {
  if (e instanceof upstream.UpstreamError) {
    const body = typeof e.body === "object" && e.body ? e.body : { error: String(e.body ?? "upstream error") };
    return json(body, e.status);
  }
  console.error(e);
  return json({ error: "internal error", code: "internal" }, 500);
}

console.log(`crosspermit-desk on http://localhost:${server.port}  →  relayer ${upstream.RELAYER_URL}`);
console.log(
  process.env.RELAYER_API_KEY
    ? "  upstream key: held here, never sent to a browser"
    : "  upstream key: none set (relayer must be running open)",
);
