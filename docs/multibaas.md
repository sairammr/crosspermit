# MultiBaas, feature by feature, and what CrossPermit does with each

Every capability MultiBaas ships, what it is actually for, and a verdict: **in use**, **adopt**,
or **skip** — with the reason. A verdict of *skip* is not a criticism of the feature; it means the
feature solves a problem this product does not have, and saying so is cheaper than half-wiring it.

Read against the docs at <https://docs.curvegrid.com/multibaas> as of September 2026. Where the
docs and the running deployment disagree, the note says which one we believe and why.

Legend — **in use**: wired and exercised by the relayer or the dashboard today.
**adopt**: worth building, named with the screen it serves. **skip**: deliberately not used.

---

## 1. Smart contract library — ABI upload, link, versions

Register an ABI (solc / Hardhat / Forge artifact, raw JSON, verified-source import from Etherscan
or Sourcify), then link that definition to one or more deployed addresses per chain.

| | |
|---|---|
| What it buys us | Decoded calls and, once linked with a starting block, **decoded events**. Without registration, `Permit` is calldata; with it, `Permit` is a row. |
| Verdict | **in use** — `Treasury.registerCrossPermit()` in `packages/multibaas/src/treasury.ts`. |

Two sharp edges we already pay for in code:

- `rawAbi` must be a JSON **string**, not an object. The parsed form returns *"unable to parse
  JSON"*, which reads like a malformed body rather than one bad field.
- `bin` is stored `NOT NULL` and must keep its `0x` prefix.
- Omitting `startingBlock` links the contract and silently indexes nothing. We pass it explicitly.

## 2. Address aliases

`crosspermit`, `desk`, `client-meridian` instead of a hex string — and the alias substitutes for
the address in every path.

| | |
|---|---|
| Use case here | The demo reads in English on a projector, and the client dashboard can name a client's owner address once instead of at every call site. |
| Verdict | **in use** for the contract label; **adopt** one alias per linked client owner, written at `POST /v1/clients/:token/link` time. |

## 3. Contract methods — read and write through the API

`POST /chains/{chain}/addresses/{addr}/contracts/{label}/methods/{method}` with
`signAndSubmit: false` for a read, `true` to sign with the configured signer and broadcast.

| | |
|---|---|
| Use case here | Reading `allowance(owner, token, spender)` without an RPC of our own. |
| Verdict | **skip for reads.** The dashboard reads allowances by plain `eth_call` through wagmi, deliberately — see `useAllowance` in `desk.tsx`: a failed read must be distinguishable from a zero allowance, and one more hop adds one more way to be told "no data". |
| | **skip for writes.** CrossPermit's `permit(...)` takes a tuple and a `bytes32[]` proof; the method encoder has no documented form for those. We submit raw signed transactions instead (§6). |

## 4. Event indexing and the event feed

`GET /events?contractLabel=&eventName=` over everything MultiBaas has decoded.

| | |
|---|---|
| Use case here | The allowance ledger, the client activity timeline, and the audit trail — "one signature, every record it produced" — all fold these rows. |
| Verdict | **in use** — `Treasury.allowanceLedger()`, and now `Treasury.activity()` behind `GET /v1/activity/:owner`. |

Caveats found the hard way, all of them encoded in `treasury.ts`:

- `limit` is capped at **50**. Paging is mandatory, not an optimisation: a silently truncated page
  reads as authority that was never granted.
- The `eventName` filter is **not exact**. Asking for `Permit` also returns `NonceInvalidated`.
  Decoded positionally, its salt lands in the token column and it becomes a zero allowance dated
  1970. We check the name *and* the input arity before trusting a row.
- There is no `eventSignature` parameter; passing one is rejected outright rather than ignored.

## 5. Event queries — saved and ad-hoc

A small DSL: `select` (event inputs or event metadata), multi-layer `filter`, aggregators, one
`groupBy` on the single non-aggregated field, `orderBy`. Savable by label and runnable by anyone
with the key, or posted ad-hoc.

| | |
|---|---|
| Use case here | Aggregates the fold in §4 cannot do cheaply: capacity consumed per client per chain, grant count per token, first-seen and last-seen per spender. Also one definition shared by the ledger and the dashboard rather than two reducers that drift. |
| Verdict | **in use** (`installAllowanceQuery`), **adopt** further for the client dashboard's per-token rollup. |

