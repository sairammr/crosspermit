"use client";

/**
 * The client's side of an invitation.
 *
 * This page asks someone to sign one message that grants a desk spending authority on several
 * chains at once, so it is written to be read before it is signed: every per-chain bundle is
 * rendered in plain language, from values computed here, before the wallet is ever opened. A
 * signer who only sees an opaque merkle root in their wallet is trusting the page; the whole point
 * of computing the leaves client-side is that they do not have to.
 */

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useSignTypedData } from "wagmi";

import { approveEntry, prepareIntent, toWire } from "@crosspermit/sdk";
import { CROSS_PERMIT, chainById } from "../../../src/config";
import { type ClientMandate, linkMandate, useMandate } from "../../../src/clients";
import { HorseMatrix } from "../../../src/dithergraph";
import { postIntent, useIntentStream } from "../../../src/relayer";

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === "string" ? params.token : undefined;
  const { state, reload } = useMandate(token);

  return (
    <div className="lp">
      <header className="rail stuck">
        <div className="rail-in">
          <div className="brandmark">
            <HorseMatrix cols={13} size={22} />
            CrossPermit<span style={{ color: "var(--accent)" }}>.</span>
          </div>
          <span className="micro">Client mandate</span>
        </div>
      </header>

      <main className="wrapx" style={{ paddingTop: 108, paddingBottom: 80, maxWidth: 860 }}>
        {state.kind === "loading" && <p className="lede">Loading the mandate…</p>}

        {state.kind === "missing" && (
          <Note title="This link is not valid">
            It may have been withdrawn by the desk, or mistyped. Nothing was signed and nothing was
            granted. Ask whoever sent it for a new one.
          </Note>
        )}

        {state.kind === "offline" && (
          <Note title="Cannot reach the desk">
            The relayer did not answer, so this mandate could not be read. Do not sign anything on a
            page that could not load what it is asking you to sign — reload, or come back later.
          </Note>
        )}

        {state.kind === "ok" && <Mandate client={state.client} token={token!} onLinked={reload} />}
      </main>
    </div>
  );
}

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mod">
      <span className="label">Notice</span>
      <h3 style={{ marginTop: 10 }}>{title}</h3>
      <p className="lede" style={{ fontSize: 15, marginTop: 10 }}>
        {children}
      </p>
    </div>
  );
}

