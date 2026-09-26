# CrossPermit — full build plan

**One signature. Every chain. Institutional custody, yield and RWA execution on top.**

CrossPermit is three layers that stack:

| Layer | What it is | Who it serves |
|---|---|---|
| **L1 — Permission** | `CrossPermit`, a cross-chain allowance contract at one deterministic address on every chain. A single EIP-712 signature over a merkle root of per-chain permit bundles authorises allowances and transfers on all of them. | anyone |
| **L2 — Execution** | `crosspermit-relayer`. Takes one signed root plus the bundles, validates them off-chain, and fans the submissions out to every chain in parallel. One click, N chains, no per-chain wallet prompts. | anyone |
| **L3 — Treasury** | The institutional desk: MultiBaas for custody/policy/audit, Aave v4 spokes for yield, a tokenized-equity desk (NVDA and peers) for exposure. | funds, treasuries, desks |

L1 is the moat: today an institution moving collateral across four chains signs four
times, from four wallet sessions, each one a separate approval risk and a separate
audit-log entry. CrossPermit collapses that to one signature and one audit record,
and — because it is selector-identical to Permit2's transfer surface — it spends
through Uniswap's own unmodified Universal Router.

---

## Status

Spot-checked against the tree rather than against the plan, because a plan that marks
itself done is not evidence.

| Phase | Deliverable | State | What is missing |
|---|---|---|---|
| P0 | Monorepo, pinned toolchain, license posture | **shipped** | |
| P1 | L1 contracts rebranded, restructured, compiling | **shipped** | |
| P2 | TS SDK — bundles, leaves, merkle, one signature | **shipped** | |
| P3 | Test suite ported and green | **shipped** | |
| P4 | Deterministic deploy, address reproduced, 3 testnets live | **shipped** | contracts unverified on the explorers |
| P5 | Relayer — one click, N chains | **partial** | `GET /v1/quote` does not exist. Execution is one serialised promise per chain (`apps/relayer/src/relayer.ts:122-129`) — no fee escalation, no nonce lease, no backoff, no circuit breaker. Idempotency is `keccak256(owner‖salt‖root)`, not `(owner, salt, chainId)`. No anvil chaos test; the kill-mid-fan-out behaviour is covered by unit tests over a fake chain, and stranded legs are reported at boot, never auto-retried. |
| P6 | MultiBaas treasury adapter | **partial** | Cloud Wallet signing is compile-checked only. `bun run smoke:multibaas` is defined by no package — the script is `bun run packages/multibaas/scripts/smoke.ts`. Two of three chains covered. |
| P7 | Aave v4 yield + tokenized-equity desk | **partial** | `YieldRouter` and `EquityDesk` are fork-tested and deployed on no chain. `PositionRegistry` was never written — zero hits repo-wide. The equity venue adapter is a mock. |
| P8 | Institutional dashboard (WalletConnect) | **shipped** | the kill switch is a CLI signature (`lifecycle.ts`), not a dashboard button |
| P9 | Hardening — fuzz, invariants, threat model, ops runbook | **partial** | see the corrected description under P9; the relayer property and chaos tests were not written |

### Live addresses

`deployments/*.json` is the source of truth and the only place addresses are written down.
This file used to carry a router table and all three entries were wrong, which is exactly
the failure mode a second copy has. The README's **Deployed addresses** table is built from
the same files.

**CrossPermit** is `0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B` on all three chains
(`deployments/crosspermit.json`); routers are in `deployments/router-*.json`, the v4 LP
adapters in `deployments/liquidity-*.json`, the mock tokens and seeded pools in
`deployments/token*-*.json` and `v4pool-*.json`. The deployed LiquidityDesks predate the
`add` authorisation gate and must be redeployed before anyone is pointed at them.

Salt `0xb2af67d67b308054b26d8fb210cab127bf699e936190ed01dd9052e7736d1c8c`
(`keccak256("CrossPermit v1")`), via ERC-2470, solc 0.8.27 / optimizer 1e6 runs.

Read live off all three deployments, which is the invariant the whole scheme rests on:

