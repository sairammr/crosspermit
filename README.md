# CrossPermit

**One signature. Every chain.**

| | |
|---|---|
| **Live app** | <https://crosspermit.vercel.app/> |
| **CrossPermit — same address on all three chains** | [`0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B`](https://sepolia.etherscan.io/address/0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B) on Ethereum Sepolia · [Base Sepolia](https://sepolia.basescan.org/address/0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B) · [Optimism Sepolia](https://sepolia-optimism.etherscan.io/address/0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B) |
| **Demo video** | _not recorded yet — link goes here_ |

A user signs **one** EIP-712 message. That signature sets token allowances and executes transfers on
Ethereum Sepolia, Base Sepolia and Optimism Sepolia; a relayer submits all three legs from one HTTP
request; and a Uniswap Universal Router deployed with `permit2 := CrossPermit` spends them —
including a **real Uniswap v4 swap on each chain**, settled out of that allowance.

On top of that sits the desk: a fund manager adds a client, sends them one link, and the client's
single signature arms a bounded mandate on every chain — after which the desk allocates it.
MultiBaas carries custody and audit, Aave v4 the yield, and there is a desk for tokenized equities.

## Why this does not already exist

Permit2 is at the same address on every chain, and its signature still cannot leave one. An EIP-712
digest commits to the domain, and the domain commits to a `chainId`, so a signature valid on Base is
not a signature at all on Arbitrum. Four chains means four signatures, four wallet sessions, four
approval risks and four audit lines for what a risk committee decided once.

Everything built to cross chains so far moved *tokens*. Bridges answer "my money is on the wrong
chain." Nobody answered "my **authority** is on the wrong chain," so the workaround has always been
pre-positioned capital plus a fresh signature per chain, forever.

CrossPermit moves the permission instead. One signature, over a merkle root of per-chain permit
bundles, verified independently on every chain by a contract that lives at the same address on all
of them with `chainId = 1` pinned into its domain. The ledgers stay separate, because storage is
per-chain and cannot be otherwise; the authorisation is single. **Nothing is bridged** — no token
crosses anything — which is why this carries no bridge's risk.

## Provenance

The cross-chain allowance core in `contracts/src/` is a derivative work of **Eco's MIT-licensed
Permit3**: the allowance ledger, the salt registry, the multi-token transfer surface, the merkle
verification and the witness path come from there, renamed and restructured, with the EIP-712 domain
and every typehash changed so the two are distinct signing domains. `NOTICE` carries the
attribution the MIT licence requires. Say it out loud rather than let a reader discover it:

**Inherited** — the allowance/lock storage (`AllowanceLedger`), the salt registry (`SaltRegistry`),
the multi-token transfer surface (`MultiTokenTransfer`), the merkle-root permit mechanism itself, the
ERC-7702 approver module.

**Built for this hackathon** — the ERC-2470 tri-chain deterministic deploy and the proof that the
address and domain separator reproduce on a chain added after the fact (`script/deploy.sh`); the
`permit2 := CrossPermit` Universal Router substitution and the v4 swap that proves it on the real
settle path; `LiquidityDesk`, the v4 unlock-callback adapter that pays a client's LP position out of
their own writ; `contracts/src/treasury/*` (Aave v4 yield, tokenized-equity desk); the whole SDK
(`packages/sdk`); the relayer (`apps/relayer`); the MultiBaas control plane (`packages/multibaas`);
and the desk product (`apps/web`).

## Contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Deployed addresses](#deployed-addresses)
- [What is real, and what is demo scope](#what-is-real-and-what-is-demo-scope)
- [Run it](#run-it)
- [LiquidityDesk — the same writ, providing liquidity](#liquiditydesk--the-same-writ-providing-liquidity)
- [The v4 swap, and why it is the check that matters](#the-v4-swap-and-why-it-is-the-check-that-matters)
- [Aave v4 and tokenized equities, on a mainnet fork](#aave-v4-and-tokenized-equities-on-a-mainnet-fork)
- [The desk](#the-desk)
- [The lifecycle](#the-lifecycle)
- [Trust model](#trust-model)
- [Layout](#layout)
- [Licence](#licence)

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
4. **Each chain then runs four checks, in this order.** They are what the security actually rests
   on, and the merkle root is not among them — `MerkleProof.processProof` never reverts, it just
   folds whatever proof the caller supplied into *some* root.

   | # | check | where | what it stops |
   |---|---|---|---|
   | 1 | `block.timestamp > deadline` ⇒ `SignatureExpired` | `contracts/src/CrossPermit.sol:158-160` | a signature outliving its window |
   | 2 | `permits.chainId != uint64(block.chainid)` ⇒ `WrongChainId` | `contracts/src/CrossPermit.sol:161-163` | **cross-chain replay.** `chainId` is a field of the bundle and therefore of the leaf, so chain B's bundle is signed but simply will not execute on chain A. This is the only thing that stops it. |
   | 3 | `_useNonce(owner, salt)` ⇒ `NonceAlreadyUsed` | `contracts/src/CrossPermit.sol:186` → `contracts/src/SaltRegistry.sol:196-204` | replay on *this* chain. The burn is per-chain storage, which is why one signature works three times — once per chain — and not six. |
   | 4 | signature recovers to `owner` over the rebuilt root | `contracts/src/CrossPermit.sol:174-177`, `:187` | a tampered bundle or a proof from another tree. A wrong proof does not revert at the fold; it yields a different root, and the recovery fails there. |

   Only then are the allowances written (`_processChainPermits`, `:188`).
5. **The router spends the allowance.** It is Uniswap's own router with exactly one thing changed:
   `permit2` points at CrossPermit. CrossPermit's `transferFrom` overloads are selector-identical to
   Permit2's, so the router's payment path is unmodified.

## Architecture

```
  client machine — no chain involved yet
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  one permit bundle per chain.  chainId is a FIELD of the bundle:              │
  │                                                                              │
  │    bundle[11155111]        bundle[84532]           bundle[11155420]          │
  │         │                       │                        │                   │
  │    hashChainPermits        hashChainPermits         hashChainPermits          │
  │         │  leaf                 │  leaf                  │  leaf             │
  │         └──────────┬────────────┴───────────┬────────────┘                   │
  │                    └─ left-leaning merkle ──┴────▶  root                     │
  │                                                      │                       │
  │   ONE EIP-712 signature, 65 bytes, over that root ◀──┘                       │
  │     domain.chainId        = 1            (a constant, never the live chain)  │
  │     domain.verifyingContract = 0x659C…de1B  (same CREATE2 address everywhere)│
  └──────────────────────────────────────┬───────────────────────────────────────┘
                                         │
        ┌────────────────────────────────┴──────────────────────────────┐
        │  apps/relayer — OPTIONAL. one POST, N chains, simulate first.  │
        │  it can censor and reorder; it cannot change a recipient,      │
        │  a spender or an amount. the client can submit any chain       │
        │  itself with the same signature.                               │
        └───┬───────────────────────┬───────────────────────┬────────────┘
            │ bundle+proof+sig      │                       │
  ══════════▼═══════════  ══════════▼═══════════  ══════════▼═══════════
   Ethereum Sepolia        Base Sepolia            Optimism Sepolia
   11155111                84532                   11155420
   CrossPermit 0x659C…     CrossPermit 0x659C…     CrossPermit 0x659C…
   ─────────────────────   ─────────────────────   ─────────────────────
    1  deadline not passed
    2  bundle.chainId == block.chainid      ← the cross-chain replay stop
    3  salt burned in THIS chain's registry ← why one sig works 3×, not 6×
    4  proof folded to a root, signature recovered to owner over it
    ⇒  allowances written to this chain's ledger
  ══════════╤═══════════  ══════════╤═══════════  ══════════╤═══════════
            │                       │                       │
            ▼                       ▼                       ▼
   Uniswap Universal Router — UNMODIFIED, deployed with permit2 := CrossPermit
   V4_SWAP → V4SwapRouter → SETTLE_ALL → _payStandard → payOrPermit2Transfer
           → PERMIT2.transferFrom(owner → PoolManager)   ← selector-identical
```

Why one address everywhere is non-negotiable: the domain pins `chainId = 1` so the signature is
chain-agnostic, but the domain still includes `verifyingContract`. Same address or the signature does
not port — which is why every dependency in this repo is pinned to a commit.

## Deployed addresses

**CrossPermit — `0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B` on all three chains.**
Salt `0xb2af67d67b308054b26d8fb210cab127bf699e936190ed01dd9052e7736d1c8c` (`keccak256("CrossPermit v1")`),
via ERC-2470, solc 0.8.27 / optimizer 1e6 runs. Full records in [`deployments/`](deployments/) —
that directory, not this table, is the source of truth.

| Chain | chainId | CrossPermit | Router (`permit2 := CrossPermit`) | LiquidityDesk |
|---|---|---|---|---|
| Ethereum Sepolia | 11155111 | [`0x659C…de1B`](https://sepolia.etherscan.io/address/0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B) | [`0x7B68d6740C5C66967271966E62fd1A3E01743E3c`](https://sepolia.etherscan.io/address/0x7B68d6740C5C66967271966E62fd1A3E01743E3c) | [`0x2EDaA9629436C9D0b93301422a27b640068D7Cde`](https://sepolia.etherscan.io/address/0x2EDaA9629436C9D0b93301422a27b640068D7Cde) |
| Base Sepolia | 84532 | [`0x659C…de1B`](https://sepolia.basescan.org/address/0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B) | [`0x73ed10744987B65fAf6BD6FFdF1039Cb7eF97002`](https://sepolia.basescan.org/address/0x73ed10744987B65fAf6BD6FFdF1039Cb7eF97002) | [`0xE666e3F76062d670A84b964Ca4D9B456b1531C03`](https://sepolia.basescan.org/address/0xE666e3F76062d670A84b964Ca4D9B456b1531C03) |
| Optimism Sepolia | 11155420 | [`0x659C…de1B`](https://sepolia-optimism.etherscan.io/address/0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B) | [`0x2E03912851a0e442C77Ce00506aA7664E45560Ac`](https://sepolia-optimism.etherscan.io/address/0x2E03912851a0e442C77Ce00506aA7664E45560Ac) | [`0x012a12367CeEB9e4ead98803D8019913cA80c3C2`](https://sepolia-optimism.etherscan.io/address/0x012a12367CeEB9e4ead98803D8019913cA80c3C2) |

v4 `PoolManager` per chain, and the seeded pools, are in `deployments/v4pool-*.json`.

Optimism Sepolia was added after the fact, which is the strongest evidence the scheme works: the
same init code and the same salt put CrossPermit at the **same address** on a chain it had never
touched, and its `DOMAIN_SEPARATOR` came back byte-identical to the other two without any
coordination. Unichain Sepolia was dropped because MultiBaas does not support it, so a chain there
could never carry a control-plane audit trail.

Read live off all three deployments — the invariant the whole scheme rests on:

```
DOMAIN_SEPARATOR()             0x4ce820a58ffb00fe1b6cb52f083bdd1cfd176732c34db34a84517668750aa5e4
SIGNED_CROSSPERMIT_TYPEHASH()  0x2b8986532571ca462e751db5072ea926966480857f91eebafcc04d28b5a33c3d
CANCEL_CROSSPERMIT_TYPEHASH()  0x184e9b675fc89b0718770fb9e1bf1ebdfe0780b451ab8ed5b69ffdb0c83655ea
```

Identical on Ethereum, Base and Optimism Sepolia, because the domain pins `chainId = 1` and the
CREATE2 address is the same everywhere.

`PERMIT2` is an internal immutable with no getter, so the substitution is not readable off the
deployed router. Two artifacts show it instead: the deploy log
(`deployments/router-Sepolia.log:10`, `permit2: 0x659C…de1B`, one per chain), and — the one that
matters — `FORK=1 forge test --match-contract RouterFork`, where a live `V4_SWAP` settles out of a
CrossPermit allowance and out of nothing else. There is no runtime-bytecode check in this repo; an
earlier version of this file claimed one.


## Run it

Nothing below the `.env` line needs a secret, a key or a network. **The entire offline suite runs on
a fresh clone with no environment at all.**

```bash
git clone --recursive https://github.com/sairammr/crosspermit
# already cloned without --recursive?  run this, or forge build dies on 17 unresolved imports:
#   git submodule update --init --recursive
cd crosspermit
bun install
script/test.sh
```

`script/test.sh` is the only gate: typecheck of `packages/sdk`, `packages/multibaas`, `apps/web` and
`apps/relayer`; their unit suites (96 tests as of writing — 24 SDK, 40 web, 32 relayer); `forge
build`; regeneration of the parity fixtures from this working tree; `forge test` (27 passing, plus
the three fork suites which skip without `FORK=1`); and a grep proving no upstream branding reached
the product surface. It ends in `ALL OFFLINE CHECKS PASSED` or exits non-zero at the first step that
failed. Root `bun run test` and the CI `offline` job both call it and nothing else, so there is one
command to believe. That is the complete offline proof, and it needs no environment.

### Prerequisites

| | version | where |
|---|---|---|
| **Bun** | 1.3.11 or newer (`engines.bun` in `package.json`) | <https://bun.sh> |
| **Node** | v22.14.0 or newer — only for the toolchain; nothing runs on it | <https://nodejs.org> |
| **Foundry** | `forge` 1.8.1 (`forge`, `cast`) | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |

### Then, for anything that touches a chain

Deploying the whole thing — contracts, relayer, desk layer, dashboard — is in **[DEPLOY.md](DEPLOY.md)**:
every environment variable, who reads it, what must not face the internet, and the order to verify
in. `.env.example` marks each variable REQUIRED or OPTIONAL with its compiled-in default.

```bash
cp .env.example .env          # PRIVATE_KEY and the three RPCs are the minimum
set -a && . ./.env && set +a

# the live-chain proofs: v4 swaps on three testnets, Aave v4 and NVDAon on a mainnet fork. No broadcast.
cd contracts && FORK=1 forge test --match-path 'test/*Fork*' -vv && cd ..

# deploy (only needed once; the addresses above are already live)
script/deploy.sh all
bun run packages/sdk/scripts/deploy-liquidity.ts        # the v4 LP adapter, one per chain
bun run packages/multibaas/scripts/register-crosspermit.ts   # index CrossPermit events per chain

# the liquidity writ end to end: client signs, a DIFFERENT key provides the liquidity, client exits
bun run packages/sdk/scripts/liquidity-demo.ts --chain BaseSepolia --size 1

# the full lifecycle, eight stages, against the live testnets
bun run packages/sdk/scripts/lifecycle.ts

# one click: start the relayer, then drive the same flow through one POST
bun run apps/relayer/src/server.ts &
bun run packages/sdk/scripts/lifecycle.ts --only authorize --via-relayer http://localhost:8787

# the site: landing page, the desk at /app, a client's mandate at /c/<token>
cp apps/web/.env.example apps/web/.env.local   # a Reown project id, a libSQL url, the relayer key
cd apps/web && bun run build && bunx next start -p 3000

# the whole product end to end, through the web origin: link, signature, allowance, LP, withdrawal
bun apps/web/scripts/lifecycle.ts --size 1.0
```

The dashboard also takes `?owner=0x...` for a read-only view of someone else's outstanding
authority — a risk officer reviewing an account should not need its keys, and the treasury and audit
screens are reads with nothing to sign.

## LiquidityDesk — the same writ, providing liquidity

A swap proves the writ can *trade*. This proves it can *invest*: the desk calls
`add(client, poolKey, ticks, liquidity, max0, max1)`, and inside the v4 unlock both sides are paid
by `CrossPermit.transferFrom(client -> PoolManager)` — the same call the Universal Router makes
when it settles a swap. The position is keyed by `salt = the client's address`, so v4 core holds it
in their name and the adapter needs no share accounting of its own.

**`add` is not open, and an earlier version of this file was wrong to say it was.** The caller
supplies `key` as well as `owner`, so a permissionless `add` let anyone name a pool of their own
construction and settle the victim's entire CrossPermit allowance into it. That is a drain wearing a
mandate's clothes, not an asymmetry. The rule in the code
(`contracts/src/LiquidityDesk.sol:112`) is now:

- `add(owner, …)` is callable by `owner`, or by an address `owner` registered on-chain through
  `setOperator(address operator, bool allowed)`. Anyone else gets
  `NotAuthorised(address owner, address caller)`. Registration emits
  `OperatorSet(address indexed owner, address indexed operator, bool allowed)` and is revocable at
  any time.
- `remove` and `collect` take the owner from `msg.sender` and always did, so the desk still has no
  position to withdraw and nothing to sweep.

The product story is unchanged and arguably stronger, but it now takes **two** acts from the client
rather than one: the CrossPermit signature says how much may move, and `setOperator` says who may
choose where it goes. An allowance bounds the amount; it never named a pool.

`contracts/test/LiquidityDeskAuth.t.sol` is the regression test and runs offline, not behind
`FORK=1`: a stranger's `add` reverts and moves neither tokens nor allowance, a registered operator
works, a revoked one does not.

> **The three deployed LiquidityDesk instances listed above predate this fix** and carry the ungated
> bytecode. Redeploy before pointing anyone at them.
>
> **The deployed CrossPermit predates two fixes of its own.** `AllowanceLedger.sol` (the new `Spend`
> event) and `MultiTokenTransfer.sol` (the per-tokenId `AllowanceLocked` fallthrough) both compile
> into `CrossPermit`, so `0x659C6F02…de1B` on all three chains is the code as it was *before* them:
> a narrowing lockdown on an ERC-721/1155 key still falls through to the collection allowance there.
> Because the init code changed, redeploying with the pinned salt lands at a **different** address,
> which also moves the `DOMAIN_SEPARATOR` quoted below — the salt is pinned, the bytecode is what it
> is. Redeploying CrossPermit is therefore a deliberate act that invalidates every address and
> domain constant in this file, not a routine bump.
>
> Two callers in this tree have not caught up either: `packages/sdk/scripts/liquidity-demo.ts` and
> the dashboard's **Add to the pool** button both call `add(client, …)` from the desk's key without
> registering it first, so against a redeployed desk they will revert with `NotAuthorised` until a
> `setOperator` step is added.

Proved live, both directions, with two different keys — on the ungated bytecode, before the fix:

```
client 0x9673afB9…4Eb4   desk 0xaa46C4a5…3B7C
writ armed            https://sepolia.basescan.org/tx/0x966b7096b355cf8b417bd6f68a6f09006492dbf35a140c4d9111d9a67cabe947
desk added L=33837499 https://sepolia.basescan.org/tx/0xbd71a1d452b671349d8a578f1940f9a875792ed6f815b56b1ff3b970518a9999
  client paid 0.999866 + 1.000135, client -> PoolManager, adapter balance 0
desk cannot remove    simulation reverts: no position under the desk's salt
client withdrew       https://sepolia.basescan.org/tx/0x4f21f28314c24abb2840454c81c557c0694776c08ed46d49721be6952fa74c8c
```

The same run on Ethereum Sepolia: [writ](https://sepolia.etherscan.io/tx/0xad002ad88409e1be4cf1ae05b8280f756e2c4fcd7d48423c386035821bc2400a),
[add](https://sepolia.etherscan.io/tx/0xfacdabb72adaa5132f181f8c7140cfc09f4ff4b78208c504a6b4c11766ad84ee).
`FORK=1 forge test --match-contract LiquidityFork` runs the whole sequence against the live
PoolManager on all three chains, including the two things the desk must not be able to do and the
`setOperator` step the gate now requires.

## The v4 swap, and why it is the check that matters

`PERMIT2_TRANSFER_FROM` proves the router's `PERMIT2` immutable is CrossPermit, but it is not a path
a dApp uses. `V4_SWAP` is: the router hands the swap to `V4SwapRouter`, whose `SETTLE_ALL` pays the
`PoolManager` through `_payStandard -> payOrPermit2Transfer -> PERMIT2.transferFrom`. A swap that
settles therefore proves the substitution **on the real payment path**, against Uniswap's own live
`PoolManager`.

Every live run returns 996 999 of the output token for 1 000 000 in — the pool's 0.3% fee. The
allowance ends at zero, and the router holds no plain ERC20 approval, so the input can only have come
through CrossPermit.

## Aave v4 and tokenized equities, on a mainnet fork

`contracts/test/TreasuryFork.t.sol` supplies 10 000 USDC through a CrossPermit allowance into Aave
v4's real Core Hub and MAIN Spoke, `vm.warp`s thirty days forward and withdraws. Ondo's real
`NVDAon` is read live in the same suite. Nothing is broadcast, and nothing is deployed on mainnet.

**The figures move every run.** The fork is taken at HEAD with no pinned block
(`TreasuryFork.t.sol:42`), so the rate and therefore the yield depend on whenever you run it; the
test asserts only that something came back (`out > 0`), that APY ≥ APR, and that the APR is under
100%. Earlier versions of this file quoted 10 032.65 USDC out at 3.976% APR / 4.056% APY as if those
were fixed measurements. They were one run's console output. What is proved is the *shape*: the
supply lands, time passes, more comes back than went in, and both rates are labelled distinctly.

## The desk

```
add a client  ->  send one link  ->  they sign once  ->  you allocate
```

A **mandate** is an invitation, not authority. `POST /v1/clients` stores what the desk intends to
ask for and returns a link; nothing can move until the client opens `/c/<token>` and signs. That is
why reading a mandate by its token needs no key while creating, listing and binding sit behind the
desk's own key: the link carries an offer, and whoever holds it can only sign *their own* permission
with it.

The mandate page renders every per-chain bundle in plain language, from values computed on the
page, before the wallet is ever opened. One signature grants **two** spenders — the Universal Router
and that chain's LiquidityDesk — so the page reads the outstanding allowance against both and
labels them separately ("1,000 to the router · 500 to the LP desk open"). An entry carrying an
expiry is an *increase*, so the cap alone would understate what is being granted.

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

It checks that the cap survives the round trip exactly, that each chain agrees with the leaf
computed on the client, that one 65-byte signature covers every chain and both spenders, that a
second claim on the same link is refused, that an unknown intent cannot bind a mandate, and that the
allowance on each chain rises by exactly the cap that was offered.

### One client, one screen

Clicking a client in the desk's ledger opens `/app/client/<token>`: the mandate, the assets it
approved, who can spend them, what can be done with them, and the venue where one of those things
is a live button.

| Panel | Source | What it answers |
|---|---|---|
| Rail | all four, side by side | held, deployable, chains, terms asked versus granted |
| How it grew | MultiBaas `Permit` events, PoolManager storage | authority outstanding over time, per chain, pool depth and price drift, consumption |
| Access | MultiBaas ledger + `eth_call` | every spender by name, and an **unrecognised spender** row when it is neither the router nor the liquidity desk |
| Platform | `GET /v1/chains` | relayer signer and custody per chain, which chains MultiBaas indexes, both contract addresses |
| Uniswap v4 pools | `extsload` on the PoolManager | price, in-range depth, this client's own position — then sign the writ, add, collect, take it back |
| Strategies | a pure recommender, `src/strategies.ts` | ranked by fit, routable first, every figure carrying its provenance and every block carrying its reason |
| History | MultiBaas event ledger | every grant, lock and burned salt, ordered by the timestamp the client signed |

The four sources are never merged. Chain storage says what an allowance *is*; the MultiBaas ledger
says how it got there and is the only record of a grant that has since lapsed; the pool says what
the venue is doing; the desk's own table says what was *asked for* and is never evidence of what
was granted. Where they disagree the screen shows both, and where a chain has no MultiBaas
deployment it says so rather than rendering an empty history as though nothing had happened. A read
that fails says "could not read" rather than rendering 0.00.

Pool prices in the UI are decimal-corrected: `slot0.price` is the raw ratio between smallest units,
and `priceOf(pool, price)` in `apps/web/src/pools.ts` is the human figure. The two differ by 1e12 on
a 6dp/18dp pair.

## The lifecycle

`packages/sdk/scripts/lifecycle.ts` runs eight stages against the live testnets, every one a real
state transition, and every grant or revocation carried by **one** signature across all three chains
and every spender the mandate named:

| stage | what it proves |
|---|---|
| `setup` | chain ids, deployed code, a funded test token, a real Uniswap v4 pool per chain |
| `authorize` | one signature ⇒ allowances on three chains, plus an immediate signed transfer on one |
| `spend` | the router pulls and then swaps, both settled out of that one allowance |
| `decrease` | one signature retires every spender's leftover allowance everywhere |
| `lock` | one signature disables every spender on every chain — proved by a pull that now reverts |
| `unlock` | one signature restores it, and the router spends again |
| `cancel` | a signed permit is retracted on every chain **before** submission, and can never be redeemed |
| `report` | per-chain table with explorer links |

**Revocation is a signature, run from the CLI — not a button.** A `LOCK` is per
`(owner, token, spender)`, and the web mandate grants two spenders, so a revocation naming only the
router leaves a live allowance behind. `revokeEntries()` in `packages/sdk/src/crosspermit.ts:80`
builds the bundle covering every spender and feeds `prepareIntent` directly, so one signature
retires the lot; `lifecycle.ts`'s `lock` stage is what exercises it end to end. The dashboard can
withdraw a client's *invitation*, which does not touch a live allowance, and has no revoke button.

## Trust model

Who can hurt you, and how much:

| Who | What they can do | What they cannot do |
|---|---|---|
| **The relayer** | censor, reorder, refuse to submit, spend its own gas | change a recipient, a spender, an amount or a chain — all of that is inside the signed bundle. Every flow stays completable by the client alone, with the same signature. |
| **A hostile RPC** | lie about state, drop reads | choose what the user signs. The leaf is computed client-side, always; the `eth_call` to `hashChainPermits` is an equality assertion and nothing else. |
| **The desk / fund manager** | choose *which pool* a registered `setOperator` grant goes into, up to the signed cap | take custody, withdraw a position, or `add` at all without being registered by the client first |
| **Whoever holds a mandate link** | read the terms being offered — confidential, but not authority | grant anything. Signing it grants *their own* permission, and only that. |
| **The desk API key holder** | create, list, bind and withdraw mandates | move a token. None of those grant anything. |
| **A compromised relayer key** | grief by censorship and by burning its own gas budget | spend a user's allowance — the spender must be the caller |

Operationally: simulate before broadcast, everywhere, without exception. Admission control is on by
default in production — with no `RELAYER_API_KEYS` set the relayer runs open and says so loudly at
boot, and per-owner rate and gas budgets apply either way. Pinned dependencies are load-bearing:
bumping a submodule changes the init code and therefore the address, so treat it as a migration.
Compliance gates default to deny, and an unset gate denies everything. APR and APY are labelled
distinctly in every ABI, API response and pixel. The signed ordering timestamp is deliberately set
behind wall clock (`TIMESTAMP_LAG`), because CrossPermit rejects a permit that orders itself into
the future and a chain's head block is routinely a few seconds old — signing with `Date.now()` fails
intermittently on slow chains and never on fast ones, which is the worst shape a bug can have.

Full write-ups, all three worth reading before trusting this with anything:

- **[`docs/threat-model.md`](docs/threat-model.md)** — thirteen named attacks with an answer and a
  residual for each, plus an "open, and honest about it" table.
- **[`docs/runbook.md`](docs/runbook.md)** — key rotation, the kill switch, incident response, and
  what to say publicly during an outage.
- **[`docs/multibaas.md`](docs/multibaas.md)** — every MultiBaas feature with a verdict (in use /
  adopt / skip) and the reason, including the ones deliberately not used.

Known limitations and what is deliberately not yet proved are in [`PLAN.md`](PLAN.md).

## Layout

```
contracts/src/            CrossPermit core: the allowance ledger, salt registry, multi-token transfers
contracts/src/treasury/   YieldRouter (Aave v4) and EquityDesk (tokenized equities) — fork-tested, deployed nowhere
contracts/test/           forge suite: cross-chain flow, encoding parity, live-chain fork proofs
packages/sdk/             the client: bundles, leaves, merkle tree, the one signature, revocation, cancellation
packages/multibaas/       MultiBaas control plane: custody, indexing, allowance ledger, audit trail
apps/relayer/             one POST, N chains; admission control, simulation, SSE, client mandates
apps/web/src/desk/        the multi-manager layer, served at /api/desk: wallet sign-in, scoped books, desk registry, pools
apps/web/                 the landing page, the desk, and the client's mandate page
deployments/              every deployed address, with salt, factory, compiler settings and chain ids
script/deploy.sh          deterministic CrossPermit deploy, then the router
script/test.sh            the single offline gate; root `bun run test` and CI both call it
DEPLOY.md                 every environment variable, who reads it, and the order to verify in
PLAN.md                   the build plan, what shipped, what is partial, what is still planned
docs/threat-model.md      named attacks, answers, residuals
docs/runbook.md           key rotation, the kill switch, incident response
docs/multibaas.md         MultiBaas feature by feature, with a verdict and a reason
FEEDBACK.md               sponsor feedback: Uniswap and MultiBaas friction, as encountered
```

## Licence

MIT. The cross-chain allowance core is a derivative work of MIT-licensed software — see
[Provenance](#provenance) above and [`NOTICE`](NOTICE).
