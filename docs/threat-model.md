# CrossPermit — threat model

What this system is trying to stop, what it explicitly does not stop, and what is still unproven.
Written to be argued with; a threat model nobody disagrees with is usually one nobody read.

## Assets

| Asset | Held where | Loss looks like |
|---|---|---|
| The owner's tokens | the owner's own EOA / smart account | moved to an address the owner did not authorise |
| The owner's *authority* | CrossPermit allowance storage, on N chains | a spender holds an allowance the owner did not sign, or cannot revoke one they did |
| The relayer's gas balance | the relayer's signing key | drained by work the relayer gained nothing from |
| The audit record | MultiBaas, plus the chains themselves | an action that happened with no record, or a record of one that did not |

## Trust boundaries

1. **User → page.** The page builds the bundles and the root. A malicious page can ask for a
   signature over anything.
2. **Page → RPC.** RPCs are untrusted. This is why the leaf is computed locally.
3. **Client → relayer.** The relayer is untrusted with authority and trusted only with gas.
4. **Relayer → chain.** Standard: reorgs, mempool visibility, fee markets.
5. **Anything → MultiBaas.** Control-plane responses are data, never instructions.

---

## Threats and what answers them

### T1 — Hostile RPC chooses what the user signs

**The attack.** The client asks an RPC for `hashChainPermits`. The RPC answers with the hash of the
*attacker's* bundle. The client folds it into a root, the wallet shows an opaque `merkleRoot`, and
the user signs away allowances they never saw.

**Answer.** The leaf is computed locally, always (`leafOf` in `packages/sdk`). `leafOfChecked` may
additionally ask the chain, but only to assert equality — a mismatch is a refusal, never an adoption.
`LeafParity.t.sol` pins the local implementation against the deployed contract over six bundle
shapes including empty, maxima and a hashed non-address token key.

**Residual.** A compromised *page* still wins: it does not need the RPC's help to build a hostile
bundle. That is why the dashboard renders every bundle in plain language before the wallet opens.
A user who signs without reading is outside what any of this can defend.

### T2 — Relayer redirects or inflates a permission

**The attack.** The relayer alters a bundle before submitting: a different recipient, a larger
amount, an extra spender.

**Answer.** Structurally impossible. Every field lives inside the bundle the owner signed, and the
merkle proof binds each leg to the one signed root; the contract recomputes the leaf from the
submitted bundle and folds the proof into the struct hash it recovers the signer over. Any edit
produces a root the owner never signed, so recovery yields a different address and the permit
reverts.

**Residual.** The relayer can **censor** (not submit) and **reorder** (submit chain A before B).
Censorship is mitigated by the client being able to submit any leg itself, unchanged — the fallback
path in `lifecycle.ts` is not a demo convenience, it is the property that keeps the relayer
non-custodial. Ordering matters only for intents whose legs interact, which cross-chain permits do
not.

### T3 — Relayer gas drain

**The attack.** A caller submits a stream of perfectly valid, cheap intents. Every one lands. The
relayer pays for all of them and receives nothing.

**Answer.** `apps/relayer/src/admission.ts`: an API key decides who may ask, a per-owner rate limit
decides how often, and a per-owner gas budget decides how much. Limits key on the intent **owner**,
the only identity a signature proves — a key can be shared and an IP rotated, but nobody can submit
an intent they did not sign. Gas is charged from the receipt, and reverted transactions are charged
too, or failures become a free grinding primitive.

**Residual.** An attacker with many funded EOAs gets `maxIntentsPerWindow` from each. Mitigated by
requiring an API key in production; the relayer logs loudly when it is running open. Charging gas
after the fact means one intent can overshoot a budget — never more than one.

### T4 — Compromised relayer key

**The attack.** The relayer's signing key leaks.

**Answer.** The blast radius is the relayer's own gas balance. It holds no user authority, and a
permit it submits still only sets allowances the owner signed. Rotation is a config change.

**Residual.** Today the relayer's key and the demo owner's key are the **same key**, which collapses
this separation entirely. That is a deployment defect, recorded in `PLAN.md`, not a design one:
`RELAYER_PRIVATE_KEY` is already a separate setting.

### T5 — Compromised MultiBaas credential

**The attack.** The API key leaks. It is Administrators-scope.

**Answer.** MultiBaas holds no authority over user funds. Its Cloud Wallet, where used, holds only
relayer gas. Keys are revocable from the deployment's own UI.

