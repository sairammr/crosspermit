# Deploying CrossPermit

Four things run, all in this repo. Nothing here is optional except MultiBaas.

| | what | port | holds secrets |
|---|---|---|---|
| `contracts/` | CrossPermit, the Universal Router, LiquidityDesk, test tokens, a v4 pool per chain | — | a deployer key, at deploy time only |
| `apps/relayer` | one POST, N chains: admission, simulation, SSE, client mandates | 8787 | the relayer's signing key, MultiBaas keys |
| `apps/desk` | the multi-manager gatehouse: wallet sign-in, scoped books, desk registry, pool reads | 8788 | the relayer's API key |
| `apps/web` | landing page, desk console at `/app`, the client's mandate page at `/c/<token>` | 3000 | **nothing** |

The shape that matters: **only `apps/web` faces the public.** The desk layer sits behind it through a
Next rewrite, and the relayer sits behind the desk layer. Nothing on the internet should be able to
reach 8787 directly — it takes an API key, and that key is the whole desk.

```
public ──▶ apps/web :3000 ──/api/desk/*──▶ apps/desk :8788 ──Bearer key──▶ apps/relayer :8787 ──▶ chains
```

## Prerequisites

- **Bun** 1.3 or newer. The relayer and the desk layer are Bun servers and use `bun:sqlite`.
- **Foundry** (`forge`, `cast`), only if you are deploying contracts.
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
| `RELAYER_CHAINS` | relayer | comma-separated chain ids to serve |
| `RELAYER_PRIVATE_KEY` | relayer | pays gas. **Secret.** Not needed if every chain has a MultiBaas Cloud Wallet. |
| `RELAYER_PORT` | relayer | default 8787 |
| `RELAYER_API_KEYS` | relayer | comma-separated. Empty means **open** — anyone can submit intents and read every mandate. |
| `RELAYER_DB` | relayer | sqlite path, default `apps/relayer/relayer.sqlite` |
| `RELAYER_MIN_SECONDS_LEFT` | relayer | refuse an intent expiring mid-fan-out. Default 60. |
| `RELAYER_MAX_INTENTS_PER_WINDOW`, `RELAYER_MAX_GAS_WEI_PER_WINDOW`, `RELAYER_WINDOW_MS` | relayer | per-**owner** limits, because the owner is the only identity a signature proves |
| `RELAYER_CORS_ORIGIN` | relayer | set it in production; the default is `*` |
| `MULTIBAAS_URL`, `MULTIBAAS_API_KEY`, `MULTIBAAS_CHAIN_ID` | relayer, treasury reads | per-chain variants: `MULTIBAAS_URL_<CHAINID>`, `MULTIBAAS_API_KEY_<CHAINID>` |
| `MULTIBAAS_WEBHOOK_SECRET` | webhook verification | **Secret.** |

### `apps/desk` (environment, no file of its own)

| var | notes |
|---|---|
| `RELAYER_URL` | default `http://localhost:8787` |
| `RELAYER_API_KEY` | one of the relayer's keys. **Secret, and the only place it should ever live besides the relayer.** |
| `DESK_PORT` | default 8788 |
| `DESK_DB` | sqlite path, default `desk.sqlite` in the process's working directory — set it explicitly |
| `DESK_ROUTERS` | `{"84532":"0x…"}`. Overrides the built-in testnet routers. A wrong value is loud (a real router shows as `unrecognised spender`), never quiet. |
| `DESK_INSECURE_COOKIE=1` | drops `Secure` from the session cookie. **Development only.** Over plain http without it, nobody can sign in. |

### `apps/web/.env.local`

| var | notes |
|---|---|
| `NEXT_PUBLIC_WC_PROJECT_ID` | Reown project id. Public by design. Without it only injected wallets connect, and the UI says so. |
| `NEXT_PUBLIC_RELAYER_URL` | display only — printed on the platform panel so an operator can see which relayer is behind the layer |
| `DESK_URL` | where the desk layer listens. **Server-side only**; the browser never learns it. |

