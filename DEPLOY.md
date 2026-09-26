# Deploying CrossPermit

Four things run, all in this repo. Nothing here is optional except MultiBaas.

| | what | port | holds secrets |
|---|---|---|---|
| `contracts/` | CrossPermit, the Universal Router, LiquidityDesk, test tokens, a v4 pool per chain | — | a deployer key, at deploy time only |
| `apps/relayer` | one POST, N chains: admission, simulation, SSE, client mandates | 8787 | the relayer's signing key, MultiBaas keys |
| `apps/web/src/desk` | the multi-manager gatehouse, mounted at `/api/desk` inside the app: wallet sign-in, scoped books, desk registry, pool reads | — | the relayer's API key |
| `apps/web` | landing page, desk console at `/app`, the client's mandate page at `/c/<token>` | 3000 | **nothing** |

The shape that matters: **only `apps/web` faces the public.** The desk layer sits behind it through a
Next rewrite, and the relayer sits behind the desk layer. Nothing on the internet should be able to
reach 8787 directly — it takes an API key, and that key is the whole desk.

```
public ──▶ apps/web :3000 ──/api/desk/* (in-process) ──Bearer key──▶ apps/relayer :8787 ──▶ chains
```

## Prerequisites

- **Bun** 1.3.11 or newer (`engines.bun`). The relayer and the desk layer are Bun servers.
- **Node** v22.14.0 or newer, for the toolchain only.
- **Foundry** `forge` 1.8.1 (`forge`, `cast`), only if you are deploying contracts.
- **The git submodules.** `contracts/lib/*` are submodules; clone with `--recursive`, or run
  `git submodule update --init --recursive`. Without them `forge build` dies on 17 unresolved
  imports.
- **An RPC URL per chain.** Public endpoints work but load-balance across nodes, so a read issued
  immediately after a receipt can be answered by a node that has not seen that block. Use a dedicated
  endpoint for anything that reads its own writes.
- **A funded key** on each chain for the relayer's gas, and another for the deployer.
- **MultiBaas** (optional). Without it the relayer runs on a local key and the treasury/activity
  screens have no event ledger — which the UI says on screen rather than rendering as "nothing here".

## 1. Environment

One `.env` at the repo root feeds the contracts, the relayer and the scripts. `apps/web` has its own
`.env.local`. Both are gitignored.

```bash
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
```

### Root `.env`

| var | who reads it | notes |
|---|---|---|
| `PRIVATE_KEY` | forge scripts, deploy scripts, demos | the deployer. **Secret.** |
| `SALT` | `DeployCrossPermit.s.sol` | `keccak256("CrossPermit v1")` for the live deployment. Changing it changes the address on every chain, which breaks signature portability. |
| `RPC_ETH_SEPOLIA`, `RPC_BASE_SEPOLIA`, `RPC_OP_SEPOLIA` | relayer, scripts | a chain with no RPC is skipped and the relayer says so at boot |
| `RELAYER_CHAINS` | relayer | comma-separated chain ids to serve. Default `11155111,84532,11155420`. |
| `RELAYER_PRIVATE_KEY` | relayer | pays gas. **Secret.** Not needed if every chain has a MultiBaas Cloud Wallet. |
| `RELAYER_PORT` | relayer | default 8787 |
| `RELAYER_API_KEYS` | relayer | comma-separated. Empty means **open** — anyone can submit intents and read every mandate. |
| `RELAYER_DB` | relayer | sqlite path, default `apps/relayer/relayer.sqlite` |
| `RELAYER_MIN_SECONDS_LEFT` | relayer | refuse an intent expiring mid-fan-out. Default 60. |
| `RELAYER_MAX_INTENTS_PER_WINDOW`, `RELAYER_MAX_GAS_WEI_PER_WINDOW`, `RELAYER_WINDOW_MS` | relayer | per-**owner** limits, because the owner is the only identity a signature proves |
| `RELAYER_CORS_ORIGIN` | relayer | set it in production; the default is `*` |
| `MULTIBAAS_URL`, `MULTIBAAS_API_KEY`, `MULTIBAAS_CHAIN_ID` | relayer, treasury reads | per-chain variants: `MULTIBAAS_URL_<CHAINID>`, `MULTIBAAS_API_KEY_<CHAINID>` |
| `MULTIBAAS_CHAIN` | MultiBaas adapter | the network's MultiBaas name. Default `ethereum`. |
| `DESK_URL` | `apps/web/scripts/{lifecycle,live-smoke}.ts` | which desk the scripts drive. Default `http://localhost:3000/api/desk`, i.e. through the Next rewrite. |
| `SIZE`, `SMOKE_OWNER` | the same two scripts | mandate size and the owner whose allowances the smoke script reads |

