import type { Metadata } from "next";
import { Archivo, Geist, IBM_Plex_Mono } from "next/font/google";

import { Providers } from "./providers";
import "./globals.css";
import "./landing.css";
// After landing.css on purpose: the rail's key bank supersedes the plain-link rail rules that file
// still carries, and a later import is what settles that without either file having to shout.
import "./rail.css";

// The design system is Archivo for UI and IBM Plex Mono wherever numbers live. Self-hosted through
// next/font so the page does not depend on a third-party origin being up to render its own type.
const ui = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-ui",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});
// Geist is the screen grotesque the product band is set in: tighter and more neutral than Archivo,
// so a slab of explanatory copy reads as an interface rather than as a poster.
// No `weight`: Geist ships on Google Fonts as a variable font only, so naming static cuts asks for
// files that are not there — next/font then parses an empty response and fails the build. Omitting
// it takes the variable axis, which covers every weight the band uses.
const screen = Geist({
  subsets: ["latin"],
  variable: "--font-screen",
});

export const metadata: Metadata = {
  title: "CrossPermit — one signature, every chain",
  description:
    "Run a fund across every chain. Add a client, send a link, and one signature gives the desk a bounded, revocable mandate on every chain you trade.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable} ${screen.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
