# CrossPermit — operations runbook

For whoever is holding the pager. Written so the first thing you read tells you whether user funds
are at risk, because that is the only question that changes what you do next.

## The one thing to know first

**A relayer outage cannot lose user funds and cannot strand authority.** The relayer pays gas and
nothing else. Every permit it would have submitted can be submitted by the client itself, unchanged,
with the same signature. If the relayer is down, the correct response is to say so and fix it at a
normal pace — not to page anyone at 3am.

What *is* urgent: a leaked key, an allowance nobody can revoke, or a control plane whose record
disagrees with the chain.

---

## Severity

| Sev | Looks like | Response |
|---|---|---|
| **1** | Owner key compromised; a spender is draining allowances | Immediate cross-chain `LOCK`. See *Kill switch*. |
| **1** | CrossPermit address differs between chains after a deploy | Stop all signing. Nothing is portable. See *Address divergence*. |
| **2** | Relayer signing key leaked | Rotate. Blast radius is the relayer's gas only. |
| **2** | MultiBaas key leaked | Revoke in the deployment UI. The chains remain the source of truth. |
| **3** | Relayer down or wedged | Clients fall back to self-submission. Fix in hours. |
| **3** | Legs stranded in `submitting` | See *Stranded legs*. Never blind-retry. |
| **3** | A permit reverts with `InvalidTimestamp` on one chain only | The signed ordering timestamp is ahead of that chain's head block. See *Timestamp drift*. |
| **4** | Audit trail incomplete on a chain | Expected where no MultiBaas deployment exists. Confirm it is that, not an outage. |

---

## Kill switch — revoke a spender everywhere, one signature

The fastest revocation is a cross-chain `LOCK`. It sets the allowance to zero and marks it locked, so
no later grant can raise it until an explicitly newer `UNLOCK` arrives.

**A `LOCK` is per `(owner, token, spender)`, and a web mandate grants two spenders** — the Universal
Router and that chain's `LiquidityDesk`. Locking only the router leaves a live allowance the UI does
not report. `revokeEntries()` in `packages/sdk/src/crosspermit.ts` builds the bundle covering every
spender on every chain, which is what the `lock` stage below uses, so one signature retires the lot.
There is no revoke button in the dashboard; this is the mechanism.

```bash
set -a && . ./.env && set +a
bun run packages/sdk/scripts/lifecycle.ts --only lock
```

Then **verify the spend actually fails**, rather than trusting the flag:

```bash
cast call <ROUTER> "execute(bytes,bytes[],uint256)" ... --rpc-url $RPC_BASE_SEPOLIA
# must revert
```

The lifecycle's `lock` stage does exactly this check on all three chains. A lock that does not stop a
spend is decoration.

To restore, `--only unlock` — note the unlock must carry a timestamp strictly newer than the lock, or
the contract ignores it. The lifecycle's monotonic stage clock handles this; a hand-rolled call must
not.

### Withdrawing a client link

```bash
curl -s -X POST -H "Authorization: Bearer $RELAYER_API_KEY" \
  localhost:8787/v1/clients/<token>/revoke | jq
```

This stops the link being used. **It does not revoke an allowance the client already signed** — for
that, lock the spender across chains as above. The endpoint says so in its own response because the
two are easy to confuse and only one of them closes exposure.

### Retracting something signed but not yet submitted

```bash
bun run packages/sdk/scripts/lifecycle.ts --only cancel
```

One signature burns the salt on every chain. This is a race against submission: a relayer that
already broadcast wins. Lock as well if the authority may already be live.

---

## Address divergence (sev 1)

Symptom: `DOMAIN_SEPARATOR()` differs between chains, or CrossPermit has code at different addresses.

```bash
for rpc in $RPC_ETH_SEPOLIA $RPC_BASE_SEPOLIA $RPC_OP_SEPOLIA; do
  cast call 0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B 'DOMAIN_SEPARATOR()(bytes32)' --rpc-url $rpc
done
```

All three must be byte-identical. If they are not, **stop signing immediately**: signatures are no
longer portable, and a signature intended for three chains may only bind on one.

Cause is almost always a dependency bump changing init code. Recover by re-deriving the address from
the pinned toolchain:

```bash
INIT=$(jq -r '.bytecode.object' contracts/out/CrossPermit.sol/CrossPermit.json)
H=$(cast keccak "$(cast concat-hex 0xff 0xce0042B868300000d44A59004Da54A005ffdcf9f $SALT "$(cast keccak "$INIT")")")
cast to-check-sum-address "0x${H: -40}"
```

If that does not equal the live address, the working tree is not the tree that produced it.

---

## Stranded legs

A leg in `submitting` may have a transaction in the mempool whose hash this process never saw.

