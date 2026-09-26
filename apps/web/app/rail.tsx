"use client";

/**
 * The top rail: a brandmark, a bank of station-preset keys, and the one action.
 *
 * The nav is the same moulded-cap key as `.btn`, only smaller and latching — the section you are
 * in stays sunk in its skirt the way an FM preset stays down until another is pushed. GSAP in
 * page.tsx owns which one that is: it queries `.rail-nav a` and writes `data-current`, so the
 * anchors stay plain anchors and every state below hangs off that attribute.
 */

import Link from "next/link";

import { HorseMatrix } from "../src/dithergraph";

const NAV = [
  ["#how", "The problem"],
  ["#chains", "One address"],
  ["#flow", "Onboarding"],
  ["#venues", "Strategies"],
] as const;

export function Rail({ items = NAV }: { items?: readonly (readonly [string, string])[] }) {
  return (
    <header className="rail">
      <div className="rail-in">
        <a className="brandmark" href="#top" style={{ textDecoration: "none" }}>
          <HorseMatrix cols={13} size={22} />
          CrossPermit<span style={{ color: "var(--accent)" }}>.</span>
        </a>
        {/* The tray is what joins four keys into one bank; without it they read as loose buttons. */}
        <div className="railkeys">
          <nav className="rail-nav" aria-label="Sections">
            {items.map(([href, label]) => (
              <a key={href} href={href}>
                <span className="cap">{label}</span>
              </a>
            ))}
          </nav>
        </div>
        <Link className="btn btn-action" href="/app">
          <span className="cap">Enter the desk</span>
        </Link>
      </div>
    </header>
  );
}

export default Rail;
