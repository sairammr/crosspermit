"use client";

/**
 * The desk's own two screens: who the clients are, and what their capital can be put into.
 *
 * Both are written to keep one distinction visible that is easy to blur on a dashboard: a mandate
 * the desk *asked for* is not authority, and a strategy that exists in this repository is not the
 * same as a strategy that is deployed on the chain the client actually signed for. Where the two
 * differ, the screen says so instead of rendering a button that cannot work.
 */

import { useRef, useState } from "react";
import { formatUnits } from "viem";
import { useReadContract } from "wagmi";

import { crossPermitAbi } from "@crosspermit/sdk";
import { CHAINS, CROSS_PERMIT, chainById } from "../../src/config";
import { type ClientMandate, createClient, revokeClient, useClients } from "../../src/clients";
import { useTreasury } from "../../src/relayer";

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
          <h2>Clients</h2>
          <span className="label">03 / Ledger</span>
          <button
            type="button"
            className="btn btn-sm btn-action new-mandate"
            onClick={() => sheet.current?.showModal()}
          >
            <span className="cap">New link</span>
          </button>
        </div>
        {clients === null && <p className="note">Loading…</p>}
        {clients === false && (
          <p className="note">
            The relayer refused the client list. That is expected when <code>RELAYER_API_KEYS</code> is set and this
            dashboard has no <code>NEXT_PUBLIC_RELAYER_API_KEY</code> — the list is the desk&rsquo;s, not the
            public&rsquo;s.
          </p>
        )}
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

// ---------------------------------------------------------------- deployable capital

/**
 * One chain's outstanding authority to the execution desk, read from that chain's own storage.
 *
 * Read per chain rather than as one batched `useReadContracts`. Batching routes every read through
 * Multicall3, and a Multicall3 hop that fails reports the inner call as having "returned no data",
 * which is indistinguishable from a contract that is not there. A plain `eth_call` either answers
 * or errors, and on a screen where the difference between "zero" and "unknown" is the difference
 * between deploying capital and not, that distinction is worth more than one round trip.
 */
function useAllowance(chain: (typeof CHAINS)[number], owner?: `0x${string}`) {
  const read = useReadContract({
    address: CROSS_PERMIT,
    abi: crossPermitAbi,
    functionName: "allowance",
    args: [owner as `0x${string}`, chain.token, chain.router],
    chainId: chain.id,
    query: { enabled: Boolean(owner), refetchInterval: 20_000, retry: 2 },
  });

  if (!owner) return { state: "idle" as const };
  if (read.isLoading) return { state: "loading" as const };
  if (read.error || !read.data) {
    return { state: "unreadable" as const, why: String(read.error ?? "no data").slice(0, 300) };
  }

  const [amount, expiration] = read.data as readonly [bigint, number, number];
  // Expiration 0 is a LOCK, not an unbounded grant: the contract zeroes the amount and holds it
  // there. Either way there is nothing to deploy.
  const live = expiration > Math.floor(Date.now() / 1000);
  return { state: "ok" as const, amount: live ? amount : 0n, expiration, expired: !live && amount > 0n };
}

function Deployable({ chain, owner }: { chain: (typeof CHAINS)[number]; owner?: `0x${string}` }) {
  const a = useAllowance(chain, owner);
  if (a.state === "ok") return <>{formatUnits(a.amount, 6)}</>;
  return <span title={a.state === "unreadable" ? a.why : undefined}>—</span>;
}

function ChainCapital({
  chain,
  owner,
  uncovered,
}: {
  chain: (typeof CHAINS)[number];
  owner?: `0x${string}`;
  uncovered: boolean;
}) {
  const a = useAllowance(chain, owner);
  const audit = uncovered ? " · no control-plane audit trail here" : "";

  return (
    <div className="stat" title={a.state === "unreadable" ? a.why : undefined}>
      <div className="k">{chain.name}</div>
      <div className="v">{a.state === "ok" ? formatUnits(a.amount, 6) : "—"}</div>
      <div className="n">
        {a.state === "loading" && `reading ${chain.name}…`}
        {a.state === "idle" && "no account selected"}
        {/* Never "0". A chain that could not be read has an unknown allowance, and saying zero would
            tell the desk a client has no authority where they may have a great deal. */}
        {a.state === "unreadable" && "could not be read — unknown, not zero"}
        {a.state === "ok" && (a.expired ? "expired — nothing deployable" : "unexpired allowance, 6dp")}
        {audit}
      </div>
    </div>
  );
}