`MULTIBAAS_WEBHOOK_SECRET` and `DESK_DB` used to be listed here. Nothing in the tree reads
either; both rows are gone. `.env.example` marks every remaining variable REQUIRED or OPTIONAL
with the default that is compiled in.

### the desk layer (environment, read by `apps/web`)

| var | notes |
|---|---|
| `RELAYER_URL` | default `http://localhost:8787`. **Optional locally, required on a serverless host** — same detection as Turso below. |
| `RELAYER_API_KEY` | one of the relayer's keys. **Secret, and the only place it should ever live besides the relayer.** |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | where the desk keeps managers, sessions, nonces and client links. **Optional locally** — unset falls back to a local `.desk.db` file. **Required on a serverless host**: `apps/web/src/desk/db.ts` detects `VERCEL` / `AWS_LAMBDA_FUNCTION_NAME` and refuses the file fallback, because a filesystem that does not survive the request is not a database. |
| `DESK_ROUTERS` | `{"84532":"0x…"}`. Overrides the built-in testnet routers. A wrong value is loud (a real router shows as `unrecognised spender`), never quiet. |
| `DESK_INSECURE_COOKIE=1` | drops `Secure` from the session cookie. **Development only.** Over plain http without it, nobody can sign in. |

### `apps/web/.env.local`

| var | notes |
|---|---|
| `NEXT_PUBLIC_WC_PROJECT_ID` | Reown project id. Public by design. Without it only injected wallets connect, and the UI says so. |
| `NEXT_PUBLIC_RELAYER_URL` | display only — printed on the platform panel so an operator can see which relayer is behind the layer |
| `RELAYER_URL` / `RELAYER_API_KEY` | the relayer as the desk sees it. **Server-side only**; the browser never learns either. |

There is deliberately no API key here. If you find `NEXT_PUBLIC_RELAYER_API_KEY` in a deployment, it
is stale — it shipped in the client bundle, which made anyone who could open the console the desk.
Nothing sets it today: the browser talks to `/api/desk` and the key lives only server-side.

### What a deployed host refuses

`RELAYER_URL` and `TURSO_DATABASE_URL` are optional locally and **required** once the app detects
`VERCEL` or `AWS_LAMBDA_FUNCTION_NAME`. With either missing, the desk layer answers every
`/api/desk/*` request with **503 `{"code":"not_configured"}`** naming the variable, before it reads
anything, and writes the same sentence to the log at cold start. The failure is one loud refusal at
the first request rather than a dashboard of zeros — which is the point, because a page of zeros and
a page of "nothing is outstanding" look identical.

## 2. Contracts (skip if you are using the live deployment)

The addresses in the root README are already live on all three testnets. To deploy your own:

```bash
bun install
cd contracts && forge build && cd ..

script/deploy.sh all          # CrossPermit via ERC-2470, then the Universal Router per chain
bun packages/sdk/scripts/deploy-liquidity.ts    # the v4 LP adapter, one per chain
```

Both are idempotent — they check for code at the expected address and skip. Results are cached in
`deployments/*.json`, which the relayer and the dashboard read; `deployments/crosspermit.json` is how
the relayer learns its own verifying contract.

**CrossPermit must land at the same address on every chain.** Identical init code, identical salt,
same ERC-2470 factory. The EIP-712 domain pins `chainId = 1` so one signature ports everywhere, but it
still includes `verifyingContract` — a different address on one chain silently breaks that chain.

If you deploy your own, update `apps/web/src/config.ts` (`CROSS_PERMIT`, per-chain `router`, `tokens`)
and `apps/web/src/pools.ts` (`POOLS`). Both are hard-coded rather than fetched on purpose: a UI that
learns its verifying contract from the network would sign against whatever the network claimed.

### MultiBaas, if you use it

```bash
set -a && . ./.env && set +a
cd contracts && forge build && cd ..                     # the artifact the registration reads
bun packages/multibaas/scripts/register-crosspermit.ts   # the CrossPermit ABI, linked per chain
bun packages/multibaas/scripts/install-queries.ts        # the saved event query the ledger is defined by
bun packages/multibaas/scripts/register-liquidity.ts     # so LiquidityDesk events are indexed
```

