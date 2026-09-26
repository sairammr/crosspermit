import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";

import { Providers } from "./providers";
import "./globals.css";
import "./landing.css";

// The design system is Archivo for UI and IBM Plex Mono wherever numbers live. Self-hosted through
// next/font so the page does not depend on a third-party origin being up to render its own type.
const ui = Archivo({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-ui" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "CrossPermit — one signature, every chain",
  description:
    "Run a fund across every chain. Add a client, send a link, and one signature gives the desk a bounded, revocable mandate on every chain you trade.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
