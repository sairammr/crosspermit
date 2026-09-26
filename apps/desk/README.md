# @crosspermit/desk

A gatehouse in front of the relayer, so one deployment can serve many fund managers without their
books, their clients or their desks running into each other.

It lives in this repo as its own app and talks to `apps/relayer` over HTTP only — no imports, no
shared database, no contract changes. The relayer runs exactly as it did before this existed.

CrossPermit knows owners — an owner's signature is the only identity a permit needs. It does not know
managers. That is why the reference relayer is single-tenant: one `RELAYER_API_KEY` is the whole desk,
and the dashboard ships it to the browser. This layer supplies the missing half.

```
browser ──cookie earned by a signature──▶ crosspermit-desk ──Bearer key──▶ relayer ──▶ chains
```

See `PLAN.md` for what is fixed and what is deliberately left alone.

## Run

From the repo root, with `apps/relayer` already up:

```sh
bun install
RELAYER_URL=http://localhost:8787 \
RELAYER_API_KEY=<the relayer's key> \
DESK_INSECURE_COOKIE=1 \
bun run --filter @crosspermit/desk dev     # http://localhost:8788
```

Open it, connect a wallet, press **Prove you hold it**, sign. One `personal_sign` over a nonce this
server issued; nothing on chain, no gas. That signature is the login.

| env | |
|---|---|
| `RELAYER_URL` | upstream relayer (default `http://localhost:8787`) |
| `RELAYER_API_KEY` | the relayer's key. Held here, never sent to a browser. |
| `DESK_PORT` | default 8788 |
| `DESK_DB` | sqlite path, default `desk.sqlite` |
| `DESK_ROUTERS` | `{"84532":"0x…"}` — overrides the built-in testnet routers |
| `DESK_INSECURE_COOKIE=1` | drop `Secure` so the cookie works over plain http locally |

Put the relayer somewhere only this process can reach. The layer is a front door, not a firewall:
the relayer's own `/v1/clients/:token` stays open by design, and its `/v1/treasury/:owner` asks for
nothing at all.

## What it does

- **Proof of ownership.** Nonce → `personal_sign` → `verifyMessage` → HttpOnly session. Nonces are
  single use and are burned even on a failed signature. No roles: what a session may read is computed
  per request from the tables, so the same signature serves a manager reading their book and a client
  reading their own exposure.
- **Scoped book.** `GET /v1/clients` returns only mandates this manager created. Another manager
  holding the token gets 403, including for `scope-check` and `revoke`.
- **Gated exposure.** `GET /v1/treasury/:owner` and `/v1/activity/:owner` answer for your own address
  or for a client bound to one of your mandates. An address in a URL stops being a credential.
- **Desk registry.** Register the `LiquidityDesk` you deployed, per chain. Two managers cannot
  register one address — a shared deployment scopes neither of them, because `add(owner,…)` has no
  caller check and every manager on it can spend every bound client's allowance.
- **Pools.** `GET /v1/pools[?owner=0x…]` reads each chain's v4 PoolManager with `extsload` — price,
  tick, depth in both tokens over the offered range, and one client's own position when an owner is
  asked for (and readable to the session). The slot math is imported from `apps/web`, not restated.
  20s process cache. The page draws depth-by-chain bars and a price-within-range band, inline SVG,
  no chart library.
- **Scope check.** Every allowance a client signed, spender named: yours, an execution router,
  another manager's desk (named), or `unrecognised spender`. Foreign ones are counted and flagged,
  never quietly labelled.

## Scripts

```sh
# assign mandates that predate this layer to a manager (needs the relayer's key, not a session)
bun apps/desk/scripts/import.ts <manager-address> --name "Desk name" --all

# drive a running layer with two real managers against the live relayer
DESK_URL=http://localhost:8788 bun apps/desk/scripts/live-smoke.ts
```

`import.ts` is a script and not a route on purpose: claiming a mandate you did not create is exactly
the privilege this layer withholds, so it belongs to whoever already holds the relayer's API key.

## How `apps/web` talks to it

The dashboard no longer speaks to the relayer at all. `next.config.mjs` rewrites `/api/desk/*` to this
layer, so from the browser it is same-origin:

```
NEXT_PUBLIC_RELAYER_API_KEY   ✗ gone — there is nothing secret left to ship
DESK_URL=http://localhost:8788   server-side only; the browser never learns it
/api/desk/*  →  <DESK_URL>/v1/*
```

A rewrite rather than a cross-origin fetch, because of the cookie: it is `SameSite=Lax`, which a
browser will not send cross-site, and `SameSite=None` would demand HTTPS in development. Same-origin
also means no CORS to configure and no second address in the bundle.

What changed on the web side:

| | |
|---|---|
| `src/desk.ts` | session, `proveOwnership`, desk registry, scope-check. No React, no wagmi. |
| `src/session-ui.tsx` | the **Prove ownership** button in the console header, and the note that explains an empty book. |
| `src/clients.ts`, `src/relayer.ts` | same functions, pointed at `DESK_API`, key removed. |

The client signing page `/c/:token` is untouched and needs no session: submitting an intent and
binding a mandate are authorised by the client's own signature, and this layer passes both through —
along with intent status, the SSE stream and quota reads, which stream rather than buffer.

This app's own page at `:8788` stays as an operator view: it works with no Next build and no
dashboard, which is what you want when the question is whether the layer itself is up.

## Tests

```sh
bun test
```

17 tests. `test/auth.test.ts` covers the challenge, nonce single-use, and the pure scoping rules.
`test/e2e.test.ts` runs the real server against a stub relayer as permissive as the real one, with
two managers signing real signatures, and asserts every refusal — including that the upstream key
never appears in the page.

## Not done here

- A caller check inside `LiquidityDesk.add`. Contract change, out of scope by design; per-manager
  deployments plus this registry get the scoping from outside.
- Pointing `apps/web` at this layer. It still holds `NEXT_PUBLIC_RELAYER_API_KEY`; the page here is a
  standalone replacement for the desk console's client-book half, not for the client signing page
  `/c/:token`.
- Contract-account sign-in (Safe, 7702). `verifyMessage` here is EOA-only — this process has no RPC.