```
DOMAIN_SEPARATOR()             0x4ce820a58ffb00fe1b6cb52f083bdd1cfd176732c34db34a84517668750aa5e4
SIGNED_CROSSPERMIT_TYPEHASH()  0x2b8986532571ca462e751db5072ea926966480857f91eebafcc04d28b5a33c3d
CANCEL_CROSSPERMIT_TYPEHASH()  0x184e9b675fc89b0718770fb9e1bf1ebdfe0780b451ab8ed5b69ffdb0c83655ea
```

Identical on Ethereum, Base and Optimism Sepolia.

Optimism Sepolia was added late, which turned out to be the strongest evidence
the scheme works: the same init code and salt put CrossPermit at the same address
on a chain it had never touched, and its domain separator matched without any
coordination. Unichain Sepolia was dropped — MultiBaas does not support it, so a
chain there could never carry a control-plane audit trail.

---

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

Why one address everywhere is non-negotiable: the EIP-712 domain pins
`chainId = 1` so the signature is chain-agnostic, but the domain still includes
`verifyingContract`. Same address or the signature does not port. Deployment
therefore goes through the ERC-2470 singleton factory with identical init code
and an identical salt — which is why every dependency in this repo is pinned to
a commit.

---

## P1 — L1 contracts (done)

Vendored in, renamed, restructured, no upstream branding anywhere in the product
surface. Rename map:

| was | is | note |
|---|---|---|
| `Permit3` | `CrossPermit` | also the EIP-712 domain name |
| `IPermit3` | `ICrossPermit` | |
| `PermitBase` | `AllowanceLedger` | the allowance/lock storage |
| `IPermit` | `IAllowanceLedger` | |
| `NonceManager` | `SaltRegistry` | salts are non-sequential nonces |
| `INonceManager` | `ISaltRegistry` | |
| `MultiTokenPermit` | `MultiTokenTransfer` | ERC20/721/1155 transfer surface |
| `IMultiTokenPermit` | `IMultiTokenTransfer` | |
| `TypedEncoder` | `WitnessEncoder` | moved `libs/` → `lib/`; **since deleted** — nothing imported it |
| `ERC7702TokenApprover` | `ERC7702Approver` | |
| `Permit3ApproverModule` | `ERC7579ApproverModule` | **since deleted** — nothing imported it, and this tree advertises no ERC-7579 module support |
| `SIGNED_PERMIT3_TYPEHASH` | `SIGNED_CROSSPERMIT_TYPEHASH` | new type string ⇒ new typehash |
| `CANCEL_PERMIT3_TYPEHASH` | `CANCEL_CROSSPERMIT_TYPEHASH` | |
| `PERMIT_WITNESS_TYPEHASH_STUB` | `CROSSPERMIT_WITNESS_TYPEHASH_STUB` | |
| `ZeroPermit3()` | `ZeroCrossPermit()` | new error selector |

Renaming the EIP-712 type strings and the domain name changes the domain
separator, every typehash, and therefore the deterministic address. That is the
intent: CrossPermit is a distinct signing domain, and a signature for one is
meaningless to the other.

**Deliberately unchanged**, because they are interoperability surface rather than
identity:

- the `transferFrom` overloads — byte-identical selectors to Permit2, which is
  the only reason Uniswap's unmodified Universal Router can spend a CrossPermit
  allowance;
- `allowance`, `DOMAIN_SEPARATOR`, `hashChainPermits`, the `permit` entrypoints —
  standard verbs a wallet or indexer expects to find.

**Verification:** `forge build` clean; `grep -ri permit3 contracts/src` empty.

---

## P2 — SDK (done)

`packages/sdk` — the client half, and the only place a permission is ever built.

- `crosspermit.ts` — bundle entries (`approveEntry` / `transferEntry` / `lockEntry`,
  `tokenKey`, the `modeOrExpiration` encoding), `leafOf`, the left-leaning merkle
  tree, `signRoot`, and per-chain submission.
  `leafOf` computes `hashChainPermits` **locally** and must never come from an
  `eth_call`: the leaf is the only thing between the signer and a root they did
  not build — a hostile RPC answering with the hash of its own bundle would have
  the wallet display nothing but an opaque `merkleRoot`. `leafOfChecked` computes
  locally and then asserts the chain agrees.
  The merkle tree uses OpenZeppelin sorted-pair hashing, which is what
  `MerkleProof.processProof` reconstructs with. The last leaf sits one hop from
  the root, so order the chains cheapest-first, dearest-last.
  `signRoot` pins the domain `chainId` to 1. Not a bug; do not substitute the
  live chain id.
