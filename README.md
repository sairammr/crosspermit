# CrossPermit

**One signature. Every chain.**

A user signs **one** EIP-712 message. That signature sets token allowances and executes transfers on
Ethereum Sepolia, Base Sepolia and Optimism Sepolia; a relayer submits all three legs from one HTTP
request; and a Uniswap Universal Router deployed with `permit2 := CrossPermit` spends them —
including a **real Uniswap v4 swap on each chain**, settled out of that allowance.

On top of that sits the desk: a fund manager adds a client, sends them one link, and the client's
single signature arms a bounded, revocable mandate on every chain — after which the desk allocates
it. MultiBaas carries custody and audit, Aave v4 the yield, and there is a desk for tokenized
equities.

Today an institution moving collateral across four chains signs four times, from four wallet
sessions, each one a separate approval risk and a separate line in the audit log. CrossPermit
collapses that to one signature and one audit record.

## How it works

1. **CrossPermit lives at the same address on every chain.** Deployed through the ERC-2470 singleton
   factory, so identical init code plus an identical salt gives an identical address. That matters
   because the EIP-712 domain pins `chainId = 1` but still includes `verifyingContract` — the
   signature is only portable if the address is.
2. **The client builds one permit bundle per chain**, computes each bundle's leaf itself (an
   `eth_call` to `hashChainPermits` is kept only as an equality assertion — a leaf that came *from*
   an RPC would let a hostile endpoint choose what the user signs), and folds the leaves into a
   left-leaning merkle tree. The last leaf sits one hop from the root, so it carries the shortest
   proof — put the most expensive chain last.
3. **The user signs the root. Once.**
4. **On each chain**, anyone submits that chain's bundle plus its proof. CrossPermit rebuilds the
   root with OpenZeppelin sorted-pair hashing, recovers the signer, and applies the bundle.
5. **The router spends the allowance.** It is Uniswap's own router with exactly one thing changed:
   `permit2` points at CrossPermit. CrossPermit's `transferFrom` overloads are selector-identical to
   Permit2's, so the router's payment path is unmodified.

## Deployed and proved live

**CrossPermit — `0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B` on all three chains.**
Salt `0xb2af67d67b308054b26d8fb210cab127bf699e936190ed01dd9052e7736d1c8c` (`keccak256("CrossPermit v1")`),
via ERC-2470, solc 0.8.27 / optimizer 1e6 runs.

