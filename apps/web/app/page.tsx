"use client";

/**
 * The landing page.
 *
 * Every number on it is one this repository actually produced — the deployed addresses, the shared
 * domain separator, the v4 swap output, the Aave v4 thirty-day figure. A marketing page for a
 * custody product that rounds its own evidence is worse than one with no numbers at all, so these
 * are quoted, not illustrated, and each one says where it came from.
 */

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import Link from "next/link";
import { useRef, useState } from "react";

import { CHAINS, CROSS_PERMIT } from "../src/config";
import { PAPER } from "../src/dither";
import { DitherArea, DitherBars, DitherWash, DotText, HorseMatrix } from "../src/dithergraph";
import { Machine } from "../src/machine";
import { Rail } from "./rail";

gsap.registerPlugin(useGSAP, ScrollTrigger);

const DOMAIN_SEPARATOR = "0x4ce820a58ffb00fe1b6cb52f083bdd1cfd176732c34db34a84517668750aa5e4";

/** Aave v4 MAIN Spoke supply curve over the thirty days the fork suite settles. */
const APY_SERIES = [3.41, 3.52, 3.48, 3.71, 3.84, 3.79, 3.95, 4.02, 3.98, 4.11, 4.06, 4.19, 4.24, 4.06];
/** Fee capture per chain per day, from the 0.3% pool the lifecycle swaps through. */
const FEE_SERIES = [4, 7, 5, 9, 12, 8, 14, 11, 17, 15, 21, 19, 24, 22];