- `intent.ts` — the one-click envelope the relayer consumes, plus every offline
  authorisation check and the all-strings wire format (`bigint` does not survive
  JSON, and coercing to `number` would round a `uint160`).
- `cancel.ts` — cross-chain retraction. Reproduces `hashNoncesToInvalidate`
  including its non-EIP-712 quirk: the contract `abi.encode`s the salts array
  rather than hashing it, and matching the contract matters more than matching
  the spec.
- `router.ts` — Universal Router v4 swap and `PERMIT2_TRANSFER_FROM` encoding.

Kept as four files rather than the six the first draft proposed: splitting ~250
lines of cohesive client code across six modules is structure for its own sake.

**Verification:** `bun test` in the package, plus P3's parity tests pinning the
SDK against the compiled contract.

## P3 — Tests (done)

Ported from the reference harness, renamed, plus new coverage.

- `CrossChainFlow.t.sol` — every chain replayed from one post-`setUp` snapshot
  with a different `block.chainid`, so the chains share nothing but the
  signature. Asserts: one signature ⇒ allowances everywhere; anyone may submit
  but only the owner can spend; wrong-chain replay, wrong-proof replay, double
  submit, tampered bundle, expired signature, expired allowance all revert; a
  later bundle can `LOCK` a spender across chains; the domain separator is
  identical on every chain.
- `LeafParity.t.sol` — the SDK's local leaf vs `CrossPermit.hashChainPermits`
  over six bundle shapes (empty, single, approve+transfer, lock, `uint160`/
  `uint48` maxima, hashed non-address token key). This is the test that earns the
  right to compute the leaf client-side.
- `MerkleParity.t.sol` — SDK trees and proofs for 1..8 leaves re-verified with
  OpenZeppelin's `MerkleProof`. Matters because the contract never compares
  roots: it feeds `processProof`'s output straight into the signed struct hash,
  so a client tree that disagrees fails silently rather than loudly.
- `SwapEncoding.t.sol` — decode the SDK's real calldata with the Solidity structs
  the deployed router really uses; assert byte equality against solc's own
  `abi.encode`.
- `RouterFork.t.sol` — opt-in (`FORK=1`) live-chain proof: seed a v4 pool, then
  against the deployed CrossPermit and router, show the swap reverts before the
  permit, settles after it, that the router holds no plain ERC20 approval, and
  that the allowance ends at zero.

**Verification:** `forge test` green offline; `FORK=1 forge test` green against
the three live testnets.

## P4 — Deterministic deployment (done)

- `script/DeployCrossPermit.s.sol` — ERC-2470 (`0xce0042B8…`) singleton factory,
  salt from env. Deploys `CrossPermit`, then `ERC7702Approver` at
  `keccak256(abi.encode(salt, "ERC7702"))`.
- `script/deploy.sh` — preflight (chain id matches, factory present, deployer
  funded), predict the address from init code + salt, skip chains that already
  have code, and **never** read an empty `cast code` as success: a rate-limited
  RPC prints nothing and that is how a skipped deploy reports done.
- Router half: clone Uniswap's Universal Router at a pinned commit, patch exactly
  one `permit2` literal per chain's deploy parameters (count literals, not lines),
  deploy, then restore the clone. `PERMIT2` is an internal immutable with no
  getter, so it cannot be read off the deployed router. Two artifacts stand in:
  the deploy log (`deployments/router-<chain>.log`, line 10, `permit2: 0x659C…`)
  and — the one that actually proves it — `FORK=1 forge test --match-contract
  RouterFork`, a live `V4_SWAP` that settles out of a CrossPermit allowance and
  out of nothing else. There is no runtime-bytecode grep in this repo; earlier
  versions of this file and the README both claimed one.
- `deployments/*.json` records address, salt, factory, compiler settings and
  chain ids so a clean clone can re-derive the address from the repo alone.

**Verification:** re-derive the address offline with `cast keccak`; read
`DOMAIN_SEPARATOR()` and `SIGNED_CROSSPERMIT_TYPEHASH()` off all three live
deployments and assert they are byte-identical.

## P5 — Relayer: one click, N chains (done)

`apps/relayer`. The user signs once; the relayer does the rest.