/** One chain's row inside a venue card: the allowance readout and the key that arms it. */
function ArmRow({
  chain,
  owner,
  live,
  armed,
  onArm,
}: {
  chain: (typeof CHAINS)[number];
  owner?: `0x${string}`;
  live: boolean;
  armed: boolean;
  onArm: () => void;
}) {
  const a = useAllowance(chain, owner);
  const deployable = a.state === "ok" ? a.amount : 0n;
  const why = !live
    ? "no testnet deployment"
    : a.state === "idle"
      ? "no account selected"
      : a.state === "loading"
        ? "reading…"
        : a.state === "unreadable"
          ? "allowance unreadable — unknown, not zero"
          : a.expired
            ? "allowance expired"
            : deployable === 0n
              ? "nothing deployable"
              : "";
  const eligible = why === "";

  return (
    <div className="arm">
      <span className="micro">{chain.short}</span>
      <span className="amt">
        {a.state === "ok" ? formatUnits(deployable, 6) : "—"}
        <small>{eligible ? "deployable, 6dp" : why}</small>
      </span>
      <button
        type="button"
        className={eligible ? "btn btn-sm btn-action" : "btn btn-sm"}
        disabled={!eligible}
        aria-pressed={armed}
        title={eligible ? undefined : why}
        onClick={onArm}
      >
        <span className="cap">{armed ? "Armed" : "Arm"}</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- strategies

/**
 * What a desk can actually do with a client's mandate, per chain.
 *
 * `live` is the honest bit. Uniswap v4 is deployed on all three testnets and the lifecycle proves a
 * swap settles out of a CrossPermit allowance there. Aave v4 and the equity desk are fork-proved
 * against mainnet and have no testnet deployment, so they are listed as venues the mandate is
 * *shaped for* rather than ones this dashboard can route into today.
 */
const STRATEGIES = [
  {
    key: "v4",
    venue: "Uniswap v4",
    what: "Swap and provide liquidity through the Universal Router, settled out of the allowance.",
    live: true,
    figures: [
      ["Pool fee", "0.30%"],
      ["Proved", "1,000,000 in → 996,999 out, per chain"],
      ["Path", "V4_SWAP → SETTLE_ALL → transferFrom"],
    ],
  },
  {
    key: "aave",
    venue: "Aave v4",
    what: "Supply idle cash to the Core Hub through the MAIN Spoke.",
    live: false,
    figures: [
      ["Supply APR", "3.976%"],
      ["Supply APY", "4.056%"],
      ["Utilisation", "90.16%, read at the Hub"],
      ["30-day round trip", "10,000 → 10,032.65 USDC"],
    ],
  },
  {
    key: "equity",
    venue: "Tokenized equities",
    what: "Fill tokenized equity exposure against an oracle, bounded three ways.",
    live: false,
    figures: [
      ["Instrument", "NVDAon (Ondo), read live"],
      ["Bounds", "minOut · staleness window · deviation band"],
      ["Gate", "compliance gate denies when unset"],
    ],
  },
] as const;

export function StrategiesTab({ owner, refreshKey }: { owner?: `0x${string}`; refreshKey: number }) {
  const clients = useClients(refreshKey);
  const active = Array.isArray(clients) ? clients.filter((c) => c.owner && c.status === "active") : [];
  const [picked, setPicked] = useState<string>("");
  // ponytail: "armed" is a desk-side selection of venue × chain only. No route is submitted from
  // this screen yet; wire the router call here when the desk gets a submit path.
  const [armed, setArmed] = useState<string | null>(null);

  // The desk manages client capital, so the subject of this screen is a client by default and the
  // connected wallet only when no client is chosen. Whose figures these are is named on the page:
  // a treasury screen that silently switched account would be worse than one that showed nothing.
  const chosen = active.find((c) => c.token === picked);
  const subject = (chosen?.owner as `0x${string}` | undefined) ?? owner;
  // Only for which chains carry a control-plane audit trail. The figures themselves come from
  // storage, below.
  const treasury = useTreasury(subject, refreshKey);

  return (
    <div className="desk">
      <div className="panel">
        <div className="sec-head">
          <h2>Deployable now</h2>
          <span className="label">01 / Capital per chain</span>
        </div>
        <p className="sub">
          Read off each chain's own storage: the allowance still standing to the execution desk, with locked and expired
          ones counted as nothing.
        </p>

        <div className="row subject">
          <label className="field">
            <span className="lbl">Whose capital</span>
            <select value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">{owner ? "the connected wallet" : "— pick a client —"}</option>
              {active.map((c) => (
                <option key={c.token} value={c.token}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {subject && (
            <span className="addr">
              {chosen ? `${chosen.name} · ` : "connected wallet · "}
              {subject}
            </span>
          )}
        </div>

        {active.length === 0 && Array.isArray(clients) && (
          <p className="note">
            No client has signed a mandate yet, so there is no client capital to show. Add one on the clients tab.
          </p>
        )}
        {!subject && (
          <p className="note">
            Connect a wallet, pick a client, or open with <code>?owner=0x…</code>.
          </p>
        )}
        {subject && (
          <div className="grid">
            {CHAINS.map((c) => (
              <ChainCapital
                key={c.id}
                chain={c}
                owner={subject}
                uncovered={Boolean(treasury && treasury.uncovered?.includes(c.id))}
              />
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="sec-head">
          <h2>Strategies and venues</h2>
          <span className="label">02 / Arm per chain</span>
        </div>
        <p className="sub">Where a mandate can be put to work, and which of those this deployment can reach.</p>
        <div className="venues">
          {STRATEGIES.map((s) => (
            <section className="venue" key={s.key} aria-labelledby={`venue-${s.key}`}>
              <div className="venue-head">
                <h3 id={`venue-${s.key}`}>{s.venue}</h3>
                <span className={`tag ${s.live ? "active" : "awaiting"}`}>
                  {s.live ? "live on all three testnets" : "mainnet fork only"}
                </span>
              </div>
              <p>{s.what}</p>
              <dl className="kv-list">
                {s.figures.map(([k, v]) => (
                  <div className="kv" key={k}>
                    <dt className="micro">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <div>
                {CHAINS.map((c) => {
                  // Keyed on the subject too, so switching client disarms whatever was armed for the
                  // last one instead of carrying a selection across accounts.
                  const id = `${subject ?? ""}:${s.key}:${c.id}`;
                  return (
                    <ArmRow
                      key={c.id}
                      chain={c}
                      owner={subject}
                      live={s.live}
                      armed={armed === id}
                      onArm={() => setArmed((prev) => (prev === id ? null : id))}
                    />
                  );
                })}
              </div>
              {!s.live && (
                <p className="note">
                  No deployment exists on Ethereum, Base or Optimism Sepolia, so this dashboard will not offer to route
                  into it. The figures above were recorded by <span className="mono">FORK=1 forge test</span> against
                  live mainnet.
                </p>
              )}
            </section>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="sec-head">
          <h2>Liquidity venues per chain</h2>
          <span className="label">03 / Execution desks</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Chain</th>
                <th>Execution desk (spender)</th>
                <th>Token</th>
                <th className="num">Deployable</th>
              </tr>
            </thead>
            <tbody>
              {CHAINS.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <a href={`${c.explorer}/address/${c.router}`} target="_blank" rel="noreferrer">
                      {short(c.router)}
                    </a>
                  </td>
                  <td>{short(c.token)}</td>
                  <td className="num">
                    <Deployable chain={c} owner={subject} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
