"use client";

/**
 * The client's side of an invitation: pick what the desk may touch, sign once.
 *
 * The desk only opened this link. Everything the grant is made of — which tokens on which chains,
 * how much of each, how long it lives — is chosen here by the person who owns the assets, and is
 * put on chain by their own wallet. Every figure on the sheet is read by this page from the chains
 * themselves before the wallet opens, because a signer who sees only an opaque merkle root in
 * their wallet is trusting this page to have told them the truth about what it means.
 */

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { type Address, type Hex, formatUnits, parseAbi, parseUnits } from "viem";
import { useAccount, useDisconnect, useReadContracts, useSignTypedData, useSwitchChain } from "wagmi";

import { SIGNING_CHAIN_ID, approveEntry, crossPermitAbi, prepareIntent, toWire } from "@crosspermit/sdk";
import { type ClientMandate, linkMandate, useMandate } from "../../../src/clients";
import { CHAINS, CROSS_PERMIT, type ChainInfo, chainById } from "../../../src/config";
import { HorseMatrix } from "../../../src/dithergraph";
import { postIntent, useIntentStream } from "../../../src/relayer";
import { onSigningChain, openAppKit } from "../../../src/wagmi";
import "../mandate.css";

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** The expiries offered. A free-text hour field invites a typo that is only visible on chain. */
const EXPIRIES = [
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
  { hours: 2160, label: "90 days" },
  { hours: 8760, label: "1 year" },
];

const READS_PER_HOLDING = 5;

/**
 * Token marks, by the symbol the token's own contract reports.
 *
 * Keyed on the symbol rather than the address because the same asset has a different address on
 * every chain, and these testnets run mock deployments of it. A symbol with no mark here falls
 * back to its letters — inventing a logo for a token this app does not recognise would be the one
 * way a wrong token could look right.
 */
const TOKEN_LOGOS: Record<string, string> = {
  USDC: "/logos/usdc.png",
};

const short = (a: string, n = 6) => (a.length > 2 * n ? `${a.slice(0, n)}…${a.slice(-4)}` : a);
const group = (n: string) => {
  const [w, f] = n.split(".");
  return f ? `${Number(w).toLocaleString("en-US")}.${f}` : Number(w).toLocaleString("en-US");
};

/** One token on one chain: the unit the client selects, and the unit a permit is written in. */
type Holding = { key: string; chain: ChainInfo; token: Address };

const HOLDINGS: Holding[] = CHAINS.flatMap((chain) =>
  chain.tokens.map((token) => ({ key: `${chain.id}:${token.toLowerCase()}`, chain, token })),
);

// ---------- page ----------

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === "string" ? params.token : undefined;
  const { state, reload } = useMandate(token);

  if (state.kind === "loading") {
    return (
      <Sheet title="Mandate" label="Reading the link">
        <Note title="Loading…" body="Fetching what you are being asked to sign." />
      </Sheet>
    );
  }
  if (state.kind === "missing") {
    return (
      <Sheet title="Mandate" label="This link is not valid">
        <Note
          title="Nothing to sign."
          body="The link may have been withdrawn by the desk, or mistyped. Nothing was granted. Ask whoever sent it for a new one."
        />
      </Sheet>
    );
  }
  if (state.kind === "offline") {
    return (
      <Sheet title="Mandate" label="Cannot reach the desk" action={{ label: "Retry", onClick: reload }}>
        <Note
          title="The relayer did not answer."
          body="Do not sign anything on a page that could not load what it is asking you to sign. Retry, or come back later."
        />
      </Sheet>
    );
  }
  return <Grant client={state.client} token={token!} onLinked={reload} />;
}

// ---------- the grant ----------