```
POST /v1/intents          → { intentId }        submit a signed intent
GET  /v1/intents/:id      → status snapshot
GET  /v1/intents/:id/sse  → live per-chain event stream
GET  /v1/intents          → recent intents (desk key)
GET  /v1/chains           → what this relayer serves, and with whose key
GET  /v1/quota/:addr      → an owner's remaining rate and gas budget (desk key)
GET  /healthz /readyz     → ops
```

**Validation before a single wei of gas.** Every check runs off-chain first,
because a relayer that forwards garbage burns its own gas and can be griefed
into insolvency:

1. `deadline` is in the future, with margin.
2. Each bundle's `chainId` equals the chain it is addressed to.
3. Each leaf recomputed locally from the bundle — never trusted from the payload.
4. `processProof(leaf, proof) == root` for every chain.
5. `signature` recovers to `owner` over the CrossPermit domain — EOA via ECDSA,
   contract accounts via ERC-1271.
6. Idempotency on `keccak256(owner‖salt‖root)` — the signed fields only, so two
   byte-different but equally valid ECDSA signatures collide into one intent rather
   than two (`packages/sdk/src/intent.ts:74-82`). A replay is answered from state.
7. Per-chain simulation (`eth_call`) before broadcast. A bundle that would revert
   is rejected, not submitted.

**Why the relayer cannot steal.** It only submits what the owner already signed.
Transfer entries name their recipient inside the signed bundle, and allowance
entries name their spender; the relayer chooses neither. Spending still requires
the spender to be the caller, so a relayer holding a submitted permit can pull
nothing. The relayer's only privilege is paying gas, and its only powers of abuse
are censorship (not submitting) and ordering — both mitigated by the client being
able to submit any chain itself, unchanged. That fallback is a product
requirement, not a nicety: it is what keeps the relayer non-custodial.

**Execution, as built.** One serialised promise chain per chain, so legs proceed in
parallel across chains and in order within one (`apps/relayer/src/relayer.ts:122-129`).
Receipts are waited to **2 confirmations**, so a block reorged out cannot leave a permanent
`confirmed` row. There is deliberately no fee escalation, no nonce lease, no backoff and no
circuit breaker: those were planned and are not here. Signing through the MultiBaas Cloud
Wallet + Transaction Manager where configured (P6), local `privateKey` signer otherwise.
State in SQLite, one row per (intent, chain), with `broadcastAt` recorded on the first move
to `submitted`.

**A restart never retries.** A leg stuck in `submitting` may have a transaction in the
mempool whose hash was never seen; a leg in `submitted` has one whose receipt was never read
back. Either could become two allowances on chain, so `store.stranded()` reports both at boot
with their hash and stops there. No sweeper.

**Verification, as built.** `apps/relayer/test/relayer.test.ts` drives the engine against a
fake chain: one POST ⇒ every leg, exact `gasUsed × effectiveGasPrice` charged per leg across
two chains, a reverted receipt still charged, `confirmations === 2`, a receipt-watch throw
leaving the leg `submitted` with a hash and an SSE error event, and a broadcast failure
leaving it `failed` with no hash and no charge. The three-anvil chaos test in the original
plan was not written.

## P6 — MultiBaas as the treasury platform (done)

MultiBaas (Curvegrid) is the institutional control plane: custody, policy, audit
trail, and a transaction manager that resubmits for you.

`packages/multibaas` — a thin typed adapter over the REST API:

| Concern | MultiBaas surface | Used for |
|---|---|---|
| Custody | Cloud Wallets, HSM-backed keys | the relayer's per-chain signers; the treasury's own signer |
| Submission | Transaction Manager (TXM) | nonce management, automatic resubmission, status |
| Contracts | contract deploy/link/call API | CrossPermit + spoke addresses per chain, one registry |
| Observability | event queries, webhooks | allowance granted/consumed, position opened, APY change |
| Audit | per-key transaction history | one signature ⇒ one auditable record across N chains |

Design rules:

- **Config-driven, degrades gracefully.** `MULTIBAAS_URL` + `MULTIBAAS_API_KEY`
  present ⇒ Cloud Wallet signing and TXM submission. Absent ⇒ local signer, same
  interface, loud log line saying which mode is active. No code path silently
  changes who holds the keys.
- **The adapter is an interface with two implementations, which is the one
  abstraction this codebase earns** — because the two differ in *where the private
  key lives*, and that is exactly the seam an institution audits.
