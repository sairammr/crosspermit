# CrossPermit — voice-over script

For the `/pitch` deck, eleven slides. Written to be **spoken, not read**: short sentences, one idea
per breath, contractions where a person would use them. Total ≈ 3:30 at a calm 150 words per minute,
which leaves headroom under ETHGlobal's 4-minute cap.

**Delivery notes.** Slow down on numbers — they're the proof, and a rushed number sounds like a
claim. Pause a full beat at every `⏸`. Don't read anything off the slide that the slide already
says; the slide is the evidence, you're the argument.

---

## 01 · Hook — `0:00–0:15`

> Permit2 solved approvals. Instead of an unbounded `approve` for every token and every app, you
> sign a message — with a cap, an expiry, and a spender.
>
> But it's still one signature per chain. ⏸ So a desk running a client's money across four chains
> asks that client to sign four times.

---

## 02 · Permit2 — `0:15–0:40`

> Here's the strange part. Permit2 is at the *same address* on every chain. Same code. Same intent.
>
> And the signature still can't leave one. Because its EIP-712 domain is built from
> `block.chainid`, the digest is different everywhere — so a signature that's valid on Base is just
> invalid on Arbitrum.
>
> On the left is what that actually looks like for a user. Four wallet prompts. Four times reading
> the fine print. Four audit lines. And later, four revocations. ⏸
>
> On the right is the same permission, as one prompt.
>
> So tokens bridge. Messages bridge. **Authority doesn't.** There's no object a client can sign
> once that means: *this desk may trade this much of mine, until Friday, wherever I hold it.*

---

## 03 · The cost — `0:40–0:55`

> And fragmented permission fragments the book.
>
> Because authority stops at the chain boundary, capital has to sit where the authority already is
> — so every chain carries its own buffer, sized for its own worst day.
>
> Revocation becomes a race. A counterparty goes bad, and closing out is one transaction per chain,
> in four separate gas markets, while the position gets worse. The slowest chain sets the loss.
>
> And bridges don't fix this. They move tokens, not permission. Moving the collateral to the
> authority adds custody, latency, and a new trust assumption. ⏸ It's much cheaper to move the
> authority to the collateral.

---

## 04 · Institutions — `0:55–1:10`

> Retail signs for itself. One wallet, one chain at a time — four prompts is annoying, not fatal.
>
> A fund is different. It manages *other people's* money, under an agreement that was never
> per-chain. And it's caught between two rules that point in opposite directions.
>
> It can't take custody — moving client assets into a desk wallet is a custody event, with
> licensing and insurance attached to it.
>
> And it can't ask for a signature per chain per week. A desk that needs its clients at a wallet
> prompt to rebalance isn't a desk. ⏸
>
> A bounded, revocable allowance over assets that never move is the only shape that satisfies both.
> It just has to reach every chain.

---

## 05 · CrossPermit — `1:10–1:25`

> That's CrossPermit. It's Permit2's interface with the chain constraint removed.
>
> Same allowance shape — cap, expiry, spender. Same `transferFrom` selectors, so Uniswap's own
> Universal Router spends it completely unmodified.
>
> Follow the top row: the client signs once in their browser. The relayer takes one HTTP request and
> fans it out to three chains. It pays gas and nothing else — it can't change a recipient, a
> spender, or an amount.
>
> Along the bottom is what's actually being signed. The SDK builds one permit bundle per chain,
> hashes each one into a leaf, and folds the leaves into a single merkle root. ⏸ **The root is the
> signature.** The chain id lives inside each leaf, never in the signature itself — which is exactly
> why the signature can travel.

---

## 06 · One address — `1:25–1:35`

> Three moves make that safe, and all three are load-bearing.
>
> Pin the domain: `chainId = 1`, everywhere. Prove the address: ERC-2470, same init code, same salt,
> same address on every chain — which matters because `verifyingContract` is still in that domain.
> Then merkle the rest.
>
> Here's my favourite evidence, and it was an accident. We added Optimism Sepolia *after* the other
> two were already live. Same salt, same bytecode — it landed at the same address, and its domain
> separator came back byte-identical, with zero coordination. ⏸ That's the invariant surviving
> contact with a chain it had never touched.

