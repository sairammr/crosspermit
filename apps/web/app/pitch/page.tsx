"use client";

/**
 * /pitch — the deck. Nine slides, three minutes.
 *
 * It opens on Permit2 rather than on us, because Permit2 is the thing every judge in the room has
 * already used and the thing CrossPermit is a strict extension of: same interface, same allowance
 * shape, one constraint removed. Arguing from there costs one slide and buys the whole premise.
 *
 * Every figure is one this repository actually produced — addresses and the shared domain
 * separator read off three chains, the v4 swap output, the Aave v4 thirty-day settlement. Nothing
 * is illustrative.
 */

import Link from "next/link";
import { useEffect, useRef } from "react";

import { CHAINS, CROSS_PERMIT } from "../../src/config";
import { DotText, HorseMatrix } from "../../src/dithergraph";
import "./pitch.css";

const DOMAIN_SEPARATOR = "0x4ce820a58ffb00fe1b6cb52f083bdd1cfd176732c34db34a84517668750aa5e4";
const SALT = "0xb2af67d67b308054b26d8fb210cab127bf699e936190ed01dd9052e7736d1c8c";
const REPO = "https://github.com/sairammr/crosspermit";

/** id, tick label. The rail is generated from this so a reordered deck cannot desync from it. */
const SLIDES = [
  ["s01", "Hook"],
  ["s02", "Permit2"],
  ["s03", "The cost"],
  ["s04", "Institutions"],
  ["s05", "CrossPermit"],
  ["s06", "One address"],
  ["s07", "Merkle root"],
  ["s08", "Spending it"],
  ["s09", "Demo"],
  ["s10", "Proof"],
  ["s11", "Ask"],
] as const;

