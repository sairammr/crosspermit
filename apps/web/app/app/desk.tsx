"use client";

/**
 * The client book: who the clients are, and the link each of them signed under.
 *
 * Written to keep one distinction visible that is easy to blur on a dashboard: a mandate the desk
 * *asked for* is not authority. A dash in this table means the client has not signed, and what
 * their capital is actually doing lives on their own page, never here.
 */

import { useRef, useState } from "react";
import { formatUnits } from "viem";

import { chainById } from "../../src/config";
import { type ClientMandate, createClient, revokeClient, useClients } from "../../src/clients";
import { SignInNote } from "../../src/session-ui";

import "./desk.css";

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

const STATUS_LABEL: Record<ClientMandate["status"], string> = {
  awaiting: "awaiting signature",
  active: "active",
  revoked: "withdrawn",
};

// ---------------------------------------------------------------- clients

export function ClientsTab({ refreshKey, onChange }: { refreshKey: number; onChange: () => void }) {
  const clients = useClients(refreshKey);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<ClientMandate | null>(null);
  // The invitation form is a sheet rather than a permanent panel: opening a link is something the
  // desk does occasionally, and the ledger is what it looks at all day. Native <dialog>, so the
  // Escape key, the backdrop and focus trapping are the platform's job rather than ours.
  const sheet = useRef<HTMLDialogElement>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      // Name only. The desk opens a door; the client decides what to put behind it — which token,
      // how much, on which chains, for how long — and the relayer records that when they sign.
      const res = await createClient({ name, mandate: note.trim() || undefined });
      if (!res.ok) throw new Error(res.error);
      setFresh(res.client ?? null);
      setName("");
      setNote("");
      sheet.current?.close();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="desk">
      <dialog className="sheet" ref={sheet} onClose={() => setError(null)}>
        <form
          className="sheet-in"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="sec-head">
            <h2>New link</h2>
            <span className="label">01 / Invitation, not authority</span>
          </div>
          <p className="sub">
            You are opening a door, not setting terms. The client picks the token, the amount, the chains and the
            expiry on their own screen, and nothing is granted until they sign it there.
          </p>

          <label className="field">
            <span className="lbl">Client</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Meridian Capital" autoFocus />
          </label>
          <label className="field">
            <span className="lbl">Note to the client · optional</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What this mandate is for"
            />
          </label>

          <div className="row actions">
            <button type="submit" className="btn btn-action" disabled={busy || !name.trim()}>
              <span className="cap">{busy ? "Generating…" : "Generate link"}</span>
            </button>
            <button type="button" className="btn" onClick={() => sheet.current?.close()}>
              <span className="cap">Cancel</span>
            </button>
            {error && (
              <span className="err" role="alert">
                {error}
              </span>
            )}
          </div>
        </form>
      </dialog>

      {fresh && <ShareLink client={fresh} />}

      <div className="panel">
        <div className="sec-head">
          <h2>The book</h2>
          <span className="label">Every link this desk has opened</span>
          <button
            type="button"
            className="btn btn-sm btn-action new-mandate"
            onClick={() => sheet.current?.showModal()}
          >
            <span className="cap">New link</span>
          </button>
        </div>
        {clients === null && <p className="note">Loading…</p>}
        {clients === false && <SignInNote />}
        {Array.isArray(clients) && clients.length === 0 && <p className="note">No clients yet.</p>}
        {Array.isArray(clients) && clients.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Status</th>
                  <th className="num">Cap / chain</th>
                  <th className="num">Expiry</th>
                  <th>Chains</th>
                  <th>Signed by</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.token}>
                    <td>
                      {/* The name is the way in. A client row is a summary; the dashboard behind
                          it is where the approved tokens, their live capacity and what can be
                          done with them actually live. */}
                      <a className="client-open" href={`/app/client/${c.token}`}>
                        {c.name}
                      </a>
                      <span className="sub-line">{c.mandate || "client sets the terms"}</span>
                    </td>
                    <td>
                      <span className={`tag ${c.status}`}>{STATUS_LABEL[c.status]}</span>
                    </td>
                    <td className="num">{c.capUnits ? formatUnits(BigInt(c.capUnits), 6) : "—"}</td>
                    <td className="num">{c.ttlHours ? `${c.ttlHours}h` : "—"}</td>
                    <td>{c.chainIds.length ? c.chainIds.map((id) => chainById(id)?.short ?? id).join(" · ") : "—"}</td>
                    <td>{c.owner ? short(c.owner) : "—"}</td>
                    <td>
                      <div className="row">
                        <CopyLink token={c.token} small />
                        {c.status !== "revoked" && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={async () => {
                              await revokeClient(c.token);
                              onChange();
                            }}
                          >
                            <span className="cap">Withdraw</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">
          A dash means the client has not signed yet, so there are no terms: they choose the token, the cap, the chains
          and the expiry themselves. Withdrawing a link only stops it being used. An allowance a client already signed is live on chain until it
          expires or a cross-chain <span className="mono">LOCK</span> retires it.
        </p>
      </div>
    </div>
  );
}

function linkFor(token: string): string {
  return typeof window === "undefined" ? `/c/${token}` : `${window.location.origin}/c/${token}`;
}

function ShareLink({ client }: { client: ClientMandate }) {
  return (
    <div className="panel">
      <div className="sec-head">
        <h2>Send this to {client.name}</h2>
        <span className="label">02 / Share link</span>
      </div>
      <p className="sub">One client, one link. It grants nothing on its own.</p>
      <div className="share">
        <label className="field">
          <span className="lbl">Link</span>
          <input readOnly value={linkFor(client.token)} onFocus={(e) => e.currentTarget.select()} />
        </label>
        <CopyLink token={client.token} label="Copy link" />
        <a className="btn" href={`/c/${client.token}`} target="_blank" rel="noreferrer">
          <span className="cap">Open as client</span>
        </a>
      </div>
    </div>
  );
}

function CopyLink({ token, label = "Copy", small = false }: { token: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={small ? "btn btn-sm" : "btn"}
      onClick={async () => {
        // navigator.clipboard is unavailable on insecure origins that are not localhost, so a
        // failure here is normal rather than exceptional: show the state instead of throwing.
        try {
          await navigator.clipboard.writeText(linkFor(token));
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          setDone(false);
        }
      }}
    >
      <span className="cap" aria-live="polite">
        {done ? "Copied" : label}
      </span>
    </button>
  );
}
