# ETHGlobal Tokyo 2026 — CrossPermit submission

Paste-ready answers for <https://ethglobal.com/events/tokyo2026/project>.
Fields follow ETHGlobal's standard submission form. Open items are in
[Before you hit submit](#before-you-hit-submit).

---

## Project name

**CrossPermit**

## Tagline / short description (~1 line)

> One EIP-712 signature arms token allowances on Ethereum, Base and Optimism at once — and Uniswap's own Universal Router spends them.

Alternates:
- One signature. Every chain. A Permit2-shaped allowance layer that is the same contract at the same address on every chain.
- An institution moving collateral across four chains signs four times. CrossPermit makes it one signature and one audit record.

---

## Description

### What a cross-chain allowance is

**An allowance is permission to spend, not a transfer.** Approving USDC for a router moves no money.
It writes a number into the token's storage: *this spender may pull up to this much from me.*

**That number lives on one chain.** Approving on Base writes to Base and nowhere else; Arbitrum has
never heard of it. Authority is per-chain because storage is per-chain.

**Permit2 fixed half of this.** Approve Permit2 once per token, then grant spenders by signing
off-chain messages — free, gasless, and what Uniswap's Universal Router pulls through.

**But a Permit2 signature can't leave its chain.** An EIP-712 digest includes the domain: `chainId`
and `verifyingContract`. Every chain's Permit2 has its own domain, so its own digest. A signature
valid on Base is simply invalid on Arbitrum. Four chains, four signatures.

**A cross-chain allowance is one signed message that grants allowances on many chains at once.**
The ledgers stay separate — storage can't be shared — but the authorisation is single.

**Nothing is bridged.** No token crosses anything. Base tokens stay on Base. Only the permission
becomes portable, which is why CrossPermit is not a bridge and carries no bridge's risk.

Every cross-chain tool built so far worked around this instead of fixing it. **Bridges move tokens,
not permission.** They answer "my money is on the wrong chain." Nobody answered "my *authority* is
on the wrong chain," so the workaround is pre-positioned capital and a fresh signature per chain,
forever.

### Who pays for that

A fund managing client capital on-chain, held between two constraints that point opposite ways:

1. **It cannot take custody.** Regulatory line and trust line at once. The client's tokens stay in the client's wallet.
2. **It cannot ask for a signature per chain per week.** A desk that needs clients at a wallet prompt to rebalance is a group chat, not a desk — and every prompt is another approval risk and another audit line.

So a desk moving collateral across four chains asks for four signatures from four wallet sessions:
four approval risks, and four audit records a risk committee has to *manually believe* are one
decision.

### What CrossPermit does

A user signs **one** EIP-712 message. That one 65-byte signature sets allowances and executes
transfers on Ethereum Sepolia, Base Sepolia and Optimism Sepolia. A relayer fans all three legs out
from one HTTP request, and a Uniswap Universal Router deployed with `permit2 := CrossPermit` spends
them — including a **real Uniswap v4 swap on each chain**, settled out of that one allowance.

Four signatures and four audit records become one of each. The desk never touches the tokens.

### How the signature is allowed to travel

Three moves, all load-bearing:

1. **Pin the domain.** `chainId = 1` everywhere, so the digest doesn't name a chain — but the domain still includes `verifyingContract`, so the signature is only portable if the address is.
2. **Prove the address.** ERC-2470 singleton factory: identical init code plus identical salt gives an identical address on every chain, forever.
3. **Merkle the rest.** One permit bundle per chain, each hashed to a leaf **client-side**, folded into a left-leaning tree; the user signs the root. On each chain, anyone submits that chain's bundle plus its proof; CrossPermit rebuilds the root, recovers the signer, applies the bundle. No chain can apply another's leaf, and revocation has the same shape: one signed `LOCK`, every chain.

**The proof it works:** Optimism Sepolia was added *after* the first two were live. Same init code,
same salt — CrossPermit landed at the same address on a chain it had never touched, and its
`DOMAIN_SEPARATOR` came back byte-identical with zero coordination. Not a demo; the invariant
surviving contact with a new chain.

```
DOMAIN_SEPARATOR()   0x4ce820a58ffb00fe1b6cb52f083bdd1cfd176732c34db34a84517668750aa5e4
```
Identical on all three. Read it yourself.

### The product on top: the desk

```
add a client  ->  send one link  ->  they sign once  ->  you allocate
```

**A mandate is an invitation, not authority.** Creating one stores what the desk *intends to ask
for* and returns a link; nothing moves until the client opens `/c/<token>` and signs. That is why
reading a mandate by its token needs no key while creating and listing sit behind the desk's key —
the link carries an offer, and whoever holds it can only sign *their own* permission with it.

The client's page renders every per-chain bundle in plain language, computed on the page, **before
the wallet opens** — including the allowance already outstanding to that spender, because an entry
carrying an expiry is an *increase*, so the cap alone would understate the grant.

Then the desk allocates, and the writ does real work:

| | What it proves | Status |
|---|---|---|
| **Trade** | v4 swap through the Universal Router's real `V4_SWAP` settle path | live, 3 testnets |
| **Invest** | v4 LP position paid by `CrossPermit.transferFrom(client -> PoolManager)`, keyed by `salt = client address` so v4 core holds it in the client's name | live, 3 testnets |
| **Earn** | 10 000 USDC supplied, warped 30 days, more out than in — Aave v4's real Core Hub and MAIN Spoke | mainnet fork, unpinned block |
| **Hold RWAs** | `EquityDesk`, compliance-gated, reading Ondo's real live `NVDAon` | mainnet fork, venue mocked |

And the client can leave whenever: **one signature locks every spender on every chain**, and the
spend that worked a second ago reverts. Revocation is as portable as the grant — and it is a signed
`LOCK` driven from the CLI (`packages/sdk/scripts/lifecycle.ts`, built by `revokeEntries()` in the
SDK), not a button. A `LOCK` is per `(owner, token, spender)` and the mandate grants two spenders,
so a revocation naming only the router leaves a live allowance standing; `revokeEntries()` exists to
make covering both a single signature. The dashboard can withdraw the *invitation*, which closes no
exposure, and says so on screen.

### Why a risk committee signs off

Custody and audit run through MultiBaas: every grant, lock and burned salt is a decoded `Permit`
row. The client dashboard folds four sources that are **never merged** — chain storage says what an
allowance *is*; the MultiBaas ledger says how it got there and is the only record of a grant that
has lapsed; `extsload` on the PoolManager says what the venue is doing; the desk's own table says
what was *asked for* and is never evidence of what was granted. Where they disagree, both are
shown. Where a chain has no MultiBaas deployment, it says so rather than rendering an empty history
as though nothing happened. The **Access** panel names every spender and raises an *unrecognised
spender* row when it is neither the router nor the liquidity desk.

### Why now

v4 made the venue programmable and the Universal Router made settlement uniform, so the last thing
between a fund and one-click multichain allocation is the signature count. That is a permission
problem — and the fix costs Uniswap nothing to adopt: `permit2 := CrossPermit` at deploy time, and
not one line of the router's payment path changes.

**Live:** `0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B` on Ethereum Sepolia, Base Sepolia and
Optimism Sepolia. Salt `keccak256("CrossPermit v1")`, solc 0.8.27, optimizer 1e6 runs.

---

## How it's made

### The one signature, in full detail

This is the core of the project, so here is the whole mechanism rather than a summary.

**1. A domain that is the same on every chain.** EIP-712 hashes a message under a domain separator
over `(name, version, chainId, verifyingContract)`. Normally `chainId = block.chainid`, which is
exactly what pins a Permit2 signature to one chain. `contracts/src/lib/EIP712.sol` is OpenZeppelin's
EIP712 with one change:

```solidity
uint256 private constant CROSS_CHAIN_ID = 1;   // not block.chainid
```

Now the domain names no chain — but it still names `verifyingContract`, so the separator only comes
out equal everywhere if the **address** is equal everywhere. That is what ERC-2470 buys: identical
init code + identical salt → identical address, on any chain, forever. Both halves are needed; either
alone gives a different digest.

Verified live on all three deployments:

```
DOMAIN_SEPARATOR()   0x4ce820a58ffb00fe1b6cb52f083bdd1cfd176732c34db34a84517668750aa5e4
```

**2. One bundle per chain, hashed to a leaf.** A bundle is a `ChainPermits`: a `chainId` plus a list
of `AllowanceOrTransfer` entries — `(modeOrExpiration, tokenKey, account, amountDelta)`. One entry
grants or decreases an allowance, locks or unlocks a spender, or executes an immediate transfer;
`modeOrExpiration` selects which. `hashChainPermits` hashes each entry, concatenates the hashes,
and hashes that together with the chain id under

```
ChainPermits(uint64 chainId,AllowanceOrTransfer[] permits)
AllowanceOrTransfer(uint48 modeOrExpiration,bytes32 tokenKey,address account,uint160 amountDelta)
```

The chain id is **inside the leaf**, so a leaf is bound to exactly one chain by construction — and
the contract still checks `permits.chainId == block.chainid` and reverts `WrongChainId` if not. Two
independent guards, because this is the one place a mix-up would be silent.

**3. The leaf is computed by the client. Always.** `leafOf()` in `packages/sdk/src/crosspermit.ts`
reimplements that hashing in TypeScript. There is an `eth_call` to the on-chain `hashChainPermits`,
but it is used **only as an equality assertion** — a mismatch throws. If the leaf came *from* the
RPC, a hostile endpoint could hand back the hash of a bundle the user never saw and the user would
sign it happily. The signature would be perfectly valid, over the attacker's bundle. So: compute
locally, make the chain agree, never the other way round.

**4. Leaves fold into a merkle root.** Pairs are hashed with **OpenZeppelin sorted-pair hashing**
(`keccak256(min(a,b) ‖ max(a,b))`), so the client's tree and the contract's `MerkleProof.processProof`
fold identically without carrying index bits. The tree is deliberately **left-leaning** rather than
balanced:

```
root = H( … H( H(leaf0, leaf1), leaf2 ) … , leaf_{n-1} )
```

so the **last** leaf sits one hop from the root and carries a one-element proof. Put the most
expensive chain last and it pays the least calldata and the least hashing. A balanced tree would
have spread that cost evenly, which is the wrong shape when chain gas differs by orders of magnitude.

**5. The user signs the root. Once.** The signed struct is:

```
CrossPermit(address owner,bytes32 salt,uint48 deadline,uint48 timestamp,bytes32 merkleRoot)
```

No chain id anywhere in it — that lives one level down, inside each leaf. One wallet prompt, one
65-byte signature, and the digest is byte-identical on every chain because the domain is.

**6. Each chain redeems its own leaf, and only its own.** Anyone submits, to chain N, that chain's
bundle plus its proof. The contract recomputes the leaf from the bundle it was handed, runs
`processProof(proof, leaf)` to get a root, rebuilds the signed digest from
`(owner, salt, deadline, timestamp, root)`, and recovers the signer. A wrong bundle gives a wrong
leaf, a wrong root, and a signature that recovers to somebody else — so there is nothing to check
separately. Submission is permissionless: the proof is public data and the bundle only ever moves
the signer's own tokens, so a relayer is a convenience, never a dependency.

**7. Replay protection is per chain, on purpose.** `_useNonce(owner, salt)` burns the salt in the
`SaltRegistry` — but that registry is per-chain storage, so one intent applies **exactly once on
each chain**, which is precisely what "one signature, every chain" has to mean. `deadline` bounds
validity. `timestamp` orders competing intents for the same owner, and is set *behind* wall clock
(see below) because a head block is routinely a few seconds old.

**8. Cancellation has the same shape.** `packages/sdk/src/cancel.ts` builds the mirror structure
over `CANCEL_CROSSPERMIT_TYPEHASH`: one signed root that burns salts on every chain, so a signed
permit can be retracted everywhere **before** it is ever submitted. And `LOCK` entries do the live
version — one signature disables a spender on every chain, and the pull that worked a second ago
reverts.

**What each piece is load-bearing for:** the pinned `chainId` makes the digest portable; the CREATE2
address makes the domain portable; the merkle root lets one digest commit to *different* grants per
chain; the chain id inside the leaf stops those grants being swapped between chains; and the
client-side leaf stops an RPC choosing what the user signs. Remove any one and the scheme is either
broken or unsafe.

**Contracts — Solidity 0.8.27, Foundry.**
`CrossPermit.sol` is the allowance ledger plus a salt registry and multi-token transfers. Its
`transferFrom` overloads are **selector-identical to Permit2's**, which is the whole trick: the
Universal Router's payment path is completely unmodified; we only swap the `PERMIT2` immutable at
construction. Merkle verification uses OpenZeppelin sorted-pair hashing. `LiquidityDesk.sol` is a v4
unlock-callback adapter. `treasury/YieldRouter.sol` (Aave v4) and `treasury/EquityDesk.sol`
(tokenized equities, with an `IComplianceGate` that defaults to deny) sit on top.

**Deployment.** `script/deploy.sh` goes through the ERC-2470 singleton factory, so the address is a
function of init code and salt alone. `PERMIT2` is an internal immutable with **no getter**, so it
cannot be read off the deployed router. Two artifacts stand in: the deploy log
(`deployments/router-<chain>.log:10`, `permit2: 0x659C…de1B`, one per chain) and — the one that
actually settles it — `FORK=1 forge test --match-contract RouterFork`, a live `V4_SWAP` paying the
real `PoolManager` out of a CrossPermit allowance and out of nothing else. No script in this repo
greps the deployed runtime bytecode; earlier drafts claimed one did.

**SDK — `packages/sdk`, TypeScript + viem.** Builds per-chain bundles, computes leaves, folds the
tree, produces the one signature and the cancellation path. The `eth_call` to `hashChainPermits` is
kept **only as an equality assertion** — a leaf that arrived *from* an RPC would let a hostile
endpoint choose what the user signs. The tree is left-leaning, so the last leaf sits one hop from
the root and carries the shortest proof: put the most expensive chain last.

**Relayer — `apps/relayer`, Bun.** One POST, N chains: admission control, per-owner rate and gas
budgets, simulate-before-broadcast everywhere without exception, SSE so the UI lights up each chain
as it lands. It can pay gas, order its own submissions and refuse to submit. It **cannot** change a
recipient, a spender or an amount — all of that is inside the signed bundle — and every flow stays
completable by the client alone. The relayer is a convenience, never a dependency.

**Desk layer + web — `apps/web`, Next.js App Router, wagmi/viem, Reown AppKit/WalletConnect.**
A multi-manager gatehouse in front of the relayer: wallet sign-in, scoped books, desk registry. The
landing page, the desk at `/app`, one screen per client at `/app/client/<token>`, the client's
mandate at `/c/<token>`. Pool price and in-range depth are read by `extsload` straight off the v4
PoolManager. Claiming a link is one conditional statement, so two people racing it cannot both win.

**MultiBaas — `packages/multibaas`.** The control plane: ABI registration and address linking (so
`Permit` is a decoded row rather than calldata), the event feed behind the allowance ledger, the
activity timeline, the audit trail, address aliases so the demo reads in English on a projector, and
the signer abstraction for custody. `docs/multibaas.md` is a feature-by-feature verdict — **in use /
adopt / skip**, with the reason for each, including the features we deliberately did *not* use.

**Three things worth naming as hacks.**
1. **The signed ordering timestamp is set behind wall clock.** CrossPermit rejects a permit that
   orders itself into the future, and a chain's head block is routinely a few seconds old — Ethereum
   builds one every twelve seconds. Signing with `Date.now()` fails intermittently on slow chains and
   never on fast ones, which is the worst shape a bug can have. `TIMESTAMP_LAG` is a constant offset,
   so ordering between intents is untouched.
2. **`LiquidityDesk.add` takes an `owner`, and gating it was the one thing we got wrong first.**
   The original argued it was safe to leave open because the allowance was the only gate. It was not:
   the caller supplies `key` as well as `owner`, so anyone could name a pool of their own construction
   and settle the victim's entire CrossPermit allowance into it. An allowance bounds the amount; it
   never named a pool. `add` now requires `msg.sender == owner`, or an address the owner registered
   on chain through `setOperator(address,bool)`, else `NotAuthorised(owner, caller)`
   (`contracts/src/LiquidityDesk.sol:112`), with `contracts/test/LiquidityDeskAuth.t.sol` as the
   offline regression. `remove` and `collect` were always `msg.sender`-scoped, so the desk still has
   no position to withdraw and nothing to sweep. The mandate is now two acts rather than one: the
   signature says how much may move, `setOperator` says who may choose where. **The three deployed
   desks predate the fix and carry the ungated bytecode** — redeploy before pointing anyone at them.
3. **Unichain Sepolia was dropped mid-build** because MultiBaas does not support it, and a chain
   there could never carry a control-plane audit trail. A chain without an audit record is not a
   chain this product can stand on.

**Testing.** `script/test.sh` is the single offline gate — root `bun run test` and the CI `offline`
job both call it and nothing else. It typechecks `packages/sdk`, `packages/multibaas`, `apps/web` and
`apps/relayer`, runs their unit suites (96 tests at the time of writing: 24 SDK, 40 web, 32 relayer),
runs `forge build`, regenerates the parity fixtures from the working tree, runs `forge test` (27
passing, three fork suites skipped without `FORK=1`), and greps for upstream branding. CI adds two
fork jobs: `fork` (Router + Liquidity, testnets, **blocking**) and `mainnet-fork` (Treasury,
`continue-on-error`).

Three different Foundry tests get conflated into one claim, so: `LeafParity` pins the SDK's `leafOf`
against **six committed fixtures** (regenerated every run, so drift fails a test rather than a
testnet transaction). `MerkleParity` is the real SDK-vs-contract parity, over committed proofs for
tree sizes **1..8**. `Invariants` fuzzes the **contract against itself**, 1..32 leaves — no
TypeScript enters and its tree is a Solidity reimplementation, so it cannot catch SDK drift; what it
does catch is that an allowance never exceeds what was signed, a `LOCK` cannot be raised by a grant,
a burnt salt stays burnt, `DECREASE` floors at zero, a proof does not cover another leaf, and the
leaf is injective and order-sensitive. `LiquidityDeskAuth` covers the `add` gate offline.
`FORK=1 forge test --match-path 'test/*Fork*'` runs the live-chain proofs: v4 swaps on three testnets against Uniswap's real
`PoolManager`, the full LiquidityDesk sequence *including the two things the desk must not be able
to do*, and Aave v4 + NVDAon against live mainnet. No broadcast.
`packages/sdk/scripts/lifecycle.ts` runs eight real state transitions end to end against the live
testnets, covering **every spender the mandate named** rather than just the router; `onboard.ts`
grants both spenders on every chain and checks the mandate loop the same way.

---

## Links

| Field | Value |
|---|---|
| Source code | https://github.com/sairammr/crosspermit |
| Live demo | <https://crosspermit.vercel.app/> — the in-app pitch deck is at `/pitch` |
| Demo video | _TBD — 2–4 min, script below_ |

---

## ETHGlobal form — "Select prizes" page

Field-by-field, in the order the form asks.

### Track

**Building from Scratch.** First commit is from this event; no prior codebase extended. (If any
judge asks: `git log --reverse` shows the repo begins at the hackathon.)

### Submission type

**Top 10 Finalist & Partner Prizes.** Live Judging, Sunday 09:30 JST. The pitch is a one-liner and
a live wallet prompt, which is exactly the shape that plays in a 3-minute slot.

### Partners (max 3 — using 2)

**Uniswap Foundation ($10,000)** and **Curvegrid ($3,000)**.

Leave the third slot **empty**. World, ENS, 1inch, Sui and Intercepta are not integrated, and a
partner selected without a working integration reads as padding to the people scoring it.

Under *"Which other partners' technologies have you used?"* — select nothing unless you genuinely
used it. Aave and Ondo appear in the project but are not Tokyo partners.

---

### Uniswap Foundation — "How are you using this Protocol / API?"

> CrossPermit is a drop-in Permit2 replacement for the Uniswap stack. We deploy Uniswap's own
> Universal Router **unmodified except for one constructor argument** — `permit2 := CrossPermit` —
> which works because CrossPermit's `transferFrom` overloads are selector-identical to Permit2's,
> so the router's payment path is untouched. The point of doing that: a Permit2 signature is pinned
> to one chain by its EIP-712 domain, so a v4 swap on three chains costs three signatures today.
> CrossPermit is address-identical on every chain (ERC-2470) and pins `chainId = 1` in its domain,
> so **one signature funds a real v4 swap on Ethereum Sepolia, Base Sepolia and Optimism Sepolia at
> once**.
>
> We prove it on the real payment path, not the shortcut. `PERMIT2_TRANSFER_FROM` only shows the
> immutable is set; `V4_SWAP` is what a dApp actually uses, and it pays the PoolManager through
> `V4SwapRouter → SETTLE_ALL → _payStandard → payOrPermit2Transfer → PERMIT2.transferFrom`. Our
> fork tests run that against Uniswap's live `PoolManager` on all three chains: 1 000 000 in →
> 996 999 out (the 0.3% fee), allowance ends at zero, and the router holds no plain ERC20 approval,
> so the input can only have come through CrossPermit.
>
> We also extend it past swapping: `LiquidityDesk` opens a **Uniswap v4 LP position** inside the
> `unlock` callback, paying both sides with the same `CrossPermit.transferFrom(client → PoolManager)`
> call the router makes, and keying the position by `salt = the client's address` so v4 core
> custodies it in the client's name and the adapter needs no share accounting. Pool price and
> in-range depth in the UI are read by `extsload` straight off the PoolManager.

**Link to the line of code where the tech is used** (pick one for the box, the rest go in the
feedback field):

```
https://github.com/sairammr/crosspermit/blob/main/script/deploy.sh#L188-L191
```
The `permit2 := CrossPermit` substitution itself — it asserts there is **exactly one** canonical
Permit2 literal in the source file before rewriting it, so a silent miss is impossible.

Supporting:
- `contracts/test/RouterFork.t.sol#L75-L113` — `V4_SWAP` against the live PoolManager on all three chains
- `contracts/src/LiquidityDesk.sol#L211` — the v4 `unlock` settle leg paid by `CROSS_PERMIT.transferFrom`
- `contracts/src/LiquidityDesk.sol#L149` — `unlockCallback`
- `contracts/test/SwapEncoding.t.sol#L38-L71` — command-encoding parity with the router

**Ease of use: 8/10.**
Justification, if asked: the substitution worked on the first try and the payment path needed zero
changes, which is a real compliment to the stack's design. The two points come off for what it took
to *prove* it, and for v4 adapter ergonomics.

**Additional feedback for the sponsor** (this doubles as `FEEDBACK.md` — the track **requires** the
file, plus the Uniswap Developer Feedback Form linking to it):

1. **`PERMIT2` is an internal immutable with no getter.** Substituting it is easy; proving to a
   reviewer that you did takes three separate artifacts — the deploy log, the constructor args in
   the broadcast artifact, and grepping the CrossPermit address out of the deployed runtime
   bytecode (it appears four times, once per use site). A public getter, or a one-off event at
   construction, would make an audited router self-describing at zero cost.
2. **Selector-identical `transferFrom` overloads are an undocumented extension point** — and
   arguably the cheapest upgrade path the whole stack has. We built on it deliberately; it deserves
   to be documented as a supported seam rather than discovered.
3. **v4 `unlock` callback ergonomics for third-party payers.** Every example assumes the caller
   pays. An adapter that settles from *someone else's* allowance is a legitimate and, we think,
   common shape (any managed or delegated position), and there is no worked example of it.
4. **`salt` as the position owner key deserves a note in the docs.** Keying by the beneficiary's
   address lets an adapter skip share accounting entirely and leaves custody with v4 core. We found
   this by reading core, not docs, and it removed an entire contract from our design.
5. **`extsload` for frontends needs a cookbook entry.** Reading price and in-range liquidity
   straight from the PoolManager is the right way to build a UI that can't drift from the chain,
   but the slot layout has to be reverse-engineered from source.
6. **Testnet discovery is the roughest edge.** v4 `PoolManager` addresses and which pools actually
   have liquidity across Ethereum / Base / Optimism Sepolia took longer than the integration did.
   A maintained testnet deployment + seeded-pool table would save every hackathon team the same hour.

---

### Curvegrid — "How are you using this Protocol / API?"

> MultiBaas is our **control plane**: custody, contract registry, event indexing and the audit
> trail that makes this product sellable to a risk committee rather than just demoable.
>
> Concretely: we register the CrossPermit ABI and link it per chain with an explicit
> `startingBlock`, so every `Permit`, lock and burned salt becomes a **decoded event row** instead
> of calldata. The relayer writes through MultiBaas so each cross-chain leg lands in one ledger, and
> the client dashboard is built on the event feed — the allowance ledger, the activity timeline, and
> the audit screen that expands one signature into every on-chain record it produced, each with an
> explorer link. Address aliases let the demo read in English. `cloudWalletSigner` is written
> against the Cloud Wallet API for custody (unexercised live — an HSM key needs an Azure Premium
> vault we can't provision from a hackathon).
>
> The design rule we care about most: the MultiBaas ledger and chain storage are **never merged**.
> Chain storage says what an allowance *is*; the MultiBaas ledger says how it got there and is the
> only record of a grant that has since lapsed. Where they disagree the dashboard shows both, and
> where a chain has no MultiBaas deployment it says so rather than rendering an empty history as
> though nothing had happened.
>
> Applying for: **Best Digital Asset Dashboard** (the per-client screen at `/app/client/<token>`,
> four sources shown side by side, every spender named, an *unrecognised spender* row when it is
> neither the router nor the liquidity desk) and **Best RWA Tokenization Project** (`EquityDesk` for
> tokenized equities — slippage bound, staleness-checked oracle, and an `IComplianceGate` that
> defaults to deny because Reg D / Reg S instruments are access-gated; proved against Ondo's real
> live `NVDAon`, with the venue adapter honestly still a mock).

**Link to the line of code where the tech is used:**

```
https://github.com/sairammr/crosspermit/blob/main/packages/multibaas/src/treasury.ts#L95
```
`registerCrossPermit()` — ABI upload + per-chain address link with an explicit `startingBlock`.

Supporting:
- `packages/multibaas/src/treasury.ts#L141-L145` — the allowance ledger, folded from the decoded `Permit` event feed
- `packages/multibaas/src/treasury.ts#L195` — the cross-chain activity timeline
- `packages/multibaas/src/signer.ts` — the custody abstraction, incl. the Cloud Wallet path
- `docs/multibaas.md` — every MultiBaas feature, with a verdict: **in use / adopt / skip**, and the reason

**Ease of use: 7/10.**
The REST API is clean and the event indexer did exactly what we needed once it was pointed
correctly. Points come off for three failure modes that are silent or misleading (below).

**Additional feedback for the sponsor:**

1. **`rawAbi` must be a JSON *string*, not an object.** Passing the parsed form returns *"unable to
   parse JSON"*, which reads like a malformed request body rather than one bad field type. That
   error message cost us real time; naming the field would fix it.
2. **Omitting `startingBlock` links the contract and then silently indexes nothing.** This is the
   worst shape a default can have — the call succeeds, the UI looks correct, and events simply never
   arrive. Either require it, or surface "indexing from block N" in the link response.
3. **`bin` is stored `NOT NULL` and must keep its `0x` prefix.** Undocumented, and the failure is
   not obviously about that field.
4. **The contract-method encoder has no documented form for a tuple plus a `bytes32[]`.**
   CrossPermit's `permit(...)` takes exactly that, so we fell back to submitting raw signed
   transactions. Complex-type encoding is the gap between "MultiBaas can read my contract" and
   "MultiBaas can drive it".
5. **We deliberately kept reads on plain `eth_call` rather than the methods API** — a failed read
   must be distinguishable from a genuine zero allowance, and an extra hop adds one more way to be
   told "no data". Worth documenting which reads are safe to route through MultiBaas and which are
   not; right now that judgement is left entirely to the developer.
6. **The free tier's two-deployment cap shaped our architecture, not just our budget.** We dropped
   Unichain Sepolia entirely because MultiBaas does not support it and a chain there could never
   carry an audit trail; Optimism Sepolia runs without a control plane for the same reason. A
   hackathon-scoped third deployment would remove an honest gap from our submission.
7. **Key scoping is too coarse for the audit story.** Our keys are Administrators-scope; Internal
   Users is the production posture, because an Administrators key can rewrite the very audit record
   the product's credibility rests on. Making that distinction loud in the onboarding flow would
   push teams to the right default.

---

## Prize tracks

### Uniswap Foundation — Best Uniswap Stack Contribution ($6,000) — primary

**The pitch in one line:** CrossPermit is a drop-in Permit2 replacement that makes a v4 swap on
three chains cost one signature instead of three, and it costs the Uniswap stack **zero lines of
change** to adopt — only `permit2 := CrossPermit` at router deploy time.

**Proved on the real path, not the shortcut.** `PERMIT2_TRANSFER_FROM` only shows the immutable is
set; it is not a path a dApp uses. `V4_SWAP` is: the router hands the swap to `V4SwapRouter`, whose
`SETTLE_ALL` pays the `PoolManager` through `_payStandard -> payOrPermit2Transfer ->
PERMIT2.transferFrom`. A swap that settles therefore proves the substitution on the **live payment
path**, against Uniswap's own live `PoolManager`. Every run returns **996 999 out for 1 000 000 in**
— the pool's 0.3% fee — the allowance ends at zero, and the router holds no plain ERC20 approval, so
the input can only have come through CrossPermit.

**And it extends past swapping.** `LiquidityDesk` pays both sides of a v4 `unlock` through that same
`transferFrom`, with the position keyed by `salt = the client's address` so v4 core custodies it in
the client's name and the adapter needs no share accounting of its own. Proved both directions with
two different keys: client arms the writ, a *different* key adds L=33 837 499, the desk's `remove`
reverts (no position under its salt), the client withdraws. That run predates the `add`
authorisation gate; the "different key" now has to be registered by the client through
`setOperator(address,bool)` first, and the deployed desks need a redeploy to carry the gate.

**Requirements checklist**
- [x] Public GitHub repo, open source (MIT; `NOTICE` carries the derivative-work attribution)
- [x] **`FEEDBACK.md` at repo root** — written; it carries the six Uniswap items below verbatim plus the MultiBaas friction table from `docs/multibaas.md`.
- [ ] Uniswap Developer Feedback Form, with a link to `FEEDBACK.md`

**`FEEDBACK.md` topics, all from things this build actually hit:**
- Substituting the Universal Router's `PERMIT2` immutable: it works cleanly, but `PERMIT2` has no getter, so *proving* the substitution to a reviewer took three separate artifacts. A getter, or a documented event, would cost nothing.
- Selector-identical `transferFrom` overloads are effectively an undocumented extension point for the whole stack. Worth documenting as one — it is the cheapest upgrade path Uniswap has.
- v4 `unlock` callback ergonomics for an adapter paying from a third party's allowance.
- Using `salt` as the position owner key to avoid adapter-side share accounting.
- `extsload` for reading pool price and in-range depth from a frontend.
- Testnet v4 `PoolManager` addresses and pool discovery across Ethereum / Base / Optimism Sepolia.

### Curvegrid — Best Digital Asset Dashboard ($1,000)

`/app/client/<token>` is built for the person who has to *sign off*, not the person who trades.
Rail (held, deployable, chains, terms asked versus granted); "how it grew" from MultiBaas `Permit`
events plus PoolManager storage; **Access**, naming every spender and flagging an unrecognised one;
platform; live v4 pools; ranked strategies with provenance on every figure; and a full history
ordered by the timestamp the client *signed*. The four sources are never merged, and where they
disagree the screen shows both — because a dashboard that silently reconciles is a dashboard that
hides the one row a risk officer needed. The dashboard also takes `?owner=0x...` for a read-only
view: a risk officer reviewing an account should not need its keys.

### Curvegrid — Best RWA Tokenization Project ($1,000)

`treasury/EquityDesk.sol` — tokenized equities with a slippage bound and a staleness-checked oracle
on every fill, reject rather than fill wide. **Compliance is a first-class input, not a footnote:**
these instruments are access-gated (Reg D / Reg S, jurisdictional allowlists), so the desk carries
an `IComplianceGate` that **defaults to deny**, and an unset gate denies everything. Who may trade
is the operator's product decision; the contract's job is to make that decision explicit and
enforced rather than implicit. Every buy is funded by a CrossPermit allowance, so a cross-chain
rebalance is still one signature. Proved against Ondo's real live `NVDAon` in a mainnet fork.
State plainly: the desk's own guards are proved, the **venue adapter is a mock**, because NVDAon's
on-chain route is the issuer's gated mint/redeem window rather than an AMM a fork can trade against.

### Curvegrid — Best AI Agent Project ($1,000) — only if you wire an agent first

`src/strategies.ts` is a pure recommender, not an agent. **Do not enter on that.** If you do wire
one before the deadline, the framing is strong: CrossPermit is the *authority layer* an agent needs
— a bounded, revocable, per-spender, per-chain mandate an agent can spend without ever holding a
key, where every action lands as a MultiBaas audit row and one signature revokes it everywhere.
Judges test the claim; a track not entered costs less than a claim that does not run.

**Curvegrid checklist**
- [x] Repo with contracts, tests, documentation, solid README
- [x] MultiBaas feedback — `docs/multibaas.md`, feature by feature, with the sharp edges named (`rawAbi` must be a JSON *string*, not an object; `bin` is stored `NOT NULL` and must keep its `0x`; omitting `startingBlock` links the contract and silently indexes nothing)
- [x] One-sentence summary — the tagline
- [x] Setup instructions — README "Run it", plus `DEPLOY.md`
- [ ] **Team intro** — names, handles, roles

### Not entering

World / IDKit, 1inch Aqua, ENS v2, Sui, Intercepta x402 — none integrated. Do not bolt one on in
the last hours. Judges test the requirement, and a broken integration costs more than a track
skipped.

---

## Demo script (2–4 min)

1. **The line, 15s.** "Permit2 is at the same address on every chain. Its signature still cannot leave one. So permission is the thing that does not travel — and bridges move tokens, not permission."
2. **The customer, 15s.** A fund cannot take custody, and cannot ask a client for a signature per chain per week. Today that means four signatures and four audit records for one decision.
3. **One link, 45s.** `/app` → add client → copy link. Client opens it: every chain, every spender, every cap, in plain language, computed on the page *before* a wallet opens. They sign. Once. Sixty-five bytes. **← the moment.**
4. **It lands, 20s.** SSE fills; three chains, three explorer links, from that one signature. Same address, same digest, three proofs.
5. **Proof it is not a trick, 20s.** `DOMAIN_SEPARATOR()` read live off all three — byte-identical. Say out loud: Optimism Sepolia was added after the fact and landed at the same address with no coordination.
6. **Allocate, 30s.** Uniswap's own router settles a real v4 swap out of that allowance. 1 000 000 in, 996 999 out. No second signature anywhere, and the desk never touched their tokens.
7. **They change their mind, 20s.** One signature `LOCK`s **every spender** — the router and the LP desk — on all three chains, and the spend that worked a moment ago reverts. Run it from the CLI (`bun run packages/sdk/scripts/lifecycle.ts --only lock`); there is no revoke button, and say so rather than let a judge look for one.
8. **Audit, 20s.** One signature expanded into every record it produced, MultiBaas-decoded, each with an explorer link — plus the unrecognised-spender row.
9. **Close, 10s.** "One signature. Every chain."

Pre-record the fan-out as a fallback. Do not bet the demo on three testnets being healthy at once.

---

## Known limitations — say these first, judges find them anyway

| Gap | Why |
|---|---|
| Optimism Sepolia has no MultiBaas deployment | free tier caps at two, both used (Base + Ethereum Sepolia). A plan upgrade, not a code change. |
| Cloud Wallet path unexercised live | a MultiBaas Cloud Wallet needs an Azure Key Vault (Premium for HSM keys). `cloudWalletSigner` is written and compile-checked; custody is `local` on every chain. |
| Contracts unverified on the explorers | needs an Etherscan API key. **Fixable before submission — do it.** |
| No reorg detection | a leg reported `confirmed` is not re-checked if its block reorgs out. Acceptable on testnets, not on an L1 carrying value. |
| Equity venue adapter is a mock | NVDAon's route is the issuer's gated mint/redeem window, not an AMM a fork can trade against. |
| MultiBaas keys are Administrators-scope | Internal Users is the production posture; an Administrators key can rewrite the audit record. |
| The three deployed LiquidityDesks predate the `add` gate | they carry the ungated bytecode and need a redeploy; `liquidity-demo.ts` and the dashboard's **Add to the pool** button also still lack the `setOperator` step a gated desk requires. |
| `treasury/` is deployed on no chain | `YieldRouter` and `EquityDesk` live only in the mainnet-fork suite. |
| Every token and pool in the demo is ours | `contracts/src/mocks/MockUSDC.sol` has an open public mint and displays as "USDC" because the symbol is read on chain; the pools are 1:1 mock/mock pairs this repo seeded against Uniswap's real `PoolManager`. |
| The Aave figures move every run | `TreasuryFork.t.sol:42` forks at HEAD with no pinned block and asserts `out > 0`, so quoting 10 032.65 USDC or 3.976% as a measurement would be quoting one run's console output. |

---

## Before you hit submit

- [x] Write `FEEDBACK.md` (Uniswap **requires** it) — done
- [ ] Submit the Uniswap Developer Feedback Form with a link to it
- [ ] Record and upload the demo video
- [ ] Paste the live URL; click through it once from a logged-out browser
- [ ] Verify contracts on Etherscan / Basescan / Optimistic Etherscan
- [ ] Add team intro (names, handles, roles)
- [ ] Confirm no key in the repo — `.env` is gitignored and was never committed; re-check before the deadline
- [ ] Clean, legible git history