/** Permit2, canonical, on every chain — and the reason its signature still cannot leave one. */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export default function Pitch() {
  const deck = useRef<HTMLDivElement>(null);

  // Keyboard drives the deck, and the rail marks where it is. Both are plain DOM: a presenter
  // pressing space should not be waiting on a React render to see the next slide.
  useEffect(() => {
    const el = deck.current;
    if (!el) return;

    const slides = () => Array.from(el.querySelectorAll<HTMLElement>(".slide"));

    /**
     * Scroll to a slide by index.
     *
     * The snap type is dropped for the duration of the scroll and put back after. Chrome refuses a
     * programmatic scroll out of a resting snap position while `scroll-snap-type` is `mandatory` —
     * `scrollTo`, `scrollIntoView` and a plain `scrollTop =` all put the element straight back to
     * where it was — so without this the arrow keys and the rail both silently do nothing. Snap is
     * restored once the scroll settles, which is what keeps the wheel feeling like a deck.
     */
    let settle: ReturnType<typeof setTimeout> | undefined;
    const scrollToSlide = (i: number) => {
      const list = slides();
      const target = list[Math.min(list.length - 1, Math.max(0, i))];
      if (!target) return;
      el.style.scrollSnapType = "none";
      el.scrollTo({ top: target.offsetTop, behavior: "smooth" });
      clearTimeout(settle);
      settle = setTimeout(() => {
        el.style.scrollSnapType = "";
      }, 700);
    };

    const currentIndex = () => {
      const list = slides();
      // The last slide whose top is at or above the viewport's own top, with a few pixels of slack
      // so a partly-settled smooth scroll does not read as the slide before.
      let i = 0;
      for (let k = list.length - 1; k >= 0; k--) {
        if (list[k].getBoundingClientRect().top <= 8) {
          i = k;
          break;
        }
      }
      return i;
    };

    const go = (dir: 1 | -1) => scrollToSlide(currentIndex() + dir);

    // The rail is anchors, and an anchor jump is a scroll like any other — so it is blocked by the
    // same snap rule and has to go through the same path.
    const onTick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>(".ticks a");
      if (!a) return;
      const id = a.getAttribute("href")?.slice(1);
      const i = slides().findIndex((sl) => sl.id === id);
      if (i < 0) return;
      e.preventDefault();
      scrollToSlide(i);
    };
    el.addEventListener("click", onTick);

    // One press is one slide. The guard is not cosmetic: a smooth scroll takes a few hundred ms, so
    // a second event arriving inside it reads the slide it started from and steps twice — and a
    // held-down arrow key repeats by design. A deck that skips a slide under the presenter is worse
    // than one that ignores a fast second press.
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const now = performance.now();
      if (now - last < 420) {
        if (["ArrowDown", "ArrowRight", "PageDown", " ", "ArrowUp", "ArrowLeft", "PageUp"].includes(e.key)) {
          e.preventDefault();
        }
        return;
      }
      last = now;
      if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(e.key)) {
        e.preventDefault();
        go(1);
      } else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(e.key)) {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);

    // rootMargin pulls the observation band to the middle of the screen, so the tick flips when a
    // slide owns the view rather than the instant its top edge appears.
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>(".ticks a"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const link = links.find((a) => a.getAttribute("href") === `#${entry.target.id}`);
          link?.setAttribute("data-current", String(entry.isIntersecting));
        }
      },
      { root: el, rootMargin: "-45% 0px -45% 0px" },
    );
    for (const s of slides()) io.observe(s);

    return () => {
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("click", onTick);
      clearTimeout(settle);
      io.disconnect();
    };
  }, []);

  return (
    <div className="lp deck" ref={deck}>
      <nav className="ticks" aria-label="Slides">
        {SLIDES.map(([id, label]) => (
          <a key={id} href={`#${id}`} title={label} aria-label={label} />
        ))}
      </nav>
      <div className="deck-cue" aria-hidden="true">
        <span>← →</span>
        <span>11 slides · 3 min</span>
      </div>

      {/* =============================================== 01 · HOOK */}
      <section className="slide" id="s01">
        <div className="wrapx deck-title">
          <HorseMatrix cols={22} size={120} />
          <span className="label">CrossPermit · {CHAINS.length} live testnets</span>
          <h1>One signature. Every chain.</h1>
          <p className="hook">Permit2 made approval a signature. It is still <b>one signature per chain</b>.</p>
        </div>
      </section>

      {/* =============================================== 02 · PERMIT2 */}
      <section className="slide ink" id="s02">
        <div className="wrapx">
          <div className="slide-head">
            <div className="slide-meta">
              <span className="label">02 / Where this starts</span>
              <span className="clock">0:15 — 0:40</span>
            </div>
            <h2>Permit2 is at the same address on every chain. Its signature still cannot leave one.</h2>
          </div>

          <div className="grid g2">
            <div className="steps">
              <div className="steprow">
                <span className="n">01</span>
                <div>
                  <h3>What Permit2 fixed</h3>
                  <p className="lede">One canonical contract holds the allowance: approve once, then grant by signature, with a cap and an expiry.</p>
                </div>
              </div>
              <div className="steprow">
                <span className="n">02</span>
                <div>
                  <h3>What it did not</h3>
                  <p className="lede">Its EIP-712 domain is built from <code>block.chainid</code>, so the digest is different on every chain.</p>
                </div>
              </div>
              <div className="steprow">
                <span className="n">03</span>
                <div>
                  <h3>So permission is the thing that does not travel</h3>
                  <p className="lede">Tokens bridge. Messages bridge. Authority does not.</p>
                </div>
              </div>
            </div>

            <div className="diagram" aria-label="Four wallet prompts versus one">
              <svg viewBox="0 0 520 296" role="img" style={{ minWidth: 430 }}>
                <title>Permit2 asks for one signature per chain; CrossPermit asks once</title>

                <text className="t sm" x="8" y="14">PERMIT2 — today</text>
                {["ETHEREUM", "BASE", "OPTIMISM", "ARBITRUM"].map((n, i) => (
                  <g key={n} transform={`translate(${i * 10}, ${i * 60})`}>
                    <rect className="bx" x="8" y="26" width="212" height="52" rx="5" />
                    <rect className="bx dk" x="8" y="26" width="212" height="17" rx="5" />
                    <text className="t sm on-dk" x="18" y="38">Signature request · {i + 1} of 4</text>
                    <text className="t" x="18" y="58">{n}</text>
                    <text className="t sm" x="18" y="72">domain = f(chainId) · own digest</text>
                    <rect className="bx" x="164" y="55" width="48" height="16" rx="3" />
                    <text className="t sm" x="172" y="67">Sign</text>
                  </g>
                ))}
                <text className="t sm" x="8" y="292">4 prompts · 4 audit lines · 4 revocations</text>

                <path className="wire dash" d="M262 20 V 276" />

                <text className="t sm" x="292" y="14">CROSSPERMIT</text>
                <rect className="bx sig" x="292" y="26" width="220" height="92" rx="5" />
                <rect className="bx dk" x="292" y="26" width="220" height="17" rx="5" />
                <text className="t sm on-dk" x="302" y="38">Signature request</text>
                <text className="t" x="302" y="60">ETHEREUM · BASE · OPTIMISM</text>
                <text className="t sm" x="302" y="76">one root, one digest, 65 bytes</text>
                <text className="t sm" x="302" y="90">cap, expiry and spender per chain</text>
                <rect className="bx" x="440" y="94" width="60" height="18" rx="3" />
                <text className="t sm" x="450" y="107">Sign once</text>

                <text className="t sm" x="292" y="146">1 prompt · 1 audit record</text>
                <text className="t sm" x="292" y="162">1 signature retracts it everywhere</text>
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* =============================================== 03 · THE COST */}
      <section className="slide" id="s03">
        <div className="wrapx">
          <div className="slide-head">
            <div className="slide-meta">
              <span className="label">03 / What that costs a desk</span>
              <span className="clock">0:40 — 0:55</span>
            </div>
            <h2>
              Fragmented permission fragments the book.
            </h2>
          </div>

          <div className="grid g4">
            <div className="mod statcard hot">
              <span className="label">Liquidity fragmentation</span>
              <h3 style={{ marginTop: 10 }}>Capital is pre-positioned, per chain</h3>
                  <p className="lede">Authority stops at the chain boundary, so every chain funds its own idle buffer.</p>
            </div>
            <div className="mod statcard">
              <span className="label">Revocation is a race</span>
              <h3 style={{ marginTop: 10 }}>N transactions, N gas markets</h3>
                  <p className="lede">Closing an exposure is one transaction per chain. The slowest chain sets the loss.</p>
            </div>
            <div className="mod statcard">
              <span className="label">Onboarding</span>
              <h3 style={{ marginTop: 10 }}>N wallet sessions per client</h3>
                  <p className="lede">Four approvals and four audit lines, for one agreement that was never per-chain.</p>
            </div>
            <div className="mod statcard">
              <span className="label">Bridges do not fix it</span>
              <h3 style={{ marginTop: 10 }}>They move tokens, not permission</h3>
                  <p className="lede">Moving collateral to the authority adds custody and latency. Move the authority instead.</p>
            </div>
          </div>
        </div>
      </section>

      {/* =============================================== 04 · WHY INSTITUTIONS */}
      <section className="slide ink" id="s04">
        <div className="wrapx">
          <div className="slide-head">
            <div className="slide-meta">
              <span className="label">04 / Who actually needs this</span>
              <span className="clock">0:55 — 1:10</span>
            </div>
            <h2>A fund cannot take custody, and cannot ask for a signature per chain per week.</h2>
          </div>

          <div className="grid g4">
            <div className="mod">
              <span className="label">Fiduciary</span>
              <h3 style={{ marginTop: 10 }}>Custody is the thing they must not take</h3>
                  <p className="lede">A desk-controlled wallet is a custody event. A bounded, revocable allowance is not.</p>
            </div>
            <div className="mod">
              <span className="label">Capital efficiency</span>
              <h3 style={{ marginTop: 10 }}>An idle buffer on every chain</h3>
                  <p className="lede">Capital has to sit where the authority already is, and the client pays for the dead weight.</p>
            </div>
            <div className="mod">
              <span className="label">Risk</span>
              <h3 style={{ marginTop: 10 }}>Revocation has to be one act</h3>
                  <p className="lede">Closed on two chains and open on two is the state nobody has a runbook for.</p>
            </div>
            <div className="mod">
              <span className="label">Audit</span>
              <h3 style={{ marginTop: 10 }}>One mandate, one record</h3>
                  <p className="lede">Compliance needs one auditable grant, not four explorers reconciled by hand.</p>
            </div>
          </div>
        </div>
      </section>

      {/* =============================================== 05 · CROSSPERMIT */}
      <section className="slide" id="s05">
        <div className="wrapx">
          <div className="slide-head">
            <div className="slide-meta">
              <span className="label">05 / The solution</span>
              <span className="clock">1:10 — 1:25</span>
            </div>
            <h2>CrossPermit is Permit2&apos;s interface with the chain constraint removed.</h2>
            <p className="lede">Same cap, expiry and spender. Same <code>transferFrom</code> selectors, so Uniswap&apos;s own router spends it unmodified.</p>
          </div>

          <div className="diagram" aria-label="CrossPermit system architecture">
            <svg viewBox="0 0 980 340" role="img">
              <title>One signature over a merkle root fans out to three chains through a relayer</title>
              <rect className="bx sig" x="8" y="96" width="132" height="66" rx="5" />
              <text className="t" x="24" y="122">
                CLIENT WALLET
              </text>
              <text className="t sm" x="24" y="140">
                signs 1 EIP-712 root
              </text>
              <text className="t sm" x="24" y="154">
                65 bytes, once
              </text>

              <rect className="bx" x="180" y="88" width="148" height="82" rx="5" />
              <text className="t" x="196" y="112">
                SDK (browser)
              </text>
              <text className="t sm" x="196" y="130">
                one bundle per chain
              </text>
              <text className="t sm" x="196" y="144">
                leaves → merkle root
              </text>
              <text className="t sm" x="196" y="158">
                proofs computed here
              </text>

              <rect className="bx dk" x="368" y="96" width="140" height="66" rx="5" />
              <text className="t on-dk" x="384" y="120">
                RELAYER
              </text>
              <text className="t sm" x="384" y="138" style={{ fill: "#a9a6a0" }}>
                1 POST → N chains
              </text>
              <text className="t sm" x="384" y="152" style={{ fill: "#a9a6a0" }}>
                gas only, no authority
              </text>

              {CHAINS.map((c, i) => (
                <g key={c.id}>
                  <rect className="bx" x="560" y={16 + i * 82} width="192" height="64" rx="5" />
                  <text className="t" x="576" y={40 + i * 82}>
                    {c.name.toUpperCase()}
                  </text>
                  <text className="t sm" x="576" y={58 + i * 82}>
                    CrossPermit, same address
                  </text>
                  <text className="t sm" x="576" y={72 + i * 82}>
                    leaf {i} + proof → root → signer
                  </text>
                </g>
              ))}

              <rect className="bx" x="800" y="16" width="172" height="64" rx="5" />
              <text className="t" x="816" y="40">
                UNIVERSAL ROUTER
              </text>
              <text className="t sm" x="816" y="58">
                permit2 := CrossPermit
              </text>
              <text className="t sm" x="816" y="72">
                real v4 swap
              </text>

              <rect className="bx" x="800" y="98" width="172" height="64" rx="5" />
              <text className="t" x="816" y="122">
                LIQUIDITY DESK
              </text>
              <text className="t sm" x="816" y="140">
                v4 PoolManager
              </text>
              <text className="t sm" x="816" y="154">
                position salt = client
              </text>

              <rect className="bx" x="800" y="180" width="172" height="64" rx="5" />
              <text className="t" x="816" y="204">
                TREASURY
              </text>
              <text className="t sm" x="816" y="222">
                Aave v4 · tokenized equity
              </text>

              {/* the merkle tree: what the one signature is actually over */}
              <text className="t sm" x="180" y="206">
                what is signed
              </text>
              {CHAINS.map((c, i) => (
                <g key={`leaf-${c.id}`}>
                  <rect className="bx" x="180" y={220 + i * 34} width="118" height="26" rx="4" />
                  <text className="t sm" x="190" y={237 + i * 34}>
                    leaf {i} · {c.name.split(" ")[0]}
                  </text>
                  <path className="wire" d={`M298 ${233 + i * 34} H 330`} />
                </g>
              ))}
              <path className="wire" d="M330 233 V 301" />
              <rect className="bx sig" x="330" y="240" width="110" height="26" rx="4" />
              <text className="t sm" x="340" y="257">
                H(pair) folded
              </text>
              <rect className="bx sig" x="452" y="240" width="96" height="26" rx="4" />
              <text className="t sm" x="462" y="257">
                merkle root
              </text>
              <path className="wire sig" d="M440 253 H452" />
              <path className="wire sig" d="M500 240 V 162" />
              <text className="t sm" x="560" y="246">
                the root is the signed object
              </text>
              <text className="t sm" x="560" y="262">
                chainId lives in the leaf, never in the signature
              </text>

              <path className="wire sig" d="M140 128 H180" />
              <path className="wire sig" d="M328 128 H368" />
              {CHAINS.map((c, i) => (
                <path key={c.id} className="wire sig" d={`M508 128 C 534 128, 534 ${48 + i * 82}, 560 ${48 + i * 82}`} />
              ))}
              <path className="wire" d="M752 48 H800" />
              <path className="wire" d="M752 130 H800" />
              <path className="wire" d="M752 212 H800" />
            </svg>
          </div>
        </div>
      </section>

      {/* =============================================== 06 · ONE ADDRESS */}
      <section className="slide ink" id="s06">
        <div className="wrapx">
          <div className="slide-head">
            <div className="slide-meta">
              <span className="label">06 / Why the signature travels</span>
              <span className="clock">reference</span>
            </div>
            <h2>Pin the domain. Prove the address. Merkle the rest.</h2>
          </div>

          <div className="grid g3">
            <div className="mod">
              <span className="label">01 · the domain</span>
              <h3 style={{ marginTop: 10 }}>
                <code>chainId = 1</code>, fixed
              </h3>
              <p className="lede">Safe only because <code>verifyingContract</code> is still in the domain, and is the same address everywhere.</p>
            </div>
            <div className="mod">
              <span className="label">02 · the address</span>
              <h3 style={{ marginTop: 10 }}>ERC-2470, same init code, same salt</h3>
                  <p className="lede">Optimism Sepolia was added later and landed on the same address, with no coordination.</p>
            </div>
            <div className="mod">
              <span className="label">03 · the payload</span>
              <h3 style={{ marginTop: 10 }}>A root over per-chain bundles</h3>
                  <p className="lede">Each chain verifies only its own leaf, and learns nothing about the others.</p>
            </div>
          </div>

          <div className="terminal" style={{ marginTop: 20 }}>
            <div className="dot-field">
              <HorseMatrix cols={24} tone="light" />
            </div>
            <span className="label">Read live off all {CHAINS.length} deployments</span>
            <div style={{ marginTop: 14, display: "grid", gap: 2 }}>
              <div className="kv">
                <span>CrossPermit</span>
                <span className="mono">{CROSS_PERMIT}</span>
              </div>
              <div className="kv">
                <span>DOMAIN_SEPARATOR()</span>
                <span className="mono" style={{ wordBreak: "break-all" }}>
                  {DOMAIN_SEPARATOR}
                </span>
              </div>
              <div className="kv">
                <span>salt</span>
                <span className="mono">keccak256(&quot;CrossPermit v1&quot;) · {SALT.slice(0, 14)}…</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* =============================================== 07 · THE MERKLE ROOT */}
      <section className="slide" id="s07">
        <div className="wrapx">
          <div className="slide-head">
            <div className="slide-meta">
              <span className="label">07 / What is actually signed</span>
              <span className="clock">reference</span>
            </div>
            <h2>One root. One proof per chain.</h2>
            <p className="lede">The signed object is a merkle root over per-chain permit bundles.</p>
          </div>

          <div className="grid g2">
            <div className="diagram" aria-label="Merkle bundle structure">
              <svg viewBox="0 0 560 300" role="img" style={{ minWidth: 460 }}>
                <title>Per-chain bundles hash to leaves, leaves fold into a left-leaning root</title>
                <rect className="bx sig" x="182" y="12" width="204" height="48" rx="5" />
                <text className="t" x="196" y="34">
                  SIGNED ROOT
                </text>
                <text className="t sm" x="196" y="50">
                  owner · salt · deadline · ts
                </text>

                <rect className="bx" x="104" y="104" width="130" height="36" rx="5" />
                <text className="t" x="118" y="127">
                  node(L0, L1)
                </text>

                <rect className="bx" x="8" y="192" width="150" height="76" rx="5" />
                <text className="t" x="22" y="214">
                  LEAF 0 · BASE
                </text>
                <text className="t sm" x="22" y="232">
                  approve router, cap
                </text>
                <text className="t sm" x="22" y="246">
                  approve desk, cap
                </text>
                <text className="t sm" x="22" y="260">
                  expiry
                </text>

                <rect className="bx" x="176" y="192" width="150" height="76" rx="5" />
                <text className="t" x="190" y="214">
                  LEAF 1 · OP
                </text>
                <text className="t sm" x="190" y="232">
                  approve router, cap
                </text>
                <text className="t sm" x="190" y="246">
                  transfer, amount
                </text>
                <text className="t sm" x="190" y="260">
                  expiry
                </text>

                <rect className="bx" x="344" y="192" width="208" height="76" rx="5" />
                <text className="t" x="358" y="214">
                  LEAF 2 · ETH SEPOLIA
                </text>
                <text className="t sm" x="358" y="232">
                  one hop from the root
                </text>
                <text className="t sm" x="358" y="246">
                  shortest proof
                </text>
                <text className="t sm" x="358" y="260">
                  put the dearest chain last
                </text>

                <path className="wire" d="M83 192 V 162 C 83 150, 95 140, 110 140" />
                <path className="wire" d="M251 192 V 162 C 251 150, 239 140, 228 140" />
                <path className="wire sig" d="M169 104 V 78 C 169 66, 200 60, 220 60" />
                <path className="wire sig" d="M448 192 V 90 C 448 72, 360 64, 340 60" />
              </svg>
            </div>

            <div className="steps">
              <div className="steprow">
                <span className="n">01</span>
                <div>
                  <h3>The leaf is computed client-side. Always.</h3>
                  <p className="lede">A leaf that arrived from an RPC would let the endpoint choose what the user signs.</p>
                </div>
              </div>
              <div className="steprow">
                <span className="n">02</span>
                <div>
                  <h3>Left-leaning tree, dearest chain last</h3>
                  <p className="lede">Sorted-pair hashing, so the verifier is OpenZeppelin <code>MerkleProof</code>. Last leaf, shortest proof.</p>
                </div>
              </div>
              <div className="steprow">
                <span className="n">03</span>
                <div>
                  <h3>Four modes in one entry shape</h3>
                  <p className="lede"><code>TRANSFER</code>, <code>DECREASE</code>, <code>LOCK</code>, <code>UNLOCK</code> — a grant and a kill switch are one structure.</p>
                </div>
              </div>
              <div className="steprow">
                <span className="n">04</span>
                <div>
                  <h3>Salt, deadline, and a timestamp set behind the clock</h3>
                  <p className="lede">A non-sequential nonce, signed at <code>now − 90s</code> so a stale head block cannot reject it.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* =============================================== 08 · SPENDING IT */}
      <section className="slide ink" id="s08">
        <div className="wrapx">
          <div className="slide-head">
            <div className="slide-meta">
              <span className="label">08 / How it gets spent</span>
              <span className="clock">1:25 — 1:40</span>
            </div>
            <h2>
              Uniswap&apos;s own router, one thing changed:{" "}
              <span className="mono" style={{ fontSize: "0.72em" }}>
                permit2 := CrossPermit
              </span>
            </h2>
          </div>

          <div className="grid g3">
            <div className="mod">
              <span className="label">Trade</span>
              <h3 style={{ marginTop: 10 }}>Uniswap v4 swap</h3>
                  <p className="lede">The allowance ends at zero and the router holds no plain ERC-20 approval.</p>
            </div>
            <div className="mod">
              <span className="label">Invest</span>
              <h3 style={{ marginTop: 10 }}>v4 liquidity, Aave v4, equities</h3>
                  <p className="lede"><code>add</code> pays both sides from the client&apos;s allowance; the position is keyed by their address.</p>
            </div>
            <div className="mod">
              <span className="label">The asymmetry</span>
              <h3 style={{ marginTop: 10 }}>In, never out</h3>
                  <p className="lede"><code>remove</code> and <code>collect</code> are <code>msg.sender</code>-scoped. The desk has nothing to sweep.</p>
            </div>
          </div>
        </div>
      </section>

      {/* =============================================== 09 · DEMO */}
      <section className="slide dense" id="s09">
        <div className="wrapx">
          <div className="slide-head">
            <div className="slide-meta">
              <span className="label">09 / Live demo</span>
              <span className="clock">1:40 — 2:25</span>
            </div>
            <h2>One client, onboarded and allocated, from one signature.</h2>
            <p className="lede">Live, against three testnets.</p>
          </div>

          <div className="mod">
            {[
              ["0:00", "Add a client, copy the link"],
              ["0:08", "They open it — every chain, spender and cap, before the wallet"],
              ["0:18", "They sign. Once."],
              ["0:24", "Three chains, three proofs, three explorer links"],
              ["0:34", "Allocate — a real v4 swap out of that allowance"],
              ["0:44", "One signature locks every chain — the same spend reverts"],
            ].map(([t, say]) => (
              <div className="beat" key={t}>
                <time>{t}</time>
                <div>
                  <p className="say">{say}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* =============================================== 10 · PROOF */}
      <section className="slide" id="s10">
        <div className="wrapx">
          <div className="slide-head">
            <div className="slide-meta">
              <span className="label">10 / Not a prototype</span>
              <span className="clock">2:25 — 2:40</span>
            </div>
            <h2>Deployed, and proved live.</h2>
            <p className="lede">Every figure below is one this repository produced. Nothing is illustrative.</p>
          </div>

          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Chain</th>
                  <th className="num">chainId</th>
                  <th>Universal Router · permit2 := CrossPermit</th>
                  <th>Domain</th>
                </tr>
              </thead>
              <tbody>
                {CHAINS.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="num">{c.id}</td>
                    <td>
                      <a href={`${c.explorer}/address/${c.router}`} target="_blank" rel="noreferrer">
                        {c.router}
                      </a>
                    </td>
                    <td>
                      <span className="tag ok">identical</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid g4" style={{ marginTop: 20 }}>
            <div className="stat">
              <div className="k">Lifecycle stages, live</div>
              <div className="v">8</div>
              <div className="n">authorize, spend, decrease, lock, unlock, cancel — one signature each, three chains each.</div>
            </div>
            <div className="stat">
              <div className="k">Onboarding checks</div>
              <div className="v">22</div>
              <div className="n">cap survives the round trip; a second claim on a link is refused; an unknown intent cannot bind.</div>
            </div>
            <div className="stat">
              <div className="k">v4 swap, every run</div>
              <div className="v">996,999</div>
              <div className="n">out for 1,000,000 in — the 0.3% fee, against Uniswap&apos;s live PoolManager.</div>
            </div>
            <div className="stat">
              <div className="k">Aave v4, 30 days</div>
              <div className="v">10,032.65</div>
              <div className="n">USDC out for 10,000 in, real Core Hub and MAIN Spoke.</div>
            </div>
          </div>
        </div>
      </section>

      {/* =============================================== 11 · ASK */}
      <section className="slide ink" id="s11">
        <div className="wrapx deck-title">
          <HorseMatrix cols={20} size={120} tone="light" />
          <span className="label">11 / Scale, and the ask</span>
          <h2>
            <DotText text="One signature. Every chain." size={32} />
          </h2>

          <div className="grid g3" style={{ marginTop: 4, textAlign: "left", width: "100%" }}>
            <div className="mod-flat">
              <span className="label">We need · 1</span>
              <h3 style={{ marginTop: 8 }}>Mainnet pilot</h3>
                  <p className="lede">One desk, one client, one chain pair, a capped mandate.</p>
            </div>
            <div className="mod-flat">
              <span className="label">We need · 2</span>
              <h3 style={{ marginTop: 8 }}>Audit of the core</h3>
                  <p className="lede">Four contracts and one signed type.</p>
            </div>
            <div className="mod-flat">
              <span className="label">We need · 3</span>
              <h3 style={{ marginTop: 8 }}>Indexer coverage</h3>
                  <p className="lede">A chain with no audit trail cannot carry a mandate.</p>
            </div>
          </div>

          <div className="row" style={{ justifyContent: "center", gap: 12, marginTop: 4 }}>
            <Link className="btn btn-action" href="/app">
              <span className="cap">Open the desk</span>
            </Link>
            <a className="btn btn-ghost" href={REPO} target="_blank" rel="noreferrer">
              <span className="cap">Read the code</span>
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