**`register-crosspermit.ts` is not optional if you want a ledger.** It uploads the CrossPermit ABI
and links the address on every chain in `RELAYER_CHAINS` with an explicit `startingBlock`, which is
what turns each `Permit` into a decoded row instead of calldata. It is idempotent, it reads
`listAddresses` back so `linked` is verified rather than assumed, and it exits 1 if any chain failed
to link. Skipping it leaves the treasury, activity and audit screens permanently empty even though
every call succeeded — omitting `startingBlock` has the same silent effect, which is why the script
always passes one. `smoke.ts` calls the same exported `registerCrossPermit()`; running the smoke
test is not the way to get your events indexed.

Without the saved query the treasury and activity screens have no ledger to read.

## 3. Run the three services

Order matters only in that each needs the one behind it.

```bash
set -a && . ./.env && set +a

# 1. relayer
bun apps/relayer/src/server.ts

# 2. the desk layer needs no process of its own: apps/web serves it at /api/desk.
#    It just needs the relayer's key in its environment — apps/web is the only process
#    that should ever hold it.

# 3. web
cd apps/web
RELAYER_URL=http://localhost:8787 \
  RELAYER_API_KEY="$RELAYER_API_KEY" \
  DESK_INSECURE_COOKIE=1 \
  bun run dev                         # or: bun run build && bunx next start -p 3000
```

The previous version of this block ended a line-continuation backslash on a `#` comment, so the
shell swallowed `DESK_INSECURE_COOKIE` and sign-in failed silently over plain http — exactly the
symptom listed at the bottom of this file. Keep the continuations unbroken, or export the three
variables first.

The relayer prints its custody model, its chains and its admission limits at boot. Read that banner —
it is the only place that says whether it is signing with a local key or a Cloud Wallet.

## 4. Verify, in this order

```bash
curl localhost:8787/healthz                      # relayer
curl localhost:3000/api/desk/healthz             # desk layer, and which relayer it is behind
curl -o /dev/null -w '%{http_code}\n' localhost:3000/app

cd apps/web && bun test test/                    # 17 offline tests for the desk layer, 2 files
bun scripts/live-smoke.ts                        # two managers, real signatures, every refusal

# the whole product, on Base Sepolia, through the web origin so the rewrite is exercised too
cd ../.. && set -a && . ./.env && set +a
bun apps/web/scripts/lifecycle.ts --size 1.0
```

`lifecycle.ts` ends in `FULL LIFECYCLE PASSED` or names the step that failed. It needs a funded client
key (`PRIVATE_KEY`) holding both pool tokens with an ERC-20 approval to CrossPermit, and a funded
manager key (`RELAYER_PRIVATE_KEY`) for the `add` transaction.

Then, in a browser: open `/app`, press **Connect & prove**, sign once (no gas), register your
LiquidityDesk per chain, open a client link, and send the link to a client.

## 5. Production notes

These are the differences that matter, not a checklist of generalities.

- **Do not expose the relayer.** Same host, a private network, or a firewall. Its API key is the desk,
  and `GET /v1/clients/:token`, `GET /v1/treasury/:owner`, `GET /v1/activity/:owner` and
  `GET /v1/intents/:id` (plus its SSE stream) are open on it by design — the desk layer is what gates
  them. The layer is a front door, not a firewall.
- **Three routes moved behind the key.** `POST /v1/clients/:token/link`, `GET /v1/intents` (the
  collection, not `/v1/intents/:id`) and `GET /v1/quota/:addr` now require the desk key when
  `RELAYER_API_KEYS` is set. The link POST overwrites `capUnits`, `ttlHours` and `chainIds` from its
  body, so it is a desk write made on the client's behalf, not something the client's signature
  authorises. The route map at the top of `apps/relayer/src/server.ts` is the current list.
- **Receipts wait for 2 confirmations.** A leg reaches `confirmed` a block later than it used to, and
  a reorged-out block no longer leaves a permanent `confirmed` row. A leg whose receipt was never seen
  stays `submitted`, emits an SSE event carrying the reason, records a `broadcastAt`, and is listed in
  the boot-time stranded report — never auto-retried, because it may have a transaction in the
  mempool. The `legs` table gained `broadcastAt`; existing `relayer.sqlite` files migrate in place.
