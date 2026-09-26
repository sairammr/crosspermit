"use client";

/**
 * One control for the desk's identity, and the note that explains an empty book.
 *
 * Connecting and proving are two facts — an address a browser offers, and a signature that shows
 * someone holds its key — but they are not two decisions. Pressing this once walks both: it opens
 * the wallet modal if nothing is connected, then asks for the challenge signature as soon as an
 * address appears. One button, because "connect" followed by "now prove it" is a sequence the person
 * never wanted to think about.
 *
 * The signature costs no gas, names no spender and authorises no transfer. It is not a writ.
 */

import { useEffect, useRef, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { endSession, proveOwnership, useSession } from "./desk";
import { openAppKit } from "./wagmi";

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

export function ProveOwnership({ onChange }: { onChange?: () => void }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { state, reload } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the person pressed the button without a wallet connected. The wallet modal has no
  // completion callback, so the intent is remembered and the effect below picks it up when an
  // address arrives. Without this the first press would only ever connect.
  const wanted = useRef(false);

  const signedIn = state.kind === "ok";
  const proven = signedIn ? state.session.address.toLowerCase() : null;
  // A session for a DIFFERENT address than the one now connected. Not an error — people switch
  // accounts — but the button has to offer the switch rather than claim the old one is proven.
  const mismatch = Boolean(proven && address && proven !== address.toLowerCase());

  async function prove(who: `0x${string}`) {
    setBusy(true);
    setError(null);
    try {
      await proveOwnership(who, (message) => signMessageAsync({ message }));
      reload();
      onChange?.();
    } catch (e) {
      // A wallet rejection and a refused signature read the same on screen, so say which happened.
      setError(e instanceof Error ? e.message.split("\n")[0]! : String(e));
    } finally {
      setBusy(false);
      wanted.current = false;
    }
  }

  useEffect(() => {
    if (wanted.current && address && !busy && (!signedIn || mismatch)) void prove(address);
    // `prove` is stable enough for this: it closes over hooks that do not change identity per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, busy, signedIn, mismatch]);

  async function click() {
    if (signedIn && !mismatch) return openAppKit({ view: "Account" });
    wanted.current = true;
    setError(null);
    if (!address) return openAppKit();
    await prove(address);
  }

  async function out() {
    await endSession().catch(() => {});
    reload();
    onChange?.();
  }

  if (state.kind === "loading") return <span className="micro">…</span>;
  if (state.kind === "offline") return <span className="micro">desk layer unreachable</span>;

  const label = busy
    ? "check your wallet…"
    : signedIn && !mismatch
      ? short(proven!)
      : mismatch
        ? "prove this wallet"
        : isConnected
          ? "Prove ownership"
          : "Connect & prove";

  return (
    <span className="row" style={{ gap: 8 }}>
      {error && <span className="micro">{error}</span>}
      <span className={`status ${signedIn && !mismatch ? "active" : ""}`}>
        <i />
        {signedIn && !mismatch ? "proven" : isConnected ? "unproven" : "no wallet"}
      </span>
      <button
        className={`btn btn-sm ${signedIn && !mismatch ? "" : "btn-action"}`}
        type="button"
        disabled={busy}
        onClick={click}
      >
        <span className="cap">{label}</span>
      </button>
      {signedIn && !mismatch && (
        <button className="btn btn-sm" type="button" onClick={out}>
          <span className="cap">Sign out</span>
        </button>
      )}
    </span>
  );
}

/**
 * Why the book is empty when nobody has proven anything.
 *
 * Names the signature as the way in, and says what it is not: this one grants nothing and costs no
 * gas, unlike every other signature this product asks for.
 */
export function SignInNote() {
  return (
    <p className="note">
      Nobody has proven a wallet yet, so there is no book to show. Press <strong>Connect &amp; prove</strong> above and
      sign the challenge — one signature, no gas, no spender, no transfer. The desk layer recovers your address from it
      and shows the clients that are yours.
    </p>
  );
}