- Webhook receiver verifies the HMAC signature before it parses the body.
- Treat every field that comes back from the API as untrusted input, including
  addresses.

**Verification:** adapter contract tests against a recorded-fixture server in
no-key mode; `bun run packages/multibaas/scripts/smoke.ts` against a live deployment.
ABI registration and per-chain address linking are their own runnable step,
`bun run packages/multibaas/scripts/register-crosspermit.ts`, which reads `listAddresses`
back so `linked` is verified rather than assumed and exits 1 if a chain failed to link.

## P7 — Institutional: yield and RWA

### Aave v4 yield

Aave v4 went live on Ethereum mainnet on 2026-03-30 and Avalanche on 2026-07-15,
with a Hub-and-Spoke design: a Liquidity Hub holds the assets, Spokes are
independent markets with their own collateral set, risk parameters and
liquidation rules, all drawing on shared hub liquidity. That shape is the reason
it fits here — an institution wants its own risk perimeter without giving up
liquidity depth.

`contracts/src/treasury/YieldRouter.sol`

- `supply` / `withdraw` against a configured Spoke, pulling the principal through
  `CrossPermit.transferFrom` so the deposit rides the same single signature.
- `apr()` / `apy()` — APR read from the spoke's rate, APY as the continuous
  compounding of it; both returned in ray with the basis stated in the ABI docs,
  because a treasury that mistakes one for the other misreports its own returns.
- Per-spoke caps and an allowlist, so a mispriced spoke cannot absorb the book.
- ~~`PositionRegistry` — per-account, per-chain position accounting~~ — **never written.**
  The dashboard reads positions from chain storage and from the MultiBaas event ledger
  instead, and shows both rather than reconciling them.

### Tokenized-equity desk (NVDA and peers)

Tokenized equities crossed $1.07B on-chain; Ondo (`NVDAon`, Ethereum and BNB,
~61% share) and Backed's xStocks (`NVDAx`, ERC-20, ~25%) are the two venues that
matter. Both are ERC-20s with a regulated custodian holding the underlying 1:1.

`contracts/src/treasury/EquityDesk.sol`

- Venue adapters behind one `IEquityVenue` interface — `mint`/`redeem` where the
  issuer supports it, AMM route otherwise.
- Every buy funded by a `CrossPermit` allowance, so a cross-chain rebalance is
  still one signature.
- Slippage bound and a staleness-checked oracle on every fill; reject rather than
  fill wide.
- **Compliance is a first-class input, not a footnote.** These instruments are
  access-gated (Reg D / Reg S, jurisdictional allowlists). The desk carries an
  `IComplianceGate` the venue adapter must consult, defaulting to deny. The
  product decision of who may trade is the operator's; the contract's job is to
  make that decision explicit and enforced rather than implicit.

**Verification:** `contracts/test/TreasuryFork.t.sol`, against live mainnet Aave v4 and the
live NVDAon token — supply, warp thirty days, withdraw, and a round-trip buy/sell. No
mainnet broadcast, and nothing deployed: neither contract has a `deployments/*.json` entry.
The fork is taken at HEAD with no pinned block, so the yield and the rates differ every run;
the suite asserts `out > 0`, `apy >= apr` and a sane APR rather than fixed figures.
`EquityDesk.buy` is owner-only (`NotOwner(address owner, address caller)`) — this desk has
no operator registry, so it cannot fill on a client's behalf.

## P8 — Institutional dashboard

`apps/web` — Next.js App Router, wagmi + viem, WalletConnect via Reown AppKit.

- **Permission** — build a multichain intent, see every chain's bundle in plain
  language before signing, sign once, watch the relayer light up each chain live
  over SSE. One click end to end.
- **Treasury** — positions per chain, idle vs deployed, allowance ledger with
  what is outstanding and to whom, and a kill switch that signs a cross-chain
  `LOCK` for a spender.
- **Yield** — Aave v4 spokes with APR and APY side by side and the difference
  labelled, utilisation, caps, and a one-signature "deploy idle cash" flow.
- **Desk** — NVDA and peers: quote, slippage bound, compliance status, fill.
- **Audit** — one signature expanded into its N on-chain records, each with an
  explorer link. This is the screen that sells the product to a risk committee.