There is deliberately no API key here. If you find `NEXT_PUBLIC_RELAYER_API_KEY` in a deployment, it
is stale — it shipped in the client bundle, which made anyone who could open the console the desk.

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
bun packages/multibaas/scripts/install-queries.ts      # the saved event query the ledger is defined by
bun packages/multibaas/scripts/register-liquidity.ts   # so LiquidityDesk events are indexed
```

Without the saved query the treasury and activity screens have no ledger to read.

## 3. Run the three services

Order matters only in that each needs the one behind it.

```bash
set -a && . ./.env && set +a

# 1. relayer
bun apps/relayer/src/server.ts

# 2. desk layer — give it the relayer's key; it is the only process that should have it
RELAYER_URL=http://localhost:8787 \
RELAYER_API_KEY="$RELAYER_API_KEY" \
DESK_DB="$PWD/apps/desk/desk.sqlite" \
DESK_INSECURE_COOKIE=1 \
bun apps/desk/src/server.ts

# 3. web
cd apps/web && bun run dev            # or: bun run build && bunx next start -p 3000
```

The relayer prints its custody model, its chains and its admission limits at boot. Read that banner —
it is the only place that says whether it is signing with a local key or a Cloud Wallet.

## 4. Verify, in this order

```bash
curl localhost:8787/healthz                      # relayer
curl localhost:8788/healthz                      # desk layer, and which relayer it is behind
curl -o /dev/null -w '%{http_code}\n' localhost:3000/app

cd apps/desk && bun test                         # 17 offline tests
DESK_URL=http://localhost:8788 bun scripts/live-smoke.ts    # two managers, real signatures, every refusal

# the whole product, on Base Sepolia, through the web origin so the rewrite is exercised too
cd ../.. && set -a && . ./.env && set +a
bun apps/desk/scripts/lifecycle.ts --size 1.0
```

`lifecycle.ts` ends in `FULL LIFECYCLE PASSED` or names the step that failed. It needs a funded client
key (`PRIVATE_KEY`) holding both pool tokens with an ERC-20 approval to CrossPermit, and a funded
manager key (`RELAYER_PRIVATE_KEY`) for the `add` transaction.

Then, in a browser: open `/app`, press **Connect & prove**, sign once (no gas), register your
LiquidityDesk per chain, open a client link, and send the link to a client.

## 5. Production notes

These are the differences that matter, not a checklist of generalities.

- **Do not expose the relayer.** Same host, a private network, or a firewall. Its API key is the desk,
  and `GET /v1/clients/:token`, `GET /v1/treasury/:owner` and `GET /v1/activity/:owner` are open on it
  by design — the desk layer is what gates them. The layer is a front door, not a firewall.
- **Drop `DESK_INSECURE_COOKIE`.** Serve `apps/web` over HTTPS and the session cookie gets `Secure`.
- **Set `RELAYER_CORS_ORIGIN`** to your web origin. The default `*` is a development convenience.
- **One LiquidityDesk deployment per manager.** `add(owner, …)` has no caller check, so a shared
  deployment lets every manager on it spend every bound client's allowance — bounded (funds can only
  enter a position salted to the client, and only the client can `remove`) but it destroys
  attribution. The desk registry refuses a second claim on one address for exactly this reason.
- **Back up two sqlite files**: `apps/relayer/relayer.sqlite` (mandates, intents) and the desk layer's
  `desk.sqlite` (managers, desk registry, which client belongs to whom). Neither holds authority —
  that is on chain — but losing the desk db means losing every manager's book. Both use WAL, so copy
  all three files (`-wal`, `-shm`) or use `sqlite3 .backup`.
- **Mandates that predate the desk layer** belong to no manager and are therefore invisible to
  everyone. Assign them once, with the relayer's key rather than a session:
  ```bash
  bun apps/desk/scripts/import.ts <manager-address> --name "Desk name" --all
  ```
  It refuses to reassign a mandate another manager already holds, and says which.
- **Rotate `RELAYER_API_KEYS`** by adding the new key, restarting the desk layer with it, then dropping
  the old one. The relayer accepts a comma-separated set, so there is no window with no valid key.

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