Ad-hoc `POST /queries` matters more than saved queries for a hackathon: it means the console works
against a **clean deployment** with no console setup step.

## 6. Raw signed transaction submit

`POST /chains/{chain}/submit` takes a transaction this process already signed.

| | |
|---|---|
| Use case here | The seam that keeps a local-key relayer and a Cloud Wallet relayer on one code path: sign wherever the key lives, submit through MultiBaas either way, so the transaction lands in the same audit trail regardless of custody. Also our escape hatch from the struct/array encoding gap in §3. |
| Verdict | **in use**. |

## 7. Cloud Wallets (Azure Key Vault, software or HSM keys)

EOAs whose private key lives in Azure Key Vault. Software-protected on every tier; HSM-protected
needs a Premium Key Vault. Configured with five Azure credentials; Curvegrid recommend a custom
minimal role over the built-in ones.

| | |
|---|---|
| Use case here | The relayer's gas key is the one long-lived secret in this system. In Key Vault it is never on the relayer host, and `signData` / `hsm/submit` keep the same call shape. |
| Verdict | **adopt, post-hackathon.** The relayer already abstracts its signer (`custody` is reported per chain by `GET /v1/chains`), so this is a config change, not a rewrite. Not on the demo path: an Azure subscription is a dependency a judge cannot reproduce. |
| Not | Custody of **client** assets. Clients sign in their own wallet; nothing in this product ever holds client keys. |

## 8. Transaction Manager (TXM)

Per-wallet transaction tracking with seven statuses (success, pending, failed, rejected, exceeded,
replaced, cancelled), automatic resubmission, manual speed-up and nonce-cancel, legacy and
EIP-1559 fee control.

| | |
|---|---|
| Use case here | A relayer fans one signed intent out to N chains. A stuck nonce blocks that chain's whole queue behind it, and "submitted" is not "landed". TXM is the difference. |
| Verdict | **adopt** — but note it tracks **Cloud Wallet** transactions, so it arrives with §7 and not before. Until then the relayer's own `stranded()` check is the poor relation: it reports legs stranded mid-submit and refuses to retry them blind, because resubmitting blind is how one signed allowance becomes two on chain. |

## 9. Webhooks

Two event types: `transaction.included` (Cloud Wallet transactions) and `event.emitted` (any
contract with event sync on). Delivered as a JSON array of `{id, event, data}`. Authenticated with
`X-MultiBaas-Signature` (HMAC-SHA256 over timestamp + body) and `X-MultiBaas-Timestamp`.

| | |
|---|---|
| Use case here | The client dashboard's live state without a polling loop. Three chains polled every 5s is ~1.5M calls a month against a 30k budget; the same information arrives free as it happens. |
| Verdict | **adopt** — `Treasury.watchCrossPermit()` exists and is unwired. Verification is already written and tested (`verifyWebhook`): verify **before** parsing, constant-time compare, timestamp window against replay. |
| Gap worth reporting | No per-contract or per-event subscription filter — every synced contract fires into the same endpoint, so filtering moves server-side. |

## 10. Safe{Wallet} accounts

Propose a transaction from a Safe through MultiBaas, without pasting an ABI into the Safe UI;
co-signers approve at app.safe.global.

| | |
|---|---|
| Use case here | Real. A treasury that delegates a trading mandate is exactly the org that holds its assets in a 3-of-5 Safe, and CrossPermit's owner can be a Safe — the signature is EIP-712, and `LOCK` is the one call a risk committee will want behind a multisig. |
| Verdict | **adopt for the pitch, skip for the build.** A Safe owner signs EIP-1271, not EIP-712 ECDSA, and CrossPermit's verification path would have to accept contract signatures. That is a contract change, not a dashboard change, so it belongs in the roadmap section and not in a demo that would have to fake it. |

## 11. Users, groups, RBAC, API keys

Five groups (Administrators, View-Only Administrators, Internal Users, External Clients, DApp
Users) over nine roles.