- **Drop `DESK_INSECURE_COOKIE`.** Serve `apps/web` over HTTPS and the session cookie gets `Secure`.
- **Set `RELAYER_CORS_ORIGIN`** to your web origin. The default `*` is a development convenience.
- **`LiquidityDesk.add` is gated on chain, and the deployed desks predate the gate.**
  `contracts/src/LiquidityDesk.sol:113` refuses any caller who is neither the `owner` nor an address
  that owner registered through `setOperator(address,bool)`, reverting `NotAuthorised(owner, caller)`.
  It has to: the caller supplies `key` as well as `owner`, so an open `add` let anyone name a pool of
  their own construction and settle the victim's whole allowance into it. The three addresses in
  `deployments/liquidity-*.json` carry the **ungated** bytecode — redeploy before pointing anyone at
  them, and note that `packages/sdk/scripts/liquidity-demo.ts` and the dashboard's **Add to the pool**
  button do not yet call `setOperator`, so they will revert against a gated desk.
- **CrossPermit's own bytecode changed too, and the deployed one is the old one.** `AllowanceLedger`
  and `MultiTokenTransfer` compile into `CrossPermit`, and both were patched (a `Spend` event, and a
  locked per-tokenId key no longer falling through to the collection allowance). The live
  `0x659C6F02…de1B` has neither. Redeploying changes the init code, so the pinned salt lands at a new
  address and the domain separator moves with it — treat it as a migration, not a bump.
- **Still one LiquidityDesk deployment per manager.** A shared deployment does not destroy custody —
  funds only enter a position salted to the client, and only the client can `remove` — but it
  destroys attribution. The desk registry refuses a second claim on one address for that reason.
- **Back up the relayer's store and the desk's.** The relayer's is `apps/relayer/relayer.sqlite`
  (mandates, intents, legs) — override with `RELAYER_DB`. The desk's is Turso in production
  (`TURSO_DATABASE_URL`, back it up there) and a local `.desk.db` in `apps/web`'s working directory
  otherwise; it holds managers, the desk registry and which client belongs to whom. There is no
  `desk.sqlite` — that name appeared in an earlier version of this file and no code ever wrote it.
  Neither store holds authority — that is on chain — but losing the desk db means losing every
  manager's book. SQLite files use WAL, so copy all three (`-wal`, `-shm`) or use `sqlite3 .backup`.
- **Mandates that predate the desk layer** belong to no manager and are therefore invisible to
  everyone. Assign them once, with the relayer's key rather than a session:
  ```bash
  bun apps/web/scripts/import.ts <manager-address> --name "Desk name" --all
  ```
  It refuses to reassign a mandate another manager already holds, and says which.
- **Rotate `RELAYER_API_KEYS`** by adding the new key, restarting the desk layer with it, then dropping
  the old one. The relayer accepts a comma-separated set, so there is no window with no valid key.

## Further reading

- [`docs/runbook.md`](docs/runbook.md) — key rotation, the kill switch, incident response, and what
  to say publicly during an outage.
- [`docs/threat-model.md`](docs/threat-model.md) — named attacks, the answer to each, and the
  residual that is left.
- [`docs/multibaas.md`](docs/multibaas.md) — every MultiBaas feature with a verdict and the reason.

## Things that will confuse you once

- **`apps/web` returns 500 with `ENOENT … .next/routes-manifest.json`.** Two processes raced on the
  build directory. `pkill -f "next dev"; rm -rf apps/web/.next`, then start one.
- **A transaction succeeded but the page or a script says nothing changed.** A public RPC endpoint is a
  load balancer; a read issued the instant a receipt arrives gets answered by a node that has not seen
  that block. `lifecycle.ts` pins every read to `receipt.blockNumber` and waits for the node to reach
  it — do the same in anything that reads its own writes.
- **`409 desk_shared` when registering a desk.** Another manager here registered that address. That is
  the check working: deploy your own adapter.
- **Sign-in fails silently over plain http.** The cookie has `Secure` and the browser drops it. Set
  `DESK_INSECURE_COOKIE=1` for local development.
- **A wallet refuses to sign the writ.** The CrossPermit domain pins `chainId = 1`, and MetaMask
  rejects `eth_signTypedData_v4` whose domain chain is not the active one. The app switches the wallet
  to chain 1 first; nothing is ever broadcast there.