---

## 07 · Merkle root — `1:35–1:45`

> One root, one proof per chain.
>
> Each chain gets handed only its own bundle and its own proof. It rebuilds the root, recovers the
> signer, and applies it. A wrong bundle gives a wrong leaf, a wrong root, and a signature that
> recovers to somebody else — so there's nothing extra to check.
>
> And the leaves are computed in the browser. Always. If a leaf came back from an RPC, a hostile
> endpoint could hand you the hash of a bundle you never saw — and you'd sign it, validly.

---

## 08 · Spending it — `1:45–1:55`

> Once the writ is armed, it does real work.
>
> It trades: a real Uniswap v4 swap, settled through the router's actual payment path, against
> Uniswap's live PoolManager on three testnets.
>
> It invests: the desk opens a v4 liquidity position paid straight out of the client's allowance,
> keyed by the client's own address — so v4 core holds that position in *their* name.
>
> And note the asymmetry: anyone can *add*, because it can only move tokens from someone who signed
> a writ naming this contract, and only into the pool. Only the client can remove. ⏸ The desk has
> nothing to sweep.

---

## 09 · Demo — `1:55–2:40`

> Let me show you the whole loop.
>
> I'm the desk. I add a client, and it gives me one link. I send it to them.
>
> This is what they see. Every chain, every spender, every cap — in plain language, computed on this
> page, *before* a wallet ever opens. Including what's already outstanding, because a grant with an
> expiry is an increase, not a replacement.
>
> They sign. Once. Sixty-five bytes. ⏸
>
> And it lands on all three chains. Same address, same digest, three proofs, three explorer links.
>
> Now I allocate — and Uniswap's router settles a real v4 swap out of that allowance. No second
> signature. The desk never touched their tokens.
>
> Then they change their mind. One signature locks the desk on every chain — and the same spend that
> worked ten seconds ago now reverts. ⏸ Revocation is as portable as the grant.

---

## 10 · Proof — `2:40–3:00`

> None of this is a mock.
>
> CrossPermit is live at one address on three testnets. Every v4 swap returns 996,999 out for a
> million in — that's the pool's 0.3% fee — and the allowance ends at zero, with no plain ERC20
> approval on the router. So the money can only have come through CrossPermit.
>
> Ten thousand USDC through an allowance into Aave v4's real core hub comes back as ten thousand and
> thirty-two, thirty days on. Ondo's real tokenized NVIDIA reads live in the same suite.
>
> And every grant, every lock, every burned salt is a decoded row in MultiBaas — so one signature
> expands into every record it produced, which is the screen that sells this to a risk committee.

---

## 11 · Ask — `3:00–3:20`

> One signature. Every chain.
>
> And it doesn't get worse with scale — proof length grows with the log of the chain count, and no
> leg ever reads another chain's state. There's no bridge, no message, nothing to wait on.
>
> We want three things. A mainnet pilot: one desk, one client, one chain pair, a capped mandate. An
> audit of the core — it's four contracts and one signed type. And indexer coverage everywhere a
> partner desk trades, because a chain with no audit trail can't carry a mandate. ⏸
>
> Everything's open source, and it's all testnet. Thank you.

---

## If you're cut to 2 minutes

Drop 03, 04 and 07 entirely, and shorten 10 to the swap number alone. The spine that still works:
**01 → 02 → 05 → 09 → 10 → 11** — hook, the chain-bound signature, the architecture, the live loop,
one number, the ask.

## Words to hit hard

*one signature per chain* · *authority doesn't travel* · *the root is the signature* · *byte-identical,
with zero coordination* · *the desk never touched their tokens* · *revocation is as portable as the grant*