| | |
|---|---|
| Use case here | The product's own shape is a desk, its clients, and a risk officer who may read but not act. MultiBaas already models that: **DApp User** for the browser, **View-Only Administrator** for an auditor, full admin for provisioning only. |
| Verdict | **in use conceptually** (the relayer's own `RELAYER_API_KEYS` mirrors it), **adopt** for the deployment's own keys. |
| Caveat | The docs do not state whether Operator scope is per-contract or per-address. Until that is confirmed, a DApp User key in the browser is treated as read-and-compose only, never as an authority boundary. |

## 12. Browser-direct access — CORS + DApp User key

Add the dev and production origins under CORS, provision a key restricted to DApp User, embed it.
The docs are explicit that this is safe **only** for that group.

| | |
|---|---|
| Use case here | No backend to write for read screens, and none to explain on stage. |
| Verdict | **adopt selectively.** Ledger and activity stay behind the relayer, because the relayer already folds three chains into one answer and holds the client table. A direct browser read is the fallback when the relayer is down — a treasury screen that can still show chain truth when our own service is unreachable is worth more than one that goes blank. |

## 13. Transaction explorer

A UI over transactions and decoded events on the deployment.

| | |
|---|---|
| Verdict | **skip in-product, use in development.** It is how you confirm indexing is actually running before blaming your own reducer. It is not something to re-render inside our console. |

## 14. Plugins — Hardhat plugin, Forge library

Upload and link contracts to MultiBaas as part of the deploy workflow.

| | |
|---|---|
| Use case here | This repo deploys with Forge. The Forge library would make registration part of `script/`, replacing the idempotent `registerCrossPermit()` dance. |
| Verdict | **adopt, low priority.** Our registration path is already idempotent and handles the 409, and it also runs for contracts that were deployed before MultiBaas existed in the project. |

## 15. SDKs (TypeScript, Python, Go)

| | |
|---|---|
| Verdict | **skip, deliberately.** The surface we need is about fifteen endpoints; the generated TS client drags in axios plus thirty-odd transitive packages whose signatures shift between releases. `fetch` is already here. `packages/multibaas/src/client.ts` is the whole wrapper and it is smaller than the SDK's type declarations. |

## 16. Signer selector

Choose which signer — web3 wallet, Cloud Wallet, Safe — signs a given interaction, in the UI.

| | |
|---|---|
| Verdict | **skip.** It is a console-UI affordance. Our equivalent is a relayer config key, and the answer is reported to the browser by `GET /v1/chains` as `signer` + `custody`. |

---

## What we hit that the docs do not say

`FEEDBACK.md` at the repo root carries this table verbatim, alongside the Uniswap items. It is
restated here because it shapes the architecture above.

| Friction | Cost |
|---|---|
| One deployment serves one chain, and the free tier allows two | A cross-chain dashboard is a natural MultiBaas use case, but the unit of provisioning works against it. `Treasury` is therefore a `Map<chainId, MultiBaas>` and every screen has to name which chains are **uncovered** — a chain absent from the ledger because nothing indexes it looks exactly like a chain with no outstanding authority. Those are very different facts. |
| Omitting `startingBlock` silently disables indexing | The link call succeeds, the contract appears, no events ever arrive. |
| No documented encoding for struct or `bytes32[]` method arguments | Forces every CrossPermit write through raw signed submit. |
| `eventName` filtering is not exact | Cost us a phantom allowance row dated 1970 before we checked arity. |
| `event.emitted` has no per-contract filter | Server-side filtering for every subscriber. |
| The supported-networks table renders client-side | Answering "is this chain supported?" programmatically means reading a Docusaurus chunk. A JSON endpoint would help any tool that checks before provisioning. |

## Coverage today

| Chain | MultiBaas | Consequence |
|---|---|---|
| Ethereum Sepolia | yes | ledger, activity, audit trail |
| Base Sepolia | yes | ledger, activity, audit trail |
| Optimism Sepolia | no deployment | local signer; allowances read from chain storage, **no control-plane audit trail** — said on screen, not hidden |

## The shortlist, in build order

1. **Webhooks** (§9) — live client dashboard, and it is the only thing that makes the API budget work.
2. **Per-client address aliases** (§2) — one line at link time, every later call reads in English.
3. **Ad-hoc event queries for the per-token rollup** (§5) — capacity consumed per token per chain, aggregated server-side instead of folded in the browser.
4. **Cloud Wallets + TXM** (§7, §8) — the relayer's gas key leaves the host, and "submitted" becomes "landed".
5. **Safe owners** (§10) — needs EIP-1271 in the contract first. Roadmap, stated as roadmap.
