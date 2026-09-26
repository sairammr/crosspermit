"use client";

/**
 * The desk's front screen: what stands right now, and where the record of it comes from.
 *
 * The desk had seven tabs and no answer to "what is the state of things" — every screen was a
 * detail view, so a manager opening the app had to visit four of them and hold the total in their
 * head. This is that total, and nothing on it is computed from anything but what the other screens
 * already read.
 *
 * It is also where the control plane is made visible. Almost everything a risk officer would want
 * from this product — what was authorised, to whom, when, and what has happened to it since — is
 * not in chain storage at all: storage holds the allowance that stands now and forgets every one
 * that expired. The record comes from decoded `Permit`, `Lock` and `NonceInvalidated` events in
 * MultiBaas, and a chain with no MultiBaas deployment has no record at all. That distinction is
 * the difference between "nothing was authorised here" and "we cannot see what was authorised
 * here", so it is stated on the face of the screen rather than left for someone to infer from an
 * empty table.
 */

import { CHAINS, chainById } from "../../src/config";
import { type ClientMandate } from "../../src/clients";
import {
  type ActivityRow,
  type ActivityView,
  type ChainRow,
  type IntentStatus,
  type TreasuryView,
} from "../../src/relayer";

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

const usd = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(2);

/** A reading: the label it answers to, the figure, and the sentence that says what it means. */
function Readout({ k, v, n, tone }: { k: string; v: string; n: string; tone?: "warn" | "bad" }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      <div className="n">{n}</div>
    </div>
  );
}