**Do not blind-retry.** Resubmitting is how one signed allowance becomes two on chain. The relayer
reports stranded legs at boot and deliberately does not act on them.

Resolve by looking, not guessing:

```bash
curl -s localhost:8787/v1/intents/<intentId> | jq
cast nonce <RELAYER_SIGNER> --rpc-url <RPC>          # did the nonce advance?
```

- Nonce advanced and the allowance is present → the leg landed. Nothing to do.
- Nonce did not advance and the intent's deadline has passed → dead. Have the client sign a fresh
  intent; the old salt can be burned for tidiness.
- Nonce did not advance and the deadline is live → resubmit that one leg from the client.

### A stuck nonce blocking the queue

With MultiBaas TXM configured:

```bash
curl -s -H "Authorization: Bearer $MULTIBAAS_API_KEY" \
  "$MULTIBAAS_URL/api/v0/chains/ethereum/txm/<address>" | jq
# then speed up or cancel the blocking nonce
curl -s -X POST -H "Authorization: Bearer $MULTIBAAS_API_KEY" -H 'content-type: application/json' \
  -d '{"gasPrice":"<higher>"}' \
  "$MULTIBAAS_URL/api/v0/chains/ethereum/txm/<address>/tx/<nonce>/speedup"
```

Cancelling writes a no-op at that nonce, which unblocks everything queued behind it.

---

## Timestamp drift

Symptom: one chain — almost always the slowest — reverts with `InvalidTimestamp` while the others
confirm from the same signature.

CrossPermit refuses a permit whose `timestamp` is ahead of `block.timestamp`. A chain's head block
is routinely several seconds old (Ethereum builds one every twelve seconds), so a client signing
with wall clock fails there and nowhere else.

```bash
for rpc in $RPC_ETH_SEPOLIA $RPC_BASE_SEPOLIA $RPC_OP_SEPOLIA; do
  echo "$(cast block latest -f timestamp --rpc-url $rpc) vs $(date +%s)"
done
```

The SDK signs at `now - TIMESTAMP_LAG` (90s) for this reason. If a chain is further behind than
that — a stalled sequencer, a node many blocks stale — raise the constant rather than retrying: a
retry re-signs with the same relationship to wall clock and fails again.

## Key rotation

### Relayer signing key

1. Fund the new key on every served chain.
2. Drain or let settle any in-flight legs: `curl -s localhost:8787/v1/intents | jq`.
3. Update `RELAYER_PRIVATE_KEY`, restart.
4. Confirm the boot banner shows the new signer on every chain.

No user action is required — users never authorised the relayer's key, only the *spender* named in
their bundles.

### MultiBaas API key

Revoke at `<MULTIBAAS_URL>/apikeys`, create a replacement, update `MULTIBAAS_API_KEY`, restart.
Prefer the **Internal Users** group over Administrators: an Administrators key can rewrite indexing
configuration and therefore the audit record.

### Owner key (sev 1)

The relayer cannot help here. Lock every spender across every chain (above), then move the funds.
A lock is not a substitute for moving funds when the key itself is compromised — the attacker can
sign an unlock.

---

## Health checks

```bash
curl -s localhost:8787/healthz                     # process alive
curl -s localhost:8787/readyz   | jq               # chains configured
curl -s localhost:8787/v1/chains | jq              # signer and custody per chain
curl -s localhost:8787/v1/quota/<owner> | jq       # an owner's remaining rate and gas budget
```

The boot banner is the fastest full picture: it names the signer, the custody model, and — crucially
— which chains have **no** control-plane audit trail.

## Routine verification

```bash
script/test.sh                                              # the single offline gate
cd contracts && FORK=1 forge test --match-path 'test/*Fork*' -vv   # live-chain proofs
```

`script/test.sh` is what root `bun run test` and the CI `offline` job both call, so there is one
command to believe. It covers: typecheck of `packages/sdk`, `packages/multibaas`, `apps/web` and
`apps/relayer`; their unit suites; `forge build`; regeneration of the parity fixtures from the
working tree; `forge test`; and a branding grep. CI runs the fork proofs as two further jobs —
`fork` (Router + Liquidity, testnets) is **blocking**, `mainnet-fork` (Treasury) is
`continue-on-error` because it depends on a mainnet endpoint being reachable.

Run the fork suite after any dependency bump. It is the thing that catches Aave or Uniswap changing
an interface out from under the hand-written ones in `contracts/src/treasury/interfaces`.

## What to say publicly during an incident

State whether user funds are at risk — for a relayer outage the answer is no, and saying so plainly
is more useful than a status page that implies otherwise. Name the fallback: clients can submit every
leg themselves, with the same signature, and nothing needs re-signing.