**Residual.** An Administrators key can rewrite indexing config and therefore **the audit record** —
it cannot forge a chain, but it can make the control plane's story disagree with the chain's. The
mitigation is scope: Internal Users is the production posture, and the chains remain the source of
truth. Until that narrowing happens, the audit trail is trusted only as far as that key is.

### T6 — Replay

**Across chains.** A bundle carries its own `chainId`; the contract rejects one addressed elsewhere.
A proof from another chain folds to a different root. Both covered in `CrossChainFlow.t.sol`.

**On the same chain.** The salt is burned on use. A second submission reverts with
`NonceAlreadyUsed`.

**Of an intent to the relayer.** Idempotency keys on `(owner, salt, root)` — the signed fields only.
The signature is deliberately excluded because ECDSA is malleable: two byte-different signatures can
authorise the identical permission, and keying on the signature would let one authorisation become
two fan-outs. The insert is transactional, so two concurrent POSTs cannot both win.

### T7 — Signed permission that must be retracted

**The attack.** An institution signs a multichain intent, then a counterparty is downgraded or a
spender is compromised, before anything is submitted.

**Answer.** One signature burns the salt on every chain (`cancel.ts`, `invalidateNonces`). The
lifecycle proves the retracted permit can then never be redeemed. For authority already applied,
a `LOCK` disables a spender across chains, proved by a pull that reverts rather than by a flag read.

**Residual.** Cancellation is a race against submission. A relayer that already broadcast wins.
There is no way around this: it is the same race as revoking an ERC-20 approval.

### T8 — Reorg during fan-out

**The attack.** A leg confirms, then its block is reorged out.

**Answer.** Partial. The relayer records a receipt and reports `confirmed`; it does not currently
watch for the transaction disappearing. On the testnets in use this is rare; on an L1 with real
value it is not acceptable as-is.

**Residual — open.** Confirmation depth is not configurable and re-orgs are not detected. Tracked in
`PLAN.md`.

### T9 — Stale or manipulated equity price

**The attack.** The desk fills against a stale or manipulated oracle.

**Answer.** `EquityDesk` bounds every fill three ways: the caller's `minOut`, an oracle staleness
window (a price from the *future* is rejected too — a bad feed either way), and a maximum deviation
of the achieved price from the reference. Reject rather than fill wide.

**Residual.** A price within the band but wrong still fills. Oracle choice is the operator's, and the
desk is only as good as it.

### T10 — Pooled yield accounting

**The attack.** A bug in `YieldRouter`'s share maths lets one depositor withdraw another's principal.

**Answer.** Shares are priced before new assets land (no self-dilution) and burned before the
external withdraw call (no re-entry on stale state). Rounding is toward the pool.

**Residual — real.** This is a pooled position, so a share-maths bug is a *shared* loss. It is a
deliberate trade-off: per-depositor Aave positions would cost a second signature each, which is the
thing CrossPermit exists to remove. Fuzz coverage of the share maths is listed as open work.

### T11 — Dependency drift changes the address

**The attack.** A submodule bump changes init code, so a redeploy lands at a different address and
old signatures stop verifying — or worse, a *new* deployment at a *new* address silently coexists.

**Answer.** Every dependency is pinned to an exact commit. CI rebuilds from those pins. The deploy
script predicts the address from init code plus salt and refuses to guess when it cannot read chain
state — a rate-limited RPC returning empty must never read as "already deployed".

---

## Explicitly not defended

- **A user who signs without reading.** The payload is shown first; that is the limit of what the
  protocol can do.
- **A malicious dApp front-end.** Out of scope for the contracts.
- **Token-level risk.** A malicious or upgradeable ERC-20 can do what it likes to its own balances.
- **Aave and Uniswap themselves.** Integration risk is inherited, not mitigated.
- **Issuer risk on tokenized equities.** The custodian holding the underlying is a trust assumption
  the chain cannot check.

## Open, and honest about it

| Gap | Impact | Where |
|---|---|---|
| Relayer and owner share one key | collapses T4's separation | deployment config |
| Reorg detection | a `confirmed` leg could un-confirm | `apps/relayer` |
| MultiBaas key is Administrators-scope | T5 residual is wider than it needs to be | control plane |
| MultiBaas covers 1 of 3 chains | two chains have no control-plane audit trail | free tier, one deployment per network |
| Cloud Wallet path unexercised live | custody alternative is compile-checked only | no HSM wallet created yet |
| No fuzz on share maths or merkle builder | T10's residual is larger than it should be | `contracts/test` |
| Contracts unverified on explorers | a reader cannot check the source against the address | deployment |