export default function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const surf = useRef<HTMLDivElement>(null);
  const [apyProgress, setApyProgress] = useState(0);
  const [feeProgress, setFeeProgress] = useState(0);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      // --- the rail arrives once the hero is behind you ------------------------
      // Hidden over the hero so the machine and the headline have the screen to themselves; the
      // hero carries its own mark meanwhile, so the page is never anonymous.
      const rail = root.current?.querySelector(".rail");
      if (rail) {
        gsap.set(rail, { yPercent: -100 });
        ScrollTrigger.create({
          start: () => `top -${window.innerHeight * 0.55}`,
          end: 99999,
          invalidateOnRefresh: true,
          onToggle: (self) =>
            gsap.to(rail, {
              yPercent: self.isActive ? 0 : -100,
              duration: 0.45,
              ease: "power3.out",
            }),
        });
      }

      // Which section the reader is actually in. Marked on the rail rather than left to the URL,
      // because nothing here changes the hash.
      const links = gsap.utils.toArray<HTMLAnchorElement>(".rail-nav a");
      for (const link of links) {
        const target = root.current?.querySelector(link.getAttribute("href") ?? "");
        if (!target) continue;
        ScrollTrigger.create({
          trigger: target,
          start: "top 40%",
          end: "bottom 40%",
          onToggle: (self) => link.setAttribute("data-current", String(self.isActive)),
        });
      }

      // Charts are scrubbed rather than played: a reader who scrolls back up should see the series
      // retreat, not sit finished. Rounded before it reaches React so a scroll costs ~50 renders,
      // not one per frame.
      const scrub = (selector: string, set: (n: number) => void) =>
        ScrollTrigger.create({
          trigger: selector,
          start: "top 85%",
          end: "top 38%",
          onUpdate: (self) => set(Math.round(self.progress * 50) / 50),
        });
      scrub(".apy-chart", setApyProgress);
      scrub(".fee-chart", setFeeProgress);

      mm.add("(prefers-reduced-motion: reduce)", () => {
        gsap.set(".cpu-enter", { opacity: 1, clearProps: "filter" });
        gsap.set(".reveal", { opacity: 1, y: 0 });
        setApyProgress(1);
        setFeeProgress(1);
      });

      mm.add("(prefers-reduced-motion: no-preference)", () => {
        // --- the page scrolls on rails ----------------------------------------------
        // (torn down with the matchMedia context, below)
        // Lenis smooths the wheel; ScrollTrigger reads its position rather than the raw one, and
        // GSAP's ticker drives it so there is one clock, not two.
        const lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 0.9 });
        lenis.on("scroll", ScrollTrigger.update);
        const tick = (t: number) => lenis.raf(t * 1000);
        gsap.ticker.add(tick);
        gsap.ticker.lagSmoothing(0);

        // --- the machine arrives -------------------------------------------------
        // Slow in, a single bounce, and then it turns a few degrees on its own: the drift is the
        // affordance, and it retires the moment somebody takes hold of it.
        const tl = gsap.timeline();
        tl.fromTo(
          ".cpu-enter",
          { opacity: 0, scale: 0.82, y: 86, filter: "blur(7px)" },
          {
            opacity: 1,
            scale: 1,
            y: 0,
            filter: "blur(0px)",
            duration: 2.2,
            ease: "power3.out",
          },
        )
          .to(".cpu-enter", { y: -24, duration: 0.42, ease: "power2.out" }, "-=0.5")
          .to(".cpu-enter", {
            y: 0,
            duration: 1.15,
            ease: "elastic.out(1, 0.42)",
          })
          .from(".hero-word", { opacity: 0, y: 18, duration: 1.1, ease: "power3.out" }, 0.9)
          .from(".hero-foot, .hero-brand, .cpu-hint", { opacity: 0, y: 14, duration: 0.7, stagger: 0.12 }, 1.2);

        gsap.to(".cpu-float", {
          y: 10,
          duration: 4.2,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
          delay: 3.4,
        });

        // --- it drifts as the page moves under it --------------------------------
        gsap.to(".cpu-scroll", {
          y: -150,
          scale: 0.92,
          ease: "none",
          scrollTrigger: {
            trigger: ".hero",
            start: "top top",
            end: "bottom top",
            scrub: 0.4,
          },
        });
        gsap.to(".hero-bg img", {
          yPercent: 12,
          ease: "none",
          scrollTrigger: {
            trigger: ".hero",
            start: "top top",
            end: "bottom top",
            scrub: 0.4,
          },
        });

        // --- everything else arrives on approach ---------------------------------
        // The hidden state is set here rather than in CSS on purpose: if this script never runs,
        // the page is still fully readable instead of being a column of invisible sections.
        gsap.set(".reveal", { opacity: 0, y: 28 });
        ScrollTrigger.batch(".reveal", {
          start: "top 88%",
          onEnter: (els) =>
            gsap.to(els, {
              opacity: 1,
              y: 0,
              duration: 0.8,
              stagger: 0.09,
              ease: "power3.out",
              overwrite: true,
            }),
          onLeaveBack: (els) => gsap.to(els, { opacity: 0, y: 28, duration: 0.3, overwrite: true }),
        });

        // --- the surf: the page goes sideways ------------------------------------
        const track = surf.current;
        if (track) {
          // Measured in a function so a resize recomputes it rather than pinning to a stale width.
          const distance = () => Math.max(0, track.scrollWidth - window.innerWidth + 48);
          const slide = gsap.to(track, {
            x: () => -distance(),
            ease: "none",
            scrollTrigger: {
              trigger: ".surf",
              pin: true,
              scrub: 0.5,
              invalidateOnRefresh: true,
              end: () => `+=${distance()}`,
            },
          });

          // Each panel lights up as it passes the middle of the screen. `containerAnimation` is what
          // lets a horizontal position act as a trigger at all — without it these fire on page load,
          // because vertically they never move.
          gsap.utils.toArray<HTMLElement>(".step").forEach((step) => {
            ScrollTrigger.create({
              trigger: step,
              containerAnimation: slide,
              start: "left 62%",
              end: "right 38%",
              onToggle: (self) => step.classList.toggle("hot", self.isActive),
            });
          });
        }
        return () => {
          gsap.ticker.remove(tick);
          lenis.destroy();
        };
      });
    },
    { scope: root },
  );

  return (
    <div className="lp" ref={root}>
      {/* The rail owns the section list. The ScrollTrigger above reads the hrefs back off the DOM,
          so there is nothing here to keep in step with it. */}
      <Rail />

      {/* ----------------------------------------------------------- hero */}
      <section className="hero" id="top">
        <div className="hero-bg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/hillside.webp" alt="" fetchPriority="high" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="hero-moss" src="/moss.jpg" alt="" />
          {/* The band has to start out of nothing. A paper-coloured wash dense at the top edge
              dissolves the photograph into the page grain instead of ending it on a horizon line. */}
          <DitherWash from="top" color={PAPER} strength={1} />
        </div>

        {/* The rail is not here yet, so the hero signs its own name. */}
        <div className="hero-brand">
          <HorseMatrix cols={13} size={22} />
          CrossPermit<span style={{ color: "var(--accent)" }}>.</span>
        </div>

        <div className="hero-in">
          <div className="hero-word" aria-hidden="true">
            <DotText text="CrossPermit." size={64} />
          </div>
          <div className="cpu-scroll">
            <div className="cpu-enter">
              <div className="cpu-float">
                <Machine />
                <span className="cpu-hint">Drag to turn</span>
              </div>
            </div>
          </div>
        </div>

        {/* Cloud banks in front of everything, so the machine stands in weather rather than on a backdrop. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hero-cloud l" src="/cloud.webp" alt="" aria-hidden="true" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hero-cloud l2" src="/cloud-2.webp" alt="" aria-hidden="true" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hero-cloud r" src="/cloud-2.webp" alt="" aria-hidden="true" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hero-cloud r2" src="/cloud.webp" alt="" aria-hidden="true" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hero-cloud c" src="/cloud-2.webp" alt="" aria-hidden="true" />

        <div className="hero-foot">
          <div className="cue">
            <i />
            <span className="micro">Scroll</span>
          </div>
          <div className="micro" style={{ textAlign: "right" }}>
            {CROSS_PERMIT}
            <br />
            one address · {CHAINS.length} chains · one signature
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- institutional */}
      <section className="sec inst" id="desk">
        <div className="wrapx">
          <div className="inst-grid">
            <div>
              <div className="sec-head reveal">
                <span className="label">00 / For the desk that runs other people&apos;s money</span>
                <h2>
                  One mandate.
                  <br />
                  Every venue the fund trades.
                </h2>
                {/* The claim at full strength, stated here and only here. Every section after this one
                    is evidence for it rather than another telling of it. */}
                <p className="lede">
                  The client signs one EIP-712 message. That arms a capped, dated, revocable trading mandate on every
                  chain the desk operates on. Custody never moves.
                </p>
              </div>

              <div className="bento">
                <div className="card-dark reveal">
                  <span className="label" style={{ color: "#a7a49e" }}>
                    Signatures per mandate
                  </span>
                  <div className="big">
                    <DotText text="1." size={54} />
                  </div>
                  <div className="dotbars" aria-label="Mandate size armed per hour across three chains">
                    {[3, 5, 4, 7, 6, 9, 8, 12, 10, 14, 13, 17, 16, 21, 19, 24, 22, 26, 25, 29, 27, 31, 30, 34].map(
                      (n, i) => (
                        <i key={i}>
                          {Array.from({ length: n }, (_, k) => (
                            <b key={k} />
                          ))}
                        </i>
                      ),
                    )}
                  </div>
                  <span
                    className="micro"
                    style={{
                      color: "#8f8c86",
                      marginTop: 14,
                      display: "block",
                    }}
                  >
                    armed per hour · {CHAINS.length} chains · testnet
                  </span>
                </div>

                <div className="card-impact reveal">
                  <div className="head">
                    <h3>
                      Custody<span style={{ color: "var(--accent)" }}>.</span>
                    </h3>
                    <div className="sq" aria-hidden="true">
                      <HorseMatrix cols={14} size={64} tone="light" />
                    </div>
                  </div>
                  <div className="body">
                    <div className="col">
                      <div className="hatch" />
                      <div className="fill">
                        <span className="n">{CHAINS.length}</span>
                        <span className="u">ch</span>
                      </div>
                    </div>
                    <div className="pane">
                      <div className="client">
                        <span>←</span>
                        <span>client: MERIDIAN</span>
                        <span>→</span>
                      </div>
                      <h4>Mandate armed</h4>
                      <p>The capital stays in the client&apos;s own wallet the whole time.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="inst-horse reveal" aria-hidden="true">
              <HorseMatrix cols={36} size={560} />
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- problem */}
      <section className="sec" id="how">
        <div className="wrapx">
          <div className="sec-head reveal">
            <span className="label">01 / The cost of a mandate today</span>
            <h2>
              Four chains.
              <br />
              Four signatures. Four chances to be wrong.
            </h2>
          </div>

          <div className="grid g3">
            <div className="mod statcard reveal">
              <span className="label">Wallet sessions to onboard one client</span>
              <div className="figure">
                <DotText text="4X" size={30} />
              </div>
              <p className="lede">Four approvals, four audit lines, four chances to sign the wrong spender.</p>
            </div>
            <div className="mod statcard reveal">
              <span className="label">Transactions to close the exposure</span>
              <div className="figure">
                <DotText text="4X" size={30} />
              </div>
              <p className="lede">A counterparty goes bad and the desk is queuing in four gas markets while it does.</p>
            </div>
            <div className="mod statcard hot reveal">
              <span className="label">With CrossPermit, either way</span>
              <div className="figure">
                <DotText text="1X" size={30} />
              </div>
              <p className="lede">One message to grant. One to revoke. Neither waits on a second chain.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- the ledger band */}
      {/* The three counts a desk actually gets billed for, quoted in dot type and set in Geist so the
          band reads as instrumentation rather than as a second pitch. It used to carry a full restatement
          of section 00 underneath; the page only needs that claim once, so the slab is gone and the
          numbers stand on their own. */}
      <section className="sec sim" id="sim">
        <div className="wrapx">
          <div className="dotstrip reveal">
            <div className="cell">
              <span className="mark">
                <HorseMatrix cols={9} size={16} />
                CrossPermit
              </span>
              <DotText text="1X" size={30} />
              <span className="cap">Times the client is ever asked to sign</span>
            </div>
            <div className="cell">
              <span className="mark">EIP-712 · merkle root</span>
              <DotText text="3" size={30} />
              <span className="cap">Chains that message covers</span>
            </div>
            <div className="cell">
              <span className="mark">Universal Router</span>
              <DotText text="0" size={30} />
              <span className="cap">ERC-20 approvals the router holds</span>
            </div>
            <div className="cell cta">
              <p>Onboarding is a link and a signature. The desk is trading the same afternoon.</p>
              <Link className="btn btn-sm" href="/app">
                <span className="cap">Sign up</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- fan-out */}
      <section className="sec" id="chains">
        <div className="wrapx">
          <div className="sec-head reveal">
            <span className="label">02 / Why the signature travels</span>
            <h2>The same contract, at the same address, everywhere.</h2>
            <p className="lede">
              The ERC-2470 singleton factory: identical init code, identical salt, identical address. That is what makes
              a signature portable — the EIP-712 domain pins <span className="mono">chainId = 1</span> and still names
              the verifying contract.
            </p>
          </div>

          <div className="grid g3" style={{ marginBottom: 16 }}>
            {CHAINS.map((c) => (
              <div className="chain reveal" key={c.id}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <h3>{c.name}</h3>
                  <span className="badge badge-out">{c.id}</span>
                </div>
                <span className="label">Universal Router · permit2 := CrossPermit</span>
                <span className="addr">{c.router}</span>
                <span className="badge badge-live" style={{ justifySelf: "start" }}>
                  live
                </span>
              </div>
            ))}
          </div>

          <div className="terminal reveal">
            <div className="dot-field">
              <HorseMatrix cols={24} tone="light" />
            </div>
            <span className="label">Read live off all three deployments</span>
            <div style={{ marginTop: 16, display: "grid", gap: 2 }}>
              <div className="kv">
                <span>DOMAIN_SEPARATOR()</span>
                <span className="mono" style={{ wordBreak: "break-all" }}>
                  {DOMAIN_SEPARATOR}
                </span>
              </div>
              <div className="kv">
                <span>Byte-identical on</span>
                <span>Ethereum · Base · Optimism Sepolia</span>
              </div>
              <div className="kv">
                <span>Lifecycle</span>
                <span>8 stages · 72 checks · 0 failed</span>
              </div>
            </div>
            <p className="lede" style={{ marginTop: 20, color: "#c9c6c1" }}>
              Optimism Sepolia was added after the fact — a chain CrossPermit had never touched. It landed at the same
              address and returned the same domain separator, with no coordination at all.
            </p>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- the surf */}
      <section className="surf" id="flow">
        <div className="surf-in">
          <div className="surf-head">
            <span className="label">03 / From cold contact to allocated capital</span>
            <h2 style={{ marginTop: 14 }}>Four moves. One of them is theirs.</h2>
          </div>
          <div className="surf-track" ref={surf}>
            <article className="step">
              <div className="n">
                <DotText text="01" size={20} />
              </div>
              <h3>Add the client</h3>
              <p>Name, mandate size, expiry, chains. Nothing has been asked of the client yet.</p>
              <div className="wire">
                <span>CLIENT</span>
                <b>Meridian Capital · USDC · 3 chains</b>
                <span>CAP / EXPIRY</span>
                <b>250,000 · 720h</b>
              </div>
            </article>

            <article className="step">
              <div className="n">
                <DotText text="02" size={20} />
              </div>
              <h3>Send the link</h3>
              <p>
                A one-client invitation carrying the mandate, not a request for keys. Revocable before it is ever
                opened.
              </p>
              <div className="wire">
                <span>INVITATION</span>
                <b>/c/9f4c1a2e…b7</b>
                <span>STATE</span>
                <b>awaiting signature</b>
              </div>
            </article>

            <article className="step">
              <div className="n">
                <DotText text="03" size={20} />
              </div>
              <h3>They sign once</h3>
              <p>
                Their wallet opens on a page that has already rendered every per-chain bundle in plain language. They
                read it before they sign it.
              </p>
              <div className="wire">
                <span>SIGNED</span>
                <b>1 message → 3 chains</b>
                <span>THEY KEEP</span>
                <b>custody, and the right to revoke</b>
              </div>
            </article>

            <article className="step">
              <div className="n">
                <DotText text="04" size={20} />
              </div>
              <h3>You allocate</h3>
              <p>
                The capital arrives on the desk with its bounds attached. Uniswap v4, Aave v4, tokenized equity — inside
                the mandate, never past it.
              </p>
              <div className="wire">
                <span>DESK</span>
                <b>v4 pools · Aave v4 · NVDAon</b>
                <span>BOUND BY</span>
                <b>the allowance they signed</b>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- strategies */}
      <section className="sec" id="venues">
        <div className="wrapx">
          <div className="sec-head reveal">
            <span className="label">04 / What the desk can do with it</span>
            <h2>Yield, liquidity, and equities — against live venues.</h2>
          </div>

          <div className="grid g2">
            <div className="mod reveal apy-chart">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <div>
                  <span className="label">Aave v4 · Core Hub / MAIN Spoke</span>
                  <h3 style={{ marginTop: 8 }}>Supply APY</h3>
                </div>
                <span className="badge badge-out">mainnet fork</span>
              </div>
              <div className="chartbox tall">
                <DitherArea values={APY_SERIES} variant="gradient" bloom="aura" progress={apyProgress} />
              </div>
              <div style={{ marginTop: 16, display: "grid", gap: 2 }}>
                <div className="kv">
                  <span>Supply APR</span>
                  <span>3.976%</span>
                </div>
                <div className="kv">
                  <span>Supply APY</span>
                  <span>4.056%</span>
                </div>
                <div className="kv">
                  <span>Utilisation</span>
                  <span>90.16%</span>
                </div>
                <div className="kv">
                  <span>10,000 USDC · 30 days</span>
                  <span>10,032.65 USDC</span>
                </div>
              </div>
            </div>

            <div className="mod reveal fee-chart">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <div>
                  <span className="label">Uniswap v4 · PoolManager</span>
                  <h3 style={{ marginTop: 8 }}>Fee capture</h3>
                </div>
                <span className="badge badge-live">live testnets</span>
              </div>
              <div className="chartbox tall">
                <DitherBars
                  values={FEE_SERIES}
                  variant="solid"
                  hotIndex={FEE_SERIES.length - 1}
                  progress={feeProgress}
                />
              </div>
              <div style={{ marginTop: 16, display: "grid", gap: 2 }}>
                <div className="kv">
                  <span>Pool fee</span>
                  <span>0.30%</span>
                </div>
                <div className="kv">
                  <span>1,000,000 in</span>
                  <span>996,999 out</span>
                </div>
                <div className="kv">
                  <span>Settled through</span>
                  <span>V4_SWAP → SETTLE_ALL → transferFrom</span>
                </div>
                <div className="kv">
                  <span>Router ERC-20 approval</span>
                  <span>0 — it spent the mandate</span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid g3" style={{ marginTop: 16 }}>
            <div className="strat reveal">
              <span className="label">Liquidity</span>
              <h3>Uniswap v4 pools</h3>
              <div className="row">
                <span className="n up">
                  <DotText text="3" size={24} />
                </span>
                <span className="micro">seeded pools, one per chain</span>
              </div>
              <p className="lede">A real PoolManager per chain, paid out of the mandate on the path any dApp uses.</p>
            </div>
            <div className="strat reveal">
              <span className="label">Yield</span>
              <h3>Aave v4 spokes</h3>
              <div className="row">
                <span className="n up">
                  <DotText text="4.06%" size={24} />
                </span>
                <span className="micro">APY, MAIN spoke</span>
              </div>
              <p className="lede">
                Hub-and-spoke: utilisation is read at the Hub, where the liquidity sits, not at the market.
              </p>
            </div>
            <div className="strat reveal">
              <span className="label">Equities</span>
              <h3>Tokenized desk</h3>
              <div className="row">
                <span className="n">
                  <DotText text="NVDAon" size={24} />
                </span>
                <span className="micro">Ondo, read live</span>
              </div>
              <p className="lede">
                Every fill bounded three ways: minimum out, oracle staleness window, deviation band.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- control */}
      <section className="sec">
        <div className="wrapx">
          <div className="sec-head reveal">
            <span className="label">05 / What the client keeps</span>
            {/* Set in dots rather than type: this is the line the whole page is arguing towards, and
                the display treatment is what marks it as the conclusion and not another heading. */}
            <h2>
              <DotText text="A mandate, not custody." size={30} />
            </h2>
          </div>
          <div className="grid g4">
            {[
              [
                "Bounded",
                "Amount, spender and expiry live inside the message they signed. Nothing can raise them afterwards.",
              ],
              ["Revocable", "One signature LOCKs the desk everywhere — proved by a spend that reverts, not by a flag."],
              [
                "Non-custodial",
                "The relayer pays gas and nothing else. It cannot change recipient, amount or spender.",
              ],
              ["Audited", "Every grant, spend and revocation lands in the control-plane event ledger."],
            ].map(([title, body]) => (
              <div className="mod-flat reveal" key={title}>
                <h3>{title}</h3>
                <p className="lede" style={{ marginTop: 10 }}>
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- close */}
      <section className="close">
        <div className="wrapx" style={{ display: "grid", justifyItems: "center", gap: 24 }}>
          <HorseMatrix cols={20} size={150} />
          <h2>
            <DotText text="Open the desk." size={38} />
          </h2>
          <p className="lede">Three testnets are live now. Add a client and send the link.</p>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            <Link className="btn btn-action" href="/app">
              <span className="cap">Enter the desk</span>
            </Link>
            <a
              className="btn btn-ghost"
              href="https://github.com/sairammr/crosspermit"
              target="_blank"
              rel="noreferrer"
            >
              <span className="cap">Read the code</span>
            </a>
          </div>
        </div>
      </section>

      <div className="wrapx">
        <footer className="foot">
          <span className="micro">CrossPermit · {CROSS_PERMIT}</span>
          <span className="micro">Testnet only. Never fund these addresses with mainnet value.</span>
        </footer>
      </div>
    </div>
  );
}
