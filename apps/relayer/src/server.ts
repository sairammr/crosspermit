// HTTP surface. One POST covers every chain — that is the whole product claim.
//
//   POST /v1/intents[?wait=1]   submit a signed intent; ?wait=1 returns once every leg settles
//   GET  /v1/intents/:id        status snapshot
//   GET  /v1/intents/:id/sse    live per-leg event stream
//   GET  /v1/intents            recent intents
//   GET  /v1/chains             what this relayer serves, and with whose key
//   GET  /healthz /readyz       liveness and readiness
import { IntentError, fromWire } from "@crosspermit/sdk";

import { Admission, admissionFromEnv } from "./admission.js";

import { loadConfig } from "./config.js";
import { Relayer } from "./relayer.js";
import { Store } from "./store.js";

const repoRoot = new URL("../../../", import.meta.url);
const { config, banner } = await loadConfig(repoRoot);
const store = new Store(config.dbPath);
const admissionConfig = admissionFromEnv();
const admission = new Admission(admissionConfig);
const relayer = new Relayer(config, store, (owner, wei) => admission.chargeGas(owner, wei));

console.log("crosspermit-relayer");
for (const line of banner) console.log(line.startsWith("  ") ? line : `  ${line}`);
for (const line of await config.treasury.describe([...config.chains.keys()])) console.log(line);
console.log(
  admission.open
    ? "  admission: OPEN — no RELAYER_API_KEYS set, anyone who can reach this port can spend its gas"
    : `  admission: ${admissionConfig.apiKeys.size} API key(s)`,
);
console.log(
  `  per-owner limits: ${admissionConfig.maxIntentsPerWindow} intents and ` +
    `${admissionConfig.maxGasWeiPerWindow} wei of gas per ${admissionConfig.windowMs}ms`,
);

// A leg stuck in `submitting` may have a transaction in the mempool whose hash we never saw.
// Resubmitting it blind is how one signed allowance becomes two on chain, so report and stop.
const stranded = store.stranded();
if (stranded.length) {
  console.warn(`  ${stranded.length} leg(s) stranded mid-submit by a previous run — NOT auto-retried:`);
  for (const l of stranded) console.warn(`    ${l.intentId} chain ${l.chainId} (attempt ${l.attempts})`);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });

// The dashboard is served from a different origin in development. Only the read and submit verbs
// are exposed, and every request is authorised by the owner's signature rather than by origin.
const cors = {
  "access-control-allow-origin": process.env.RELAYER_CORS_ORIGIN ?? "*",
  "access-control-allow-headers": "content-type,authorization",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

const server = Bun.serve({
  port: config.port,
  idleTimeout: 120,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (path === "/healthz") return json({ ok: true });
    if (path === "/readyz") return json({ ok: true, chains: [...config.chains.keys()] });

    if (path === "/v1/chains") {
      return json({
        crossPermit: config.crossPermit,
        chains: [...config.chains.values()].map((c) => ({
          chainId: c.chainId,
          name: c.name,
          explorer: c.explorer,
          signer: c.signer.address,
          custody: c.signer.custody,
          auditTrail: config.treasury.has(c.chainId) ? "multibaas" : "none",
        })),
      });
    }

    if (path === "/v1/intents" && req.method === "POST") {
      const key = admission.checkKey(req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? null);
      if (!key.ok) return json({ error: key.message, code: key.code }, key.status);

      let intent;
      try {
        intent = fromWire(await req.json());
      } catch (e) {
        return json({ error: e instanceof IntentError ? e.message : "body is not valid JSON", code: "malformed" }, 400);
      }

      // Rate and budget are checked against the OWNER, the only identity the signature proves.
      // Checked before validation so a flood cannot make the relayer do crypto work for free.
      const allowed = admission.checkOwner(intent.owner);
      if (!allowed.ok) return json({ error: allowed.message, code: allowed.code }, allowed.status);

      try {
        const res = await relayer.submit(intent, { wait: url.searchParams.get("wait") === "1" });
        // Only a genuinely new intent counts against the window; a replay is answered from state.
        if (res.accepted) admission.recordIntent(intent.owner);
        // 200 rather than 201 on a replay: nothing was created, and the caller gets the first run's
        // result so a retry is safe.
        return json({ intentId: res.id, accepted: res.accepted, ...relayer.status(res.id) }, res.accepted ? 201 : 200);
      } catch (e) {
        if (e instanceof IntentError) return json({ error: e.message, code: e.code }, 400);
        console.error("submit failed", e);
        return json({ error: "internal error", code: "internal" }, 500);
      }
    }

    const quota = path.match(/^\/v1\/quota\/(0x[0-9a-fA-F]{40})$/);
    if (quota) return json({ owner: quota[1], remaining: admission.remaining(quota[1] as `0x${string}`) });

    if (path === "/v1/intents" && req.method === "GET") {
      return json({ intents: store.recent(Number(url.searchParams.get("limit") ?? 50)) });
    }

    const sse = path.match(/^\/v1\/intents\/([^/]+)\/sse$/);
    if (sse) return stream(sse[1]!);

    const one = path.match(/^\/v1\/intents\/([^/]+)$/);
    if (one) {
      const status = relayer.status(one[1]!);
      return status ? json(status) : json({ error: "unknown intent", code: "not_found" }, 404);
    }

    return json({ error: "not found", code: "not_found" }, 404);
  },
});

/**
 * Live per-leg events.
 *
 * The current status is replayed first, before any subscription, so a client that connects after a
 * leg already landed still sees it — otherwise a fast chain's result is lost to whoever was a
 * moment slow to subscribe, and the UI hangs on a leg that finished.
 */
function stream(id: string): Response {
  const status = relayer.status(id);
  if (!status) return json({ error: "unknown intent", code: "not_found" }, 404);

  let unsubscribe = () => {};
  const body = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      send("snapshot", status);
      if (status.done) {
        controller.close();
        return;
      }

      unsubscribe = relayer.on(id, (e) => {
        send("leg", e);
        const now = relayer.status(id);
        if (now?.done) {
          send("done", now);
          controller.close();
          unsubscribe();
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...cors },
  });
}

console.log(`  listening on http://localhost:${server.port}`);
