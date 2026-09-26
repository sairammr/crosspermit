"use client";

/**
 * The two bits of chrome the desk session needs: a button that proves ownership, and the note that
 * explains an empty book.
 *
 * Kept apart from `desk.ts` so that module stays free of React and of wagmi — it is also what the
 * scripts and the tests talk to.
 */

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { endSession, proveOwnership, useSession } from "./desk";
import { openAppKit } from "./wagmi";

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

/**
 * Connect, then prove. Two steps on purpose: an address in a browser is a claim, and the desk's book
 * is not handed over on a claim.
 */
export function ProveOwnership({ onChange }: { onChange?: () => void }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { state, reload } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedIn = state.kind === "ok";
  const mismatch = signedIn && address && state.session.address.toLowerCase() !== address.toLowerCase();

  async function prove() {
    if (!address) return openAppKit();
    setBusy(true);
    setError(null);
    try {
      await proveOwnership(address, (message) => signMessageAsync({ message }));
      reload();
      onChange?.();
    } catch (e) {
      // A wallet rejection and a refused signature read the same to a user, so say which happened.
      setError(e instanceof Error ? e.message.split("\n")[0]! : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function out() {
    await endSession().catch(() => {});
    reload();
    onChange?.();
  }

  if (state.kind === "loading") return <span className="micro">…</span>;
  if (state.kind === "offline") return <span className="micro">desk layer unreachable</span>;

  return (
    <span className="row" style={{ gap: 8 }}>
      {error && <span className="micro">{error}</span>}
      {signedIn && !mismatch && (
        <>
          <span className="status active">
            <i />
            {short(state.session.address)} proven
          </span>
          <button className="btn btn-sm" type="button" onClick={out}>
            <span className="cap">Sign out</span>
          </button>
        </>
      )}
      {(!signedIn || mismatch) && (
        <button className={`btn btn-sm ${isConnected ? "btn-action" : ""}`} type="button" disabled={busy} onClick={prove}>
          <span className="cap">
            {busy ? "check your wallet…" : mismatch ? "prove this wallet" : isConnected ? "Prove ownership" : "Connect to prove"}
          </span>
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
      Nobody has proven a wallet yet, so there is no book to show. Press <strong>Prove ownership</strong> above and sign
      the challenge — one signature, no gas, no spender, no transfer. The desk layer recovers your address from it and
      shows the clients that are yours.
    </p>
  );
}