function Grant({ client, token, onLinked }: { client: ClientMandate; token: string; onLinked: () => void }) {
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState("");
  const [hours, setHours] = useState(client.ttlHours || 720);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<Hex | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const { status } = useIntentStream(intentId);

  // Five reads per holding, batched per chain: balance, the allowance already open to the router,
  // symbol, name, decimals. `allowance` matters because a permit entry with an expiry is an
  // INCREASE — the amount alone understates what the client ends up granting whenever anything is
  // already outstanding. Name and symbol are read rather than written into the config, because a
  // label typed into this app is the one thing on the screen the chain cannot contradict.
  const reads = useReadContracts({
    contracts: HOLDINGS.flatMap((h) => [
      { address: h.token, abi: tokenAbi, functionName: "balanceOf", args: [address!], chainId: h.chain.id },
      { address: CROSS_PERMIT, abi: crossPermitAbi, functionName: "allowance", args: [address!, h.token, h.chain.router], chainId: h.chain.id },
      { address: h.token, abi: tokenAbi, functionName: "symbol", chainId: h.chain.id },
      { address: h.token, abi: tokenAbi, functionName: "name", chainId: h.chain.id },
      { address: h.token, abi: tokenAbi, functionName: "decimals", chainId: h.chain.id },
    ]),
    query: { enabled: Boolean(address) },
  });

  const info = (i: number) => {
    const at = (k: number): unknown => {
      const r = reads.data?.[i * READS_PER_HOLDING + k];
      return r?.status === "success" ? r.result : undefined;
    };
    const decimals = typeof at(4) === "number" ? (at(4) as number) : 6;
    const fmt = (v: unknown) => (typeof v === "bigint" ? formatUnits(v, decimals) : null);
    return {
      decimals,
      balance: fmt(at(0)),
      open: fmt((at(1) as readonly [bigint, number, number] | undefined)?.[0]),
      symbol: (at(2) as string | undefined) ?? null,
      name: (at(3) as string | undefined) ?? null,
    };
  };

  const chosen = HOLDINGS.map((h, i) => ({ ...h, i })).filter((h) => picked.has(h.key));

  /** The amount in each token's own base units. A shared figure, read per token, never assumed. */
  const unitsFor = (i: number) => {
    try {
      const u = parseUnits((amount || "0").trim(), info(i).decimals);
      return u > 0n ? u : null;
    } catch {
      return null;
    }
  };
  const amountValid = amount.trim() !== "" && unitsFor(0) !== null;
  const ready = amountValid && chosen.length > 0;

  const preview = useMemo(() => {
    if (!address || !ready) return null;
    try {
      const now = Math.floor(Date.now() / 1000);
      const expiry = now + hours * 3600;
      // One leg per chain, one permit entry per token chosen on it. Two tokens on the same chain
      // are one leg with two entries, not two legs — one signature, one transaction per chain.
      const byChain = new Map<number, { chainId: number; permits: ReturnType<typeof approveEntry>[] }>();
      for (const h of chosen) {
        const units = unitsFor(h.i);
        if (!units) return null;
        const leg = byChain.get(h.chain.id) ?? { chainId: h.chain.id, permits: [] };
        leg.permits.push(approveEntry(h.token, h.chain.router, units, expiry));
        byChain.set(h.chain.id, leg);
      }
      return prepareIntent({
        crossPermit: CROSS_PERMIT,
        owner: address,
        now,
        // The signature itself lapses in an hour if it is never submitted; the allowance it creates
        // lives for the expiry chosen above.
        ttl: 3600,
        chains: [...byChain.values()],
      });
    } catch {
      return null;
    }
    // `chosen` is derived from the picked set, so the set is the real dependency.
  }, [address, amount, hours, ready, [...picked].sort().join(","), reads.data]);

  async function grant() {
    if (!preview || !address || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The wallet will not sign a domain pinned to a chain it is not on, and it does not switch
      // itself, so ask it to move first. No transaction follows — the signature is spent on the
      // chains it names, never on the signing domain's chain.
      await onSigningChain(chainId, switchChainAsync);
      const sig = await signTypedDataAsync({ ...preview.typedData, chainId: SIGNING_CHAIN_ID } as never);
      const { status: code, body } = await postIntent(toWire({ ...preview.intent, signature: sig }));
      if (code >= 400) throw new Error(`${body.code ?? code}: ${body.error ?? "rejected"}`);
      const id = String(body.intentId);
      setSignature(sig);
      setIntentId(id);
      // Binding turns an invitation into a client on the desk's screen, and tells them the terms
      // this client chose. If it fails the permission is still live on chain — say that, rather
      // than implying nothing happened.
      const bound = await linkMandate(token, address, id, {
        capUnits: (unitsFor(chosen[0]!.i) ?? 0n).toString(),
        ttlHours: hours,
        chainIds: [...new Set(chosen.map((h) => h.chain.id))],
      });
      if (!bound.ok) setLinkError(`Submitted on chain, but the desk could not record it (${bound.error}). Send them the intent id.`);
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- withdrawn ----
  if (client.status === "revoked") {
    return (
      <Sheet title={client.name} label="Link withdrawn">
        <Note
          title="This link was withdrawn by the desk."
          body={
            client.owner
              ? "A permission was already signed against it. Withdrawing the link does not revoke that — ask the desk for a cross-chain LOCK, or revoke from your wallet."
              : "Nothing was ever signed against it. Ask the desk for a new link."
          }
        />
      </Sheet>
    );
  }

  // ---- already signed, by someone (maybe you) ----
  if (client.status === "active" && !intentId) {
    const mine = Boolean(address && client.owner && address.toLowerCase() === client.owner.toLowerCase());
    return (
      <Sheet title={client.name} label="Signed">
        <dl className="kv">
          <Row k="Signed by" v={client.owner ? short(client.owner) : "—"} m={mine ? "your connected wallet" : address ? `you are connected as ${short(address)}` : "connect a wallet to check"} />
          <Row k="Granted" v={client.capUnits ? `${group(formatUnits(BigInt(client.capUnits), 6))} per token` : "—"} m={client.chainIds.map((id) => chainById(id)?.name ?? id).join(" · ")} />
          <Row k="Expires" v={client.ttlHours ? `${client.ttlHours}h after signing` : "—"} m="nothing more is asked of you" />
          <Row k="Intent" v={client.intentId ? short(client.intentId) : "—"} m="one signature, on every chain" />
        </dl>
      </Sheet>
    );
  }

  // ---- signed just now: each chain landing ----
  if (intentId) {
    const done = status?.done ?? false;
    const legRows = status?.legs ?? [...new Set(chosen.map((h) => h.chain.id))].map((chainId) => ({ chainId, status: "pending" as const, txHash: null, error: null }));
    return (
      <Sheet
        title={client.name}
        label={done ? (status?.ok ? "Granted" : "Partly granted") : "Submitting"}
        action={{ label: done ? (status?.ok ? "Granted" : "Some chains failed") : "Submitting…", disabled: true }}
        foot={linkError ?? "One signature, landing on each chain. You can close this page once every row settles."}
        footTone={linkError ? "err" : undefined}
      >
        <dl className="kv">
          {legRows.map((leg) => {
            const c = chainById(leg.chainId);
            const tone = leg.status === "confirmed" ? "ok" : leg.status === "failed" ? "bad" : "";
            return (
              <Row
                key={leg.chainId}
                k={c?.name ?? String(leg.chainId)}
                v={<span className={`tag ${tone}`}>{leg.status}</span>}
                m={
                  leg.txHash && c ? (
                    <a href={`${c.explorer}/tx/${leg.txHash}`} target="_blank" rel="noreferrer">
                      {short(leg.txHash)} ↗
                    </a>
                  ) : (
                    (leg.error ?? "waiting for the relayer")
                  )
                }
              />
            );
          })}
          <Row
            k="Signature"
            v={signature ? short(signature) : "—"}
            m={`root ${short(status?.root ?? preview?.intent.root ?? "—")} · intent ${short(intentId)}`}
          />
        </dl>
      </Sheet>
    );
  }

  // ---- not connected: one card, one button ----
  if (!isConnected || !address) {
    return (
      <Sheet
        title={client.name}
        label="Grant access"
        lede={client.mandate || "The desk sent you this link. Connect the wallet that holds the assets and you will see everything it can see: which tokens, on which chains, and what is already open. Nothing is signed by connecting."}
        action={{ label: "Connect wallet", onClick: () => openAppKit() }}
        foot="Nothing is signed at this step. The desk cannot move anything until you choose what to grant and sign it yourself."
      >
        <ul className="preview-chains">
          {CHAINS.map((c) => (
            <li key={c.id}>
              <ChainMark chain={c} />
              <span className="name">{c.name}</span>
              <span className="meta">{c.tokens.length} token{c.tokens.length === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      </Sheet>
    );
  }

  // ---- connected: assets on the left, the grant on the right ----
  const chains = [...new Set(chosen.map((h) => h.chain.id))];
  return (
    <div className="cpm wide">
      <header className="bar">
        <a className="brandmark" href="/">
          <HorseMatrix cols={20} size={24} />
          CrossPermit
        </a>
        <button type="button" className="btn btn-sm" onClick={() => disconnect()}>
          <span className="cap">{short(address)}</span>
        </button>
      </header>

      <div className="cols">
        <section className="panel inv" aria-label="Your assets">
          <div className="sec-head">
            <h2>Your assets</h2>
            <span className="label">{reads.isLoading ? "Reading…" : `${HOLDINGS.length} tokens`}</span>
          </div>
          <p className="sub">Tap the tokens the desk may spend. Balances and anything already open are read from each chain.</p>

          <ul className="holdings">
            {HOLDINGS.map((h, i) => {
              const d = info(i);
              const on = picked.has(h.key);
              return (
                <li key={h.key}>
                  <button
                    type="button"
                    className="holding"
                    aria-pressed={on}
                    onClick={() =>
                      setPicked((p) => {
                        const n = new Set(p);
                        n.has(h.key) ? n.delete(h.key) : n.add(h.key);
                        return n;
                      })
                    }
                  >
                    <TokenIcon symbol={d.symbol} chain={h.chain} />
                    <span className="who">
                      <span className="t">
                        {d.symbol ?? "Token"}
                        <span className="chain">{h.chain.name}</span>
                      </span>
                      <span className="s">
                        {d.name ?? "reading…"} · <span className="mono">{short(h.token, 6)}</span>
                      </span>
                    </span>
                    <span className="bal">
                      <span className="t">{d.balance === null ? "—" : group(d.balance)}</span>
                      <span className="s">{d.open && d.open !== "0" ? `${group(d.open)} open` : "none open"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel grantcol" aria-label="Grant access">
          <div className="sec-head">
            <h2>{client.name}</h2>
            <span className="label">Grant access</span>
          </div>
          <p className="sub">{client.mandate || "You decide what this link is worth. Nothing is granted until you sign."}</p>

          {chosen.length === 0 ? (
            <p className="empty">No tokens selected. Pick one from your assets to begin.</p>
          ) : (
            <ul className="chosen">
              {chosen.map((h) => {
                const d = info(h.i);
                return (
                  <li key={h.key}>
                    <TokenIcon symbol={d.symbol} chain={h.chain} small />
                    <span className="who">
                      <span className="t">{d.symbol ?? "Token"}</span>
                      <span className="s">{h.chain.name}</span>
                    </span>
                    <span className="amt">{amountValid ? `${group(amount.trim())}` : "—"}</span>
                    <button
                      type="button"
                      className="x"
                      aria-label={`Remove ${d.symbol ?? "token"} on ${h.chain.name}`}
                      onClick={() =>
                        setPicked((p) => {
                          const n = new Set(p);
                          n.delete(h.key);
                          return n;
                        })
                      }
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="terms">
            <label className="field">
              <span className="lbl">Amount per token</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="250000"
                aria-invalid={amount.trim() !== "" && !amountValid}
              />
            </label>
            <label className="field">
              <span className="lbl">Access expires</span>
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {EXPIRIES.map((e) => (
                  <option key={e.hours} value={e.hours}>
                    {e.label} after signing
                  </option>
                ))}
              </select>
            </label>
          </div>

          <dl className="kv total">
            <Row
              k="Granting"
              v={ready ? `${chosen.length} token${chosen.length === 1 ? "" : "s"} · ${chains.length} chain${chains.length === 1 ? "" : "s"}` : "—"}
              m="to the Uniswap Universal Router · exact amounts, not unlimited"
            />
            <Row
              k="Merkle root"
              v={preview ? short(preview.intent.root) : "—"}
              m={`verifying contract ${short(CROSS_PERMIT)} · same on every chain`}
            />
          </dl>

          <button type="button" className="btn btn-action go" disabled={busy || !ready || !preview} onClick={grant}>
            <span className="cap">{busy ? "Waiting for your wallet…" : "Sign and grant access"}</span>
          </button>
          <p className={`hint ${error ? "err" : ""}`}>
            {error ??
              (ready
                ? `One signature covers all ${chosen.length}. Off chain, no gas — you can reject it in your wallet.`
                : "Pick at least one token and set an amount.")}
          </p>
        </section>
      </div>

      <p className="micro seal">CrossPermit {short(CROSS_PERMIT, 8)} · the same contract on every chain</p>
    </div>
  );
}

// ---------- marks ----------

/**
 * A token's mark, badged with the chain it lives on.
 *
 * The same token symbol exists on several chains at different addresses, and confusing two of them
 * is how a client grants on a chain they did not mean to. The badge is the chain, in the chain's
 * own colour; the address under it is the part that actually binds the signature.
 */
function TokenIcon({ symbol, chain, small = false }: { symbol: string | null; chain: ChainInfo; small?: boolean }) {
  const logo = symbol ? TOKEN_LOGOS[symbol.toUpperCase()] : undefined;
  const initials = (symbol ?? "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() || "?";
  return (
    <span className={`icon ${small ? "sm" : ""}`} aria-hidden="true">
      {logo ? <img className="disc" src={logo} alt="" /> : <span className="disc">{initials}</span>}
      <img className="chainbadge" src={chain.logo} alt="" />
    </span>
  );
}

function ChainMark({ chain }: { chain: ChainInfo }) {
  return <img className="chainmark" src={chain.logo} alt="" aria-hidden="true" />;
}

// ---------- the sheet ----------

type Action = { label: string; onClick?: () => void; disabled?: boolean };

function Sheet(p: {
  title: string;
  label: string;
  lede?: string;
  children?: React.ReactNode;
  action?: Action;
  aside?: Action;
  foot?: string;
  footTone?: "err";
}) {
  return (
    <div className="cpm">
      <header className="bar">
        <a className="brandmark" href="/">
          <HorseMatrix cols={20} size={24} />
          CrossPermit
        </a>
        {p.aside && (
          <button type="button" className="btn btn-sm" onClick={p.aside.onClick}>
            <span className="cap">{p.aside.label}</span>
          </button>
        )}
      </header>

      <main className="panel" aria-live="polite">
        <div className="sec-head">
          <h1>{p.title}</h1>
          <span className="label">{p.label}</span>
        </div>
        {p.lede && <p className="sub">{p.lede}</p>}
        {p.children}
        {p.action && (
          <button type="button" className="btn btn-action go" disabled={p.action.disabled} onClick={p.action.onClick}>
            <span className="cap">{p.action.label}</span>
          </button>
        )}
        {p.foot && <p className={`hint ${p.footTone ?? ""}`}>{p.foot}</p>}
      </main>

      <p className="micro seal">CrossPermit {short(CROSS_PERMIT, 8)} · the same contract on every chain</p>
    </div>
  );
}

function Row({ k, v, m }: { k: string; v: React.ReactNode; m: React.ReactNode }) {
  return (
    <div className="kvrow">
      <dt>{k}</dt>
      <dd>
        <span className="v">{v}</span>
        <span className="m">{m}</span>
      </dd>
    </div>
  );
}

function Note({ title, body }: { title: string; body: string }) {
  return (
    <div className="note-block">
      <p className="v">{title}</p>
      <p className="m">{body}</p>
    </div>
  );
}