Non-negotiables: never render an amount without its decimals resolved from the
token; show the signing payload before the wallet does; no action is reachable
without its simulation having succeeded.

## P9 — Hardening

Three different tests, routinely conflated into one claim. What each actually covers:

- `contracts/test/LeafParity.t.sol` — **six committed fixtures**, not a fuzz. The SDK's
  `leafOf` output is written to `contracts/fixtures/leaf-fixtures.txt` by `gen-fixtures.ts`,
  regenerated from the working tree by `script/test.sh`, and asserted against
  `hashChainPermits`.
- `contracts/test/MerkleParity.t.sol` — **the real SDK-vs-contract parity**, over committed
  proofs for tree sizes 1..8: every proof the client produced folds back to the root under
  OpenZeppelin's sorted-pair hashing on chain.
- `contracts/test/Invariants.t.sol` — **fuzzes the contract against itself**, 1..32 leaves.
  No TypeScript enters, and its tree is a Solidity reimplementation, so it cannot catch SDK
  drift. What it does catch: an allowance never exceeds what was signed, a `LOCK` cannot be
  raised by a grant, a burnt salt stays burnt, `DECREASE` floors at zero, a proof does not
  cover another leaf, and the leaf is injective and order-sensitive.
- `contracts/test/LiquidityDeskAuth.t.sol` — the `add` authorisation gate, offline.
- Relayer property and chaos tests: **not written.** `apps/relayer/test/relayer.test.ts`
  covers the receipt → charge → budget loop against a fake chain instead.
- Threat model doc: hostile RPC, hostile relayer, compromised relayer key,
  compromised MultiBaas key, reorg during fan-out, and a griefing economic
  analysis.
- Ops runbook: key rotation and incident response — `docs/runbook.md`. The per-chain
  circuit breaker it planned does not exist.

---

## Ground rules

1. **The leaf is computed client-side. Always.** Any change that lets a leaf
   arrive from an RPC is a vulnerability, not a refactor.
2. **Pinned dependencies are load-bearing.** Bumping a submodule changes the init
   code and therefore the address. Treat it as a migration.
3. **The relayer is a convenience, never a dependency.** Every flow must remain
   completable by the client alone.
4. **Two implementations of the signer, no more abstractions than that.** Local
   and MultiBaas differ in where the key lives; nothing else in this codebase
   gets an interface for a single implementation.
5. **Simulate before broadcast**, everywhere, without exception.
6. **APR and APY are labelled distinctly** in every ABI, API response and pixel.
7. **Compliance gates default to deny.**


---

## What remains

Recorded rather than quietly dropped.

| Gap | Why it is still open |
|---|---|
| Optimism Sepolia has no MultiBaas deployment | the free tier caps at two, and both are used (Base Sepolia, Ethereum Sepolia). A plan upgrade, not a code change. |
| Cloud Wallet path unexercised live | a MultiBaas Cloud Wallet is backed by an external provider — Azure Key Vault, with a client id, secret, tenant and subscription — and HSM-protected keys need a Premium vault. That is an Azure account and a real cost, so it cannot be provisioned from here. `cloudWalletSigner` is written and compile-checked; custody is `local` on every chain until someone attaches a vault. |
| Contracts unverified on the explorers | needs an Etherscan API key, which this environment does not have. |
| Reorg detection | receipts are now waited to 2 confirmations, which makes a `confirmed` row much harder to un-confirm, but a leg is still never re-checked afterwards. Acceptable on testnets, not on an L1 carrying value. |
| The deployed LiquidityDesks predate the `add` gate | all three carry the ungated bytecode and must be redeployed. `liquidity-demo.ts` and the dashboard's **Add to the pool** button also still call `add` without a `setOperator` step, so they will revert against a gated desk. |
| `treasury/` is deployed on no chain | `YieldRouter` and `EquityDesk` exist only in the mainnet-fork suite. |
| The kill switch is a CLI signature | `lifecycle.ts`'s `lock` stage and `revokeEntries()` cover every spender; the dashboard can only withdraw an invitation, which closes no exposure. |
| Equity venue adapter | NVDAon's on-chain route is the issuer's gated mint/redeem window, not an AMM a fork can trade against. The desk's own guards are proved; the venue is a mock. |
| MultiBaas keys are Administrators-scope | Internal Users is the production posture. An Administrators key can rewrite the audit record. |