| Chain | chainId | Router (`permit2 := CrossPermit`) |
|---|---|---|
| Ethereum Sepolia | 11155111 | [`0x7B68d6740C5C66967271966E62fd1A3E01743E3c`](https://sepolia.etherscan.io/address/0x7B68d6740C5C66967271966E62fd1A3E01743E3c) |
| Base Sepolia | 84532 | [`0x73ed10744987B65fAf6BD6FFdF1039Cb7eF97002`](https://sepolia.basescan.org/address/0x73ed10744987B65fAf6BD6FFdF1039Cb7eF97002) |
| Optimism Sepolia | 11155420 | [`0x2E03912851a0e442C77Ce00506aA7664E45560Ac`](https://sepolia-optimism.etherscan.io/address/0x2E03912851a0e442C77Ce00506aA7664E45560Ac) |

Optimism Sepolia was added after the fact, which is the strongest evidence the scheme works: the
same init code and the same salt put CrossPermit at the **same address** on a chain it had never
touched, and its `DOMAIN_SEPARATOR` came back byte-identical to the other two without any
coordination. Unichain Sepolia was dropped because MultiBaas does not support it, so a chain there
could never carry a control-plane audit trail.

`PERMIT2` is an internal immutable with no getter, so the substitution is confirmed three ways: the
deploy log, the constructor arguments in each broadcast artifact, and the CrossPermit address
appearing four times (once per use site) in each router's deployed runtime bytecode.

Read live off all three deployments — the invariant the whole scheme rests on:

```
DOMAIN_SEPARATOR()             0x4ce820a58ffb00fe1b6cb52f083bdd1cfd176732c34db34a84517668750aa5e4
SIGNED_CROSSPERMIT_TYPEHASH()  0x2b8986532571ca462e751db5072ea926966480857f91eebafcc04d28b5a33c3d
CANCEL_CROSSPERMIT_TYPEHASH()  0x184e9b675fc89b0718770fb9e1bf1ebdfe0780b451ab8ed5b69ffdb0c83655ea
```

Identical on Ethereum, Base and Optimism Sepolia, because the domain pins `chainId = 1` and the
CREATE2 address is the same everywhere.

### The v4 swap, and why it is the check that matters

`PERMIT2_TRANSFER_FROM` proves the router's `PERMIT2` immutable is CrossPermit, but it is not a path
a dApp uses. `V4_SWAP` is: the router hands the swap to `V4SwapRouter`, whose `SETTLE_ALL` pays the
`PoolManager` through `_payStandard -> payOrPermit2Transfer -> PERMIT2.transferFrom`. A swap that
settles therefore proves the substitution **on the real payment path**, against Uniswap's own live
`PoolManager`.

Every live run returns 996 999 of the output token for 1 000 000 in — the pool's 0.3% fee. The
allowance ends at zero, and the router holds no plain ERC20 approval, so the input can only have come
through CrossPermit.

### Aave v4 and tokenized equities, against live mainnet

10 000 USDC in through a CrossPermit allowance, thirty days on, **10 032.65 USDC out** — against Aave
v4's real Core Hub and MAIN Spoke. Supply APR 3.976%, APY 4.056%, utilisation 90.16%. Ondo's real
`NVDAon` is read live in the same suite.

## Layout

## The desk

```
add a client  ->  send one link  ->  they sign once  ->  you allocate
```

A **mandate** is an invitation, not authority. `POST /v1/clients` stores what the desk intends to
ask for and returns a link; nothing can move until the client opens `/c/<token>` and signs. That is
why reading a mandate by its token needs no key while creating and listing sit behind the desk's
own key: the link carries an offer, and whoever holds it can only sign *their own* permission with
it.

The mandate page renders every per-chain bundle in plain language, from values computed on the
page, before the wallet is ever opened — including the allowance already outstanding to that
spender, because an entry carrying an expiry is an **increase**, so the cap alone would understate
what is being granted.

Claiming a link is one conditional statement, so two people racing it cannot both win, and binding
requires an intent the relayer already holds under that owner's name. Withdrawing a link says out
loud that it does not revoke a signed allowance: those are different acts and only one of them
closes exposure.

Prove the whole loop against the live testnets:

```bash
set -a && . ./.env && set +a
bun run apps/relayer/src/server.ts &
bun run packages/sdk/scripts/onboard.ts
```

Twenty-two checks: the cap survives the round trip exactly, each chain agrees with the leaf computed
on the client, one 65-byte signature covers every chain, a second claim on the same link is refused,
an unknown intent cannot bind a mandate, and the allowance on each chain rises by exactly the cap
that was offered.

## Layout

```
contracts/src/            CrossPermit core: the allowance ledger, salt registry, multi-token transfers
contracts/src/treasury/   YieldRouter (Aave v4) and EquityDesk (tokenized equities)
contracts/test/           forge suite: cross-chain flow, encoding parity, live-chain fork proofs
packages/sdk/             the client: bundles, leaves, merkle tree, the one signature, cancellation
packages/multibaas/       MultiBaas control plane: custody, indexing, allowance ledger, audit trail
apps/relayer/             one POST, N chains; admission control, simulation, SSE, client mandates
apps/web/                 the landing page, the desk, and the client's mandate page
script/deploy.sh          deterministic CrossPermit deploy, then the router
script/test.sh            every offline check, in the order a change should break it
PLAN.md                   the full build plan, phase by phase, and what is still a limitation
```

## Run it

```bash
cp .env.example .env          # fill in PRIVATE_KEY and the RPCs
bun install
cd contracts && forge build && cd ..

# every offline check
script/test.sh

# the live-chain proofs: v4 swaps on three testnets, Aave v4 and NVDAon on mainnet. No broadcast.
cd contracts && FORK=1 forge test --match-path 'test/*Fork*' -vv

# deploy (only needed once; the addresses above are already live)
script/deploy.sh all

# the full lifecycle, eight stages, against the live testnets
set -a && . ./.env && set +a
bun run packages/sdk/scripts/lifecycle.ts

# one click: start the relayer, then drive the same flow through one POST
bun run apps/relayer/src/server.ts &
bun run packages/sdk/scripts/lifecycle.ts --only authorize --via-relayer http://localhost:8787

# the site: landing page, the desk at /app, a client's mandate at /c/<token>
cp apps/web/.env.example apps/web/.env.local   # a Reown project id, and the desk's relayer key
cd apps/web && bun run build && bunx next start -p 3100
```

The dashboard also takes `?owner=0x...` for a read-only view of someone else's
outstanding authority — a risk officer reviewing an account should not need its
keys, and the treasury and audit screens are reads with nothing to sign.

## The lifecycle

`packages/sdk/scripts/lifecycle.ts` runs eight stages against the live testnets, every one a real
state transition, and every grant or revocation carried by **one** signature across all three chains:

| stage | what it proves |
|---|---|
| `setup` | chain ids, deployed code, a funded test token, a real Uniswap v4 pool per chain |
| `authorize` | one signature ⇒ allowances on three chains, plus an immediate signed transfer on one |
| `spend` | the router pulls and then swaps, both settled out of that one allowance |
| `decrease` | one signature retires the leftover allowance everywhere |
| `lock` | one signature disables the router on every chain — proved by a pull that now reverts |
| `unlock` | one signature restores it, and the router spends again |
| `cancel` | a signed permit is retracted on every chain **before** submission, and can never be redeemed |
| `report` | per-chain table with explorer links |

## Security posture

- **The leaf is computed client-side. Always.** Any change that lets a leaf arrive from an RPC is a
  vulnerability, not a refactor.
- **The relayer is a convenience, never a dependency.** It can pay gas, order its own submissions and
  refuse to submit. It cannot change who receives a transfer, who gets an allowance, or how much —
  all of that is inside the signed bundle. Every flow stays completable by the client alone.
- **Simulate before broadcast**, everywhere, without exception.
- **Admission control is on by default in production.** With no `RELAYER_API_KEYS` set the relayer
  runs open and says so loudly at boot; per-owner rate and gas budgets apply either way.
- **Pinned dependencies are load-bearing.** Bumping a submodule changes the init code and therefore
  the address. Treat it as a migration.
- **APR and APY are labelled distinctly** in every ABI, API response and pixel.
- **Compliance gates default to deny**, and an unset gate denies everything.
- **The signed ordering timestamp is set behind wall clock.** CrossPermit rejects a permit that
  orders itself into the future, and a chain's head block is routinely a few seconds old — Ethereum
  builds one every twelve seconds. Signing with `Date.now()` fails intermittently on slow chains and
  never on fast ones, which is the worst shape a bug can have. `TIMESTAMP_LAG` is a constant offset,
  so ordering between intents is untouched.

Known limitations, and what is deliberately not yet proved, are in [`PLAN.md`](PLAN.md) and
[`docs/threat-model.md`](docs/threat-model.md).

## Licence

MIT. The cross-chain allowance core is a derivative work of MIT-licensed software; see
[`NOTICE`](NOTICE).
