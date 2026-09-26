# Feedback

What this build hit that the docs do not say. Everything here comes from something we actually ran
into while integrating, not from a wishlist.

## Uniswap

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

## MultiBaas (Curvegrid)

| Friction | Cost |
|---|---|
| One deployment serves one chain, and the free tier allows two | A cross-chain dashboard is a natural MultiBaas use case, but the unit of provisioning works against it. `Treasury` is therefore a `Map<chainId, MultiBaas>` and every screen has to name which chains are **uncovered** — a chain absent from the ledger because nothing indexes it looks exactly like a chain with no outstanding authority. Those are very different facts. |
| Omitting `startingBlock` silently disables indexing | The link call succeeds, the contract appears, no events ever arrive. |
| No documented encoding for struct or `bytes32[]` method arguments | Forces every CrossPermit write through raw signed submit. |
| `eventName` filtering is not exact | Cost us a phantom allowance row dated 1970 before we checked arity. |
| `event.emitted` has no per-contract filter | Server-side filtering for every subscriber. |
| The supported-networks table renders client-side | Answering "is this chain supported?" programmatically means reading a Docusaurus chunk. A JSON endpoint would help any tool that checks before provisioning. |
