"use client";

/**
 * Dithered chart primitives, drawn on the engine in `dither.ts`.
 *
 * Every one of them takes a `progress` so a scroll position can draw it in. That is deliberate:
 * the entrance is the caller's business, not the chart's, and a chart that owns its own animation
 * cannot be scrubbed backwards by a ScrollTrigger.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type Bloom,
  type Density,
  INK,
  type Rgb,
  SIGNAL,
  type Variant,
  bloomStrength,
  horseCells,
  paintDither,
  prepare,
  variantDensity,
} from "./dither";

/** Sizes to the parent box and repaints on resize or prop change. */
function useDitherCanvas(draw: (img: ImageData, w: number, h: number, dpr: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const paint = useCallback(() => {
    const canvas = ref.current;
    const box = canvas?.parentElement;
    if (!canvas || !box) return;
    const { clientWidth: w, clientHeight: h } = box;
    if (w === 0 || h === 0) return;
    const p = prepare(canvas, w, h);
    if (!p) return;
    drawRef.current(p.img, p.img.width, p.img.height, p.dpr);
    p.ctx.putImageData(p.img, 0, 0);
  }, []);

  // Two effects, not one. Painting has to happen on every render because the props that shape the
  // drawing change; observing does not, and folding them together tears down and rebuilds a
  // ResizeObserver on every frame of a scrub.
  useEffect(paint);

  useEffect(() => {
    const box = ref.current?.parentElement;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(paint);
    ro.observe(box);
    return () => ro.disconnect();
  }, [paint]);

  return ref;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

// ---------------------------------------------------------------- area

export function DitherArea({
  values,
  variant = "gradient",
  bloom = "low",
  color = INK,
  progress = 1,
  baseline = 0,
}: {
  values: number[];
  variant?: Variant;
  bloom?: Bloom;
  color?: Rgb;
  /** 0 draws nothing, 1 draws the whole series. Scrub this from a ScrollTrigger. */
  progress?: number;
  /** Fraction of the height left empty under the series. */
  baseline?: number;
}) {
  const ref = useDitherCanvas((img, w, h) => {
    if (values.length < 2) return;
    const max = Math.max(...values, 1e-9);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const reveal = clamp01(progress);
    const top = h * 0.06;
    const floor = h * (1 - baseline);

    // Height of the series at a normalised x, linearly interpolated between samples.
    const at = (nx: number) => {
      const t = nx * (values.length - 1);
      const i = Math.min(values.length - 2, Math.floor(t));
      const f = t - i;
      const v = values[i]! + (values[i + 1]! - values[i]!) * f;
      return (v - min) / span;
    };

    const fill = variantDensity(variant);
    const density: Density = (nx, ny) => {
      if (nx > reveal) return 0;
      const y = floor - (floor - top) * at(nx);
      const py = ny * h;
      if (py < y) return 0;
      // Renormalise ny inside the filled band so a gradient ramps over the band, not the canvas.
      return fill(nx, (py - y) / Math.max(1, floor - y));
    };
    paintDither(img, 0, 0, w, h, density, color);

    // The stroke: a 2px-tall solid band riding the top of the fill.
    const lw = Math.max(2, Math.round(h * 0.012));
    paintDither(
      img,
      0,
      0,
      w,
      h,
      (nx, ny) => {
        if (nx > reveal) return 0;
        const y = floor - (floor - top) * at(nx);
        return Math.abs(ny * h - y) < lw ? 1 : 0;
      },
      color,
    );

    const halo = bloomStrength[bloom];
    if (halo > 0) {
      paintDither(
        img,
        0,
        0,
        w,
        h,
        (nx, ny) => {
          if (nx > reveal) return 0;
          const y = floor - (floor - top) * at(nx);
          const d = y - ny * h;
          return d > 0 && d < h * 0.22 ? halo * (1 - d / (h * 0.22)) : 0;
        },
        color,
      );
    }
  });
  return <canvas ref={ref} className="dcanvas" aria-hidden="true" />;
}

// ---------------------------------------------------------------- bars

export function DitherBars({
  values,
  variant = "solid",
  color = INK,
  hotIndex = -1,
  hotColor = SIGNAL,
  progress = 1,
}: {
  values: number[];
  variant?: Variant;
  color?: Rgb;
  /** One bar painted in the accent. -1 for none. */
  hotIndex?: number;
  hotColor?: Rgb;
  progress?: number;
}) {
  const ref = useDitherCanvas((img, w, h) => {
    if (!values.length) return;
    const max = Math.max(...values, 1e-9);
    const reveal = clamp01(progress);
    const gap = Math.max(2, Math.round(w / (values.length * 8)));
    const bw = (w - gap * (values.length - 1)) / values.length;
    const fill = variantDensity(variant);

    values.forEach((v, i) => {
      // Each bar grows on its own slice of the progress, so the row wipes in left to right.
      const local = clamp01((reveal - (i / values.length) * 0.5) / 0.5);
      const bh = (v / max) * h * 0.94 * local;
      if (bh < 1) return;
      const x = i * (bw + gap);
      paintDither(img, x, h - bh, bw, bh, fill, i === hotIndex ? hotColor : color);
    });
  });
  return <canvas ref={ref} className="dcanvas" aria-hidden="true" />;
}

// ---------------------------------------------------------------- wash

/**
 * A full-bleed dithered wash, dense at one edge.
 *
 * Used to sit the photograph and the page on the same grain, so the hero does not read as a
 * photo with a UI pasted over it.
 */
export function DitherWash({
  from = "bottom",
  color = INK,
  strength = 0.5,
}: {
  from?: "top" | "bottom";
  color?: Rgb;
  strength?: number;
}) {
  const ref = useDitherCanvas((img, w, h) => {
    paintDither(
      img,
      0,
      0,
      w,
      h,
      (_nx, ny) => {
        const t = from === "bottom" ? ny : 1 - ny;
        return strength * Math.pow(t, 2.4);
      },
      color,
    );
  });
  return <canvas ref={ref} className="dcanvas" aria-hidden="true" />;
}

// ---------------------------------------------------------------- the horse

/**
 * The ledger horse, as dots.
 *
 * SVG rather than canvas: the mark is brand, so it has to stay crisp at any size and survive being
 * printed, and a `<circle>` per cell is a few hundred nodes at the sizes this is used.
 */
export function HorseMatrix({
  cols = 20,
  tone = "ink",
  size = 160,
  className,
}: {
  cols?: number;
  tone?: "ink" | "light" | "signal";
  size?: number;
  className?: string;
}) {
  // Sampling the outline needs a canvas, which the server does not have, so the matrix can only
  // exist after mount. Rendering an empty shell on both passes keeps hydration honest — the
  // alternative is a server/client mismatch that makes React rebuild the whole tree, which in turn
  // orphans every GSAP timeline already bound to the first one.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const cells = mounted ? horseCells(cols) : [];
  const fill = tone === "light" ? "var(--bg)" : tone === "signal" ? "var(--accent)" : "var(--text)";
  const step = 100 / cols;
  // The eye sits where the emblem's counter is: one cell held out and inked in the accent.
  const eye = cells.find(([c, r]) => Math.abs((c + 0.5) * step - 58) < step && Math.abs((r + 0.5) * step - 28) < step);

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="TradeFi ledger horse"
    >
      {cells.map(([c, r]) => (
        <circle
          key={`${c}-${r}`}
          cx={(c + 0.5) * step}
          cy={(r + 0.5) * step}
          r={step * 0.36}
          fill={eye && c === eye[0] && r === eye[1] ? "var(--accent)" : fill}
        />
      ))}
    </svg>
  );
}