export function Overview({
  owner,
  connected,
  chains,
  treasury,
  activity,
  clients,
  intents,
  inFlight,
  onGo,
}: {
  owner?: `0x${string}`;
  connected: boolean;
  chains: { crossPermit: string; chains: ChainRow[] } | null | false;
  treasury: TreasuryView | null | false;
  activity: ActivityView | null | false;
  clients: ClientMandate[] | null | false;
  intents: { intentId: string; owner: string; root: string; createdAt: number }[];
  inFlight: IntentStatus | null;
  /** Every empty state on this screen names the screen that fixes it, and this is how it gets there. */
  onGo: (tab: string) => void;
}) {
  const rows = treasury && typeof treasury === "object" ? treasury.rows : [];
  const active = rows.filter((r) => r.state === "active");
  const locked = rows.filter((r) => r.state === "locked");
  const unbounded = rows.filter((r) => r.state === "unbounded");
  // Unbounded rows are deliberately left out of the total rather than added as a huge number: one
  // uint256-max allowance would swamp the figure and make a real exposure unreadable. They are
  // counted separately, below, where they belong.
  const outstanding = active.reduce((sum, r) => sum + Number(r.amount) / 1e6, 0);

  const live = Array.isArray(clients) ? clients.filter((c) => c.status === "active") : [];
  const awaiting = Array.isArray(clients) ? clients.filter((c) => c.status === "awaiting") : [];

  const indexed = chains && typeof chains === "object" ? chains.chains.filter((c) => c.auditTrail === "multibaas") : [];
  const blind = chains && typeof chains === "object" ? chains.chains.filter((c) => c.auditTrail !== "multibaas") : [];

  const events = activity && typeof activity === "object" ? activity.rows : [];
  const perChain = new Map<number, number>();
  for (const e of events) perChain.set(e.chainId, (perChain.get(e.chainId) ?? 0) + 1);

  return (
    <>
      <div className="sec-head">
        <h2>The desk</h2>
        <span className="label">01 / overview</span>
      </div>

      {/* ---- the four figures a manager opens the app to see ---- */}
      <div className="grid g4">
        <Readout
          k="Outstanding authority"
          v={owner && treasury && typeof treasury === "object" ? `${usd(outstanding)} USDC` : "—"}
          n={
            !owner
              ? "connect a wallet to read the ledger"
              : treasury === null
                ? "reading the ledger…"
                : treasury === false
                  ? "the desk layer is unreachable"
                  : `${active.length} live allowance${active.length === 1 ? "" : "s"}${
                      unbounded.length ? `, ${unbounded.length} unbounded and not counted` : ""
                    }`
          }
        />
        <Readout
          k="Clients"
          v={Array.isArray(clients) ? `${live.length} / ${clients.length}` : "—"}
          n={
            Array.isArray(clients)
              ? `signed and live, of ${clients.length} link${clients.length === 1 ? "" : "s"}${
                  awaiting.length ? ` · ${awaiting.length} awaiting a signature` : ""
                }`
              : clients === null
                ? "reading the book…"
                : // The book is the signed-in manager's, so an unproven wallet is the ordinary
                  // reason this is empty — not a fault, and it must not be reported as one.
                  "prove a wallet to read your book"
          }
        />
        <Readout
          k="Chains with a record"
          v={chains && typeof chains === "object" ? `${indexed.length} / ${chains.chains.length}` : "—"}
          n={
            chains === null
              ? "reading the control plane…"
              : chains === false
                ? "the desk layer is unreachable"
                : blind.length
                  ? `${blind.map((c) => c.name).join(", ")} indexes nothing — authority there is invisible`
                  : "every chain the desk trades is indexed in MultiBaas"
          }
          tone={chains && typeof chains === "object" && blind.length ? "warn" : undefined}
        />
        <Readout
          k="Signatures fanned out"
          v={String(intents.length)}
          n={
            locked.length
              ? `${locked.length} spender${locked.length === 1 ? " is" : "s are"} LOCKed across the book`
              : "one message each, spent on every chain it named"
          }
          tone={locked.length ? "bad" : undefined}
        />
      </div>

      {/* ---- the control plane ----
          The MultiBaas showcase, and the screen's reason for existing: the record is a product
          surface here, not plumbing mentioned in a footnote. */}
      <div className="panel" style={{ marginTop: 16 }}>
        <span className="label">Control plane · MultiBaas</span>
        <p className="sub">
          Where the record lives. CrossPermit is registered as a contract in MultiBaas on each chain below, with event
          sync running from the block it was deployed at, so every <span className="mono">Permit</span>,{" "}
          <span className="mono">Lock</span> and <span className="mono">NonceInvalidated</span> arrives here decoded
          rather than as calldata. The relayer signs wherever its key lives and submits through the same API, so a
          transaction lands in this trail whichever way it was signed.
        </p>

        {chains === null && <p className="note">reading the control plane…</p>}
        {chains === false && (
          <p className="err">
            The desk layer is unreachable, so nothing on this screen can be read. Start it:{" "}
            <span className="mono">bun run apps/relayer/src/server.ts</span>
          </p>
        )}

        {chains && typeof chains === "object" && (
          <>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Chain</th>
                    <th>Relayer signer</th>
                    <th>Key custody</th>
                    <th>Record</th>
                    <th className="num">Events for this account</th>
                  </tr>
                </thead>
                <tbody>
                  {chains.chains.map((c) => {
                    const seen = perChain.get(c.chainId) ?? 0;
                    return (
                      <tr key={c.chainId}>
                        <td>
                          {c.name} <span className="dim">{c.chainId}</span>
                        </td>
                        <td>{short(c.signer)}</td>
                        <td>
                          {/* A local key is a real, named risk, not a neutral fact: it says the one
                              long-lived secret in this system sits on the relayer host. */}
                          <span className={`tag ${c.custody === "local" ? "warn" : "ok"}`}>
                            {c.custody === "local" ? "local key" : c.custody}
                          </span>
                        </td>
                        <td>
                          {c.auditTrail === "multibaas" ? (
                            <span className="tag ok">indexed</span>
                          ) : (
                            <span className="tag bad">none</span>
                          )}
                        </td>
                        <td className="num">
                          {c.auditTrail !== "multibaas" ? (
                            <span className="dim">not indexed</span>
                          ) : !owner ? (
                            <span className="dim">—</span>
                          ) : (
                            seen
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {blind.length > 0 && (
              <p className="note">
                An empty row for {blind.map((c) => c.name).join(" or ")} means the record is missing, not that nothing
                was authorised. A free MultiBaas account gets one deployment per network, so a chain beyond that limit
                still carries exposure the desk cannot show you. That gap is reported rather than hidden, because a
                treasury screen that lets &ldquo;no authority&rdquo; and &ldquo;no visibility&rdquo; read the same is
                worse than no screen.
              </p>
            )}
          </>
        )}
      </div>

      {/* ---- in flight ---- */}
      {inFlight && !inFlight.done && (
        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
            <span className="label">In flight</span>
            <span className="status live">
              <i />
              {inFlight.legs.filter((l) => l.status === "confirmed").length}/{inFlight.legs.length} confirmed
            </span>
          </div>
          <p className="sub">
            One signature, <span className="mono">{short(inFlight.root, 8)}</span>, being spent on every chain it named.
          </p>
          <div className="row">
            {inFlight.legs.map((l) => (
              <span
                key={l.chainId}
                className={`tag ${l.status === "confirmed" ? "ok" : l.status === "failed" ? "bad" : "warn"}`}
              >
                {chainById(l.chainId)?.name ?? l.chainId} · {l.status}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ---- the record itself ---- */}
      <div className="panel">
        <span className="label">Recent activity</span>
        <p className="sub">
          Everything the control plane recorded for this account, newest first. This is the only place an allowance that
          has since expired still appears — it left no storage behind to read, but it left an event.
        </p>

        {!connected && !owner && (
          <p className="note">
            Nothing is shown until a wallet is proven. Press <strong>Connect &amp; prove</strong> in the rail above and
            sign the challenge — one signature, no gas, no spender, no transfer.
          </p>
        )}
        {owner && activity === null && <p className="note">reading the control plane…</p>}
        {owner && activity === false && <p className="err">the desk layer is not answering for this account.</p>}
        {owner && activity && typeof activity === "object" && events.length === 0 && (
          <p className="note">
            No decoded events for this account yet. Indexing starts at the block CrossPermit was registered on each
            chain, so anything earlier is outside the record by design.
          </p>
        )}

        {events.length > 0 && <ActivityTable rows={events.slice(0, 12)} />}
      </div>

      {/* ---- where to go next ---- */}
      {Array.isArray(clients) && clients.length === 0 && (
        <div className="panel">
          <span className="label">Start here</span>
          <p className="sub">
            The desk has no clients yet. A client link asks for a name and nothing else — which token, how much and for
            how long are the client&apos;s to choose on the page they sign.
          </p>
          <button className="btn btn-action" type="button" onClick={() => onGo("clients")}>
            <span className="cap">Open a client link</span>
          </button>
        </div>
      )}
    </>
  );
}

/** The event log, decoded. One row per thing that happened, with the transaction it happened in. */
function ActivityTable({ rows }: { rows: ActivityRow[] }) {
  const tone = (k: ActivityRow["kind"]) =>
    k === "granted" ? "ok" : k === "locked" ? "bad" : k === "cancelled" ? "warn" : "";
  const said = (k: ActivityRow["kind"]) =>
    k === "granted"
      ? "authority granted"
      : k === "locked"
        ? "spender LOCKed"
        : k === "cleared"
          ? "allowance cleared"
          : "signature retracted";

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>What happened</th>
            <th>Chain</th>
            <th>Spender</th>
            <th className="num">Amount</th>
            <th>When</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.txHash ?? r.salt ?? i}-${r.chainId}-${i}`}>
              <td>
                <span className={`tag ${tone(r.kind)}`}>{said(r.kind)}</span>
              </td>
              <td>
                {r.chainName} <span className="dim">{r.chainId}</span>
              </td>
              <td>{r.spender ? short(r.spender) : <span className="dim">—</span>}</td>
              <td className="num">
                {r.amount ? (Number(r.amount) / 1e6).toLocaleString() : <span className="dim">—</span>}
              </td>
              <td className="dim">
                {r.timestamp ? new Date(r.timestamp * 1000).toLocaleString() : (r.at ?? "—")}
              </td>
              <td className="dim">
                {r.txHash ? (
                  r.explorer ? (
                    <a href={r.explorer} target="_blank" rel="noreferrer">
                      {short(r.txHash)}
                    </a>
                  ) : (
                    short(r.txHash)
                  )
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Chains the desk is configured for, for screens that need the list before the relayer answers. */
export const CONFIGURED_CHAINS = CHAINS;
