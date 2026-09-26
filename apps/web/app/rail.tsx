"use client";

/**
 * The rail: a floating row of console keys, and nothing else.
 *
 * There is no bar and no plate. Each key is the block key from the console reference — a cap on a
 * fixed skirt, where the skirt never moves and only the cap travels — so the row reads as hardware
 * lying on the page rather than as chrome drawn over it.
 *
 * One component for the whole product. The landing takes the floating variant, where the row is
 * centred over the page and GSAP parks it off the top until the hero is behind you; the desk and
 * the client screens take the inline variant, where the same key bank sits at the top of the wrap
 * with the brandmark on its left and the wallet on its right. A desk tab and a landing section are
 * the same object here — a key that is held down — so they are one part with one set of states.
 *
 * Which key is held is never decided in here. On the landing, GSAP in page.tsx queries `.rail-nav a`
 * and writes `data-current`; on the desk, the page passes `current` because it already owns the tab
 * state. Either way every state in rail.css hangs off that one attribute.
 */

import Link from "next/link";
import type { ReactNode } from "react";

export type RailItem = {
  /** React key, and the value a desk page switches on. */
  key: string;
  label: string;
  /** An anchor when given, a button when not. The landing links; the desk switches a tab. */
  href?: string;
  onClick?: () => void;
  current?: boolean;
};

const NAV: RailItem[] = [
  { key: "how", label: "The cost", href: "#how" },
  { key: "chains", label: "One address", href: "#chains" },
  { key: "flow", label: "Onboarding", href: "#flow" },
  { key: "venues", label: "Allocation", href: "#venues" },
];

export function Rail({
  items = NAV,
  go = { href: "/app", label: "Enter the desk" },
  brand,
  aside,
  variant = "float",
}: {
  items?: readonly RailItem[];
  /** The signal face: one per screen, and it is the key that leaves the page. Pass null to omit. */
  go?: { href: string; label: string } | null;
  /** Left of the keys, inside the housing. The desk puts its brandmark here. */
  brand?: ReactNode;
  /** Right of the keys, inside the housing. The desk puts the wallet here. */
  aside?: ReactNode;
  variant?: "float" | "inline";
}) {
  return (
    <header className={`rail rail--${variant}`}>
      <div className="railkeys">
        {brand ? <div className="railbrand">{brand}</div> : null}

        {items.length > 0 ? (
          <nav className="rail-nav" aria-label="Sections">
            {items.map((it) =>
              it.href ? (
                <a key={it.key} href={it.href} data-current={it.current ? "true" : undefined}>
                  <span className="cap">{it.label}</span>
                </a>
              ) : (
                <button
                  key={it.key}
                  type="button"
                  onClick={it.onClick}
                  aria-current={it.current ? "page" : undefined}
                  data-current={it.current ? "true" : undefined}
                >
                  <span className="cap">{it.label}</span>
                </button>
              ),
            )}
          </nav>
        ) : null}

        {go ? (
          <Link className="railgo" href={go.href}>
            <span className="cap">{go.label}</span>
          </Link>
        ) : null}

        {aside ? <div className="railaside">{aside}</div> : null}
      </div>
    </header>
  );
}

export default Rail;
