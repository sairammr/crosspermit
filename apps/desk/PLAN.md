# apps/desk — the multi-manager layer

A gatehouse in front of the relayer, in this repo, coupled to it by HTTP and nothing else. It answers one question the relayer
cannot: *who is asking*. The relayer knows owners, because an owner's signature is the only identity
a permit needs. It does not know managers, and today it does not need to — one API key is the whole
desk. That key is what makes the product single-tenant.

## What is broken, and what this fixes

| # | Broken today | Fixed here |
|---|---|---|
| 1 | No manager identity. `clients` rows have no owner-of-the-row (`clients.ts:37-51`); `GET /v1/clients` returns the whole book to one key. | `managers` + `client_links` tables. Every list and read is scoped to the signed-in manager. |
| 2 | `NEXT_PUBLIC_RELAYER_API_KEY` ships in the browser bundle — anyone who opens the console is the desk. | The upstream key lives only in this process. Browsers get a session cookie earned by a signature. |
| 3 | `GET /v1/treasury/:owner` and `/v1/activity/:owner` take an address in the path, no auth (`server.ts:127`, `:157`). | Readable only by that owner, or by a manager the owner is bound to. |
| 4 | Managers share one `LiquidityDesk` deployment; `add(owner,…)` has no caller check (`LiquidityDesk.sol:84`), so any manager can deploy any bound client's capital. | Per-manager desk registry. The layer names each manager's own desk and **flags every allowance whose spender is not it**. No contract change. |
| 5 | Spender labels read off one `pool.liquidityDesk`, so another manager's desk renders as "unrecognised spender". | `scope-check` names the spender: mine / another desk on this platform / unknown. |

Deliberately **not** fixed: item 4's root cause. A caller check inside `add` is a contract change, and
the contracts are staying untouched. Per-manager deployments plus a registry get the same scoping
from outside; the registry is also what a future `ManagedDesk` would need anyway.

## Shape

```
browser ──cookie──▶ crosspermit-desk ──Bearer RELAYER_API_KEY──▶ relayer ──▶ chains
         (signature)   sqlite: managers, desks, client_links, nonces, sessions
```

Paths mirror the relayer's, so this sits in front of it rather than beside it: point anything that
spoke to the relayer at this instead. Added on top:

| Route | Auth | Does |
|---|---|---|
| `POST /v1/auth/nonce` | — | single-use nonce, 5 min |
| `POST /v1/auth/verify` | signature | recovers the address, opens a 24h session cookie |
| `GET  /v1/auth/me` | session | address, manager row, registered desks |
| `PUT  /v1/auth/me` | session | set display name |
| `PUT  /v1/desks/:chainId` | session | register this manager's LiquidityDesk on a chain |
| `GET  /v1/clients` | session | **only my clients** |
| `POST /v1/clients` | session | create upstream, record it as mine |
| `GET  /v1/clients/:token` | session | mine, or I am the bound owner |
| `POST /v1/clients/:token/revoke` | session | mine only |
| `GET  /v1/clients/:token/scope-check` | session | every allowance this client signed, spender named, foreign ones flagged |
| `GET  /v1/treasury/:owner`, `/v1/activity/:owner` | session | me, or a client bound to me |
| `POST /v1/clients/:token/link` | — | pass through; the intent signature is the auth (`server.ts:207`) |
| `POST /v1/intents` | — | pass through; same reason |
| `GET  /v1/chains`, `/healthz` | — | pass through |

## Proof of ownership

One challenge, `personal_sign`, EIP-4361-shaped but deliberately short:

```
crosspermit-desk wants you to sign in.

address: 0x…
nonce:   <32 hex>
issued:  <iso8601>

Signing proves you hold this key. It grants nothing, moves nothing and costs no gas.
```

Server recovers with `verifyMessage`, burns the nonce, opens a session. There are no roles: what a
session may read is computed per request from the tables. The same signature therefore serves a
manager reading their book and a client reading their own exposure — the only difference is which
rows answer to them.

Not in scope, named rather than hidden: the upstream relayer's own `/v1/clients/:token` stays open,
so anyone who can reach the relayer directly can still read a mandate by its token. This layer is a
front door, not a firewall. Deploy the relayer where only this process can reach it.

## Steps

1. `src/db.ts` — schema, one file, no migrations framework.
2. `src/auth.ts` — challenge text, nonce issue/burn, verify, sessions. Pure where it can be.
3. `src/scope.ts` — pure authorization decisions and spender classification. Where the tests point.
4. `src/upstream.ts` — the relayer client; the only thing holding the key.
5. `src/server.ts` — routes above.
6. `public/index.html` — connect, sign in, register a desk, run the book, scope-check a client.
7. `test/` — nonce single use, scoping refusals, spender classification.
