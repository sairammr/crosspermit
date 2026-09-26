"use client";

/**
 * The desk shell: one sidebar, one content column, on every screen inside /app.
 *
 * The desk used to be eight tabs over a single wrap, and seven of them were views onto the
 * machinery — the relayer, the treasury reader, the audit trail, a self-serve signing form. A
 * manager does not arrive for machinery. They arrive for a client, so the shell carries the book
 * and nothing else: the client list is the navigation, and a client's own page is the destination.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { HorseMatrix } from "../../src/dithergraph";
import { CROSS_PERMIT } from "../../src/config";
import { type ClientMandate } from "../../src/clients";
import { ProveOwnership } from "../../src/session-ui";

import "./shell.css";

const short = (s: string, n = 6) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

export function Shell({
  clients,
  current,
  title,
  meta,
  actions,
  onSession,
  children,
}: {
  /** The book, for the nav. `null` while loading, `false` when the desk layer will not answer. */
  clients: ClientMandate[] | null | false;
  /** Which nav row is held: "clients" for the book, or a client token. */
  current: string;
  title: string;
  /** One line under the title: what this screen is showing and whose it is. */
  meta?: ReactNode;
  actions?: ReactNode;
  onSession?: () => void;
  children: ReactNode;
}) {
  const book = Array.isArray(clients) ? clients.filter((c) => c.status !== "revoked") : [];

  return (
    <div className="shell">
      <aside className="sb">
        <Link className="sb-brand" href="/">
          <HorseMatrix cols={20} size={22} tone="light" />
          CrossPermit
        </Link>

        <nav className="sb-nav" aria-label="Desk">
          <span className="sb-group">Book</span>
          <Link className="sb-item" href="/app" data-current={current === "clients" ? "true" : undefined}>
            <span>Clients</span>
            {Array.isArray(clients) && <em>{clients.length}</em>}
          </Link>

          {book.length > 0 && (
            <>
              <span className="sb-group">Portfolios</span>
              {book.map((c) => (
                <Link
                  key={c.token}
                  className="sb-item sb-client"
                  href={`/app/client/${c.token}`}
                  data-current={current === c.token ? "true" : undefined}
                >
                  <span>{c.name}</span>
                  <i className={`sb-dot ${c.status}`} title={c.status} />
                </Link>
              ))}
            </>
          )}
        </nav>

        <div className="sb-foot">
          <span className="micro">CrossPermit {short(CROSS_PERMIT, 6)}</span>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <div className="topbar-t">
            <h1>{title}</h1>
            {meta && <span className="micro">{meta}</span>}
          </div>
          <div className="topbar-a">
            {actions}
            <ProveOwnership onChange={() => onSession?.()} />
          </div>
        </header>

        <div className="shell-body">{children}</div>
      </div>
    </div>
  );
}

export default Shell;