function Mandate({ client, token, onLinked }: { client: ClientMandate; token: string; onLinked: () => void }) {
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [intentId, setIntentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { status } = useIntentStream(intentId);

  const cap = BigInt(client.capUnits);
  // Only chains this dashboard actually knows how to address. A mandate naming a chain that has no
  // deployment here is shown as excluded rather than quietly dropped from the signature.
  const legs = client.chainIds.map((id) => ({ id, chain: chainById(id) }));
  const known = legs.filter((l) => l.chain).map((l) => l.chain!);
  const unknown = legs.filter((l) => !l.chain).map((l) => l.id);

  const preview = useMemo(() => {
    if (!address || known.length === 0) return null;
    try {
      const now = Math.floor(Date.now() / 1000);
      const expiry = now + client.ttlHours * 3600;
      return prepareIntent({
        crossPermit: CROSS_PERMIT,
        owner: address,
        now,
        ttl: 3600,
        chains: known.map((c) => ({
          chainId: c.id,
          permits: [approveEntry(c.token, c.router, cap, expiry)],
        })),
      });
    } catch {
      return null;
    }
    // `known` is derived from client.chainIds, so the id list is the real dependency.
  }, [address, client.chainIds.join(","), client.ttlHours, client.capUnits]);

  async function sign() {
    if (!preview || !address) return;
    setBusy(true);
    setError(null);
    try {
      const signature = await signTypedDataAsync(preview.typedData as never);
      const { status: code, body } = await postIntent(toWire({ ...preview.intent, signature }));
      if (code >= 400) throw new Error(`${body.code ?? code}: ${body.error ?? "rejected"}`);
      const id = String(body.intentId);
      setIntentId(id);

      // Binding is what turns an invitation into a client on the desk's screen. If it fails the
      // permission is still live on chain — say that, rather than implying nothing happened.
      const bound = await linkMandate(token, address, id);
      if (!bound.ok) {
        setError(
          `Your permission was submitted, but the desk could not record it against this link (${bound.error}). ` +
            `Send them the intent id above.`,
        );
      }
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (client.status === "revoked") {
    return (
      <Note title="This invitation was withdrawn">
        {client.owner
          ? "A permission was already signed against it. Withdrawing the link does not revoke that — to close it, ask the desk for a cross-chain LOCK, or revoke from your own wallet."
          : "Nothing was ever signed against it. Ask the desk for a new link."}
      </Note>
    );
  }

  if (client.status === "active" && !intentId) {
    return (
      <>
        <Head client={client} />
        <div className="mod" style={{ marginTop: 16 }}>
          <span className="label">Already signed</span>
          <h3 style={{ marginTop: 10 }}>This mandate is live</h3>
          <div style={{ marginTop: 16 }}>
            <Row k="Signed by" v={client.owner ?? "—"} />
            <Row k="Intent" v={client.intentId ?? "—"} />
            <Row k="Signed at" v={client.linkedAt ? new Date(client.linkedAt).toLocaleString() : "—"} />
          </div>
          <p className="lede" style={{ fontSize: 14, marginTop: 16 }}>
            You keep custody throughout. The desk can spend up to the cap above and no further, and
            the authority expires on its own.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <Head client={client} />

      <div className="mod" style={{ marginTop: 16 }}>
        <span className="label">What you are about to sign</span>
        <h3 style={{ marginTop: 10 }}>
          One message. {known.length} {known.length === 1 ? "chain" : "chains"}.
        </h3>
        <p className="lede" style={{ fontSize: 15, marginTop: 10 }}>
          A single EIP-712 signature over a merkle root of the bundles below. Each line is a separate
          allowance on its own chain; nothing outside these lines can be granted by this signature.
        </p>

        <div style={{ marginTop: 20, display: "grid", gap: 12 }}>
          {known.map((c) => (
            <div className="mod-flat" key={c.id} style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <h3 style={{ fontSize: 16 }}>{c.name}</h3>
                <span className="badge badge-out">{c.id}</span>
              </div>
              <div style={{ marginTop: 12 }}>
                <Row k="Token" v={c.token} />
                <Row k="Spender" v={`${c.router} — Uniswap Universal Router`} />
                <Row k="Up to" v={`${formatUnits(cap, 6)} (6dp)`} />
                <Row k="Expires" v={`${client.ttlHours}h from signing`} />
              </div>
            </div>
          ))}
        </div>

        {unknown.length > 0 && (
          <p className="lede" style={{ fontSize: 14, marginTop: 16, color: "var(--bad)" }}>
            The desk also asked for {unknown.join(", ")}, which this page has no deployment for. Those
            chains are <strong>not</strong> in the signature below.
          </p>
        )}

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 24 }}>
          {/* AppKit's own element: the connect button and the account modal. */}
          <appkit-button balance="hide" />
          <button className="btn btn-action" disabled={!isConnected || !preview || busy} onClick={sign}>
            {busy ? "signing…" : `Sign once, ${known.length} chains`}
          </button>
          {!isConnected && <span className="micro">connect a wallet to sign</span>}
        </div>

        {error && (
          <p className="lede" style={{ fontSize: 14, marginTop: 16, color: "var(--bad)" }}>
            {error}
          </p>
        )}
      </div>

      {status && (
        <div className="mod" style={{ marginTop: 16 }}>
          <span className="label">Submission</span>
          <h3 style={{ marginTop: 10 }}>
            {status.done ? (status.ok ? "Your mandate is live" : "Some chains did not land") : "Submitting…"}
          </h3>
          <div style={{ marginTop: 16 }}>
            {status.legs.map((leg) => {
              const c = chainById(leg.chainId);
              return (
                <Row
                  key={leg.chainId}
                  k={c?.name ?? String(leg.chainId)}
                  v={
                    leg.txHash && c ? (
                      <a href={`${c.explorer}/tx/${leg.txHash}`} target="_blank" rel="noreferrer">
                        {leg.status} · {leg.txHash.slice(0, 10)}…
                      </a>
                    ) : (
                      (leg.error ?? leg.status)
                    )
                  }
                />
              );
            })}
          </div>
          <p className="lede" style={{ fontSize: 14, marginTop: 16 }}>
            You signed once. Every line above came from that one signature, and each is a real
            transaction on its own chain.
          </p>
        </div>
      )}
    </>
  );
}

function Head({ client }: { client: ClientMandate }) {
  return (
    <>
      <span className="label">Mandate request</span>
      <h2 style={{ marginTop: 12 }}>{client.name}</h2>
      <p className="lede" style={{ marginTop: 14 }}>{client.mandate}</p>
      <div className="terminal" style={{ marginTop: 24 }}>
        <div className="dot-field">
          <HorseMatrix cols={24} tone="light" />
        </div>
        <span className="label">The bounds you are agreeing to</span>
        <div style={{ marginTop: 14 }}>
          <div className="kv">
            <span>Per-chain cap</span>
            <span>{formatUnits(BigInt(client.capUnits), 6)}</span>
          </div>
          <div className="kv">
            <span>Expires after</span>
            <span>{client.ttlHours} hours</span>
          </div>
          <div className="kv">
            <span>Chains</span>
            <span>
              {client.chainIds
                .map((id) => chainById(id)?.short ?? String(id))
                .join(" · ")}
            </span>
          </div>
          <div className="kv">
            <span>Custody</span>
            <span>stays with you</span>
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span style={{ wordBreak: "break-all", textAlign: "right" }}>{v}</span>
    </div>
  );
}
