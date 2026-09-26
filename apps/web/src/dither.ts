/**
 * A one-file ordered-dither engine.
 *
 * Everything with texture on this site — chart fills, the moss wash, the ledger horse — is the same
 * idea: a density function sampled against a Bayer threshold matrix. Density 1 paints solid, 0
 * paints nothing, and everything between resolves into a halftone whose dot size is a function of
 * how much ink that region is asking for.
 *
 * Written rather than installed. The library that does this (dither-kit) is a Tailwind + shadcn
 * package that pulls d3 and motion behind it, and this app is plain CSS with no build step beyond
 * Next — so importing it would mean adopting two design systems to get one texture. The maths is
 * sixty lines.
 */

export type Rgb = readonly [number, number, number];

/**
 * Bayer 4x4 rather than 8x8.
 *
 * The matrix size IS the dot pitch: an 8x8 cell at device resolution on a 2x display is four CSS
 * pixels of structure that a reader only perceives as noise. 4x4 keeps the halftone legible at the
 * sizes UI actually renders at.
 */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const BAYER_N = 4;
const BAYER_MAX = 16;

/** Density at a point, in normalised rect coordinates. 0 = empty, 1 = solid. */
export type Density = (nx: number, ny: number) => number;

/**
 * Paint a dithered rect into an ImageData buffer, in device pixels.
 *
 * Writes only where the threshold is crossed, so overlapping calls composite the way ink does:
 * later series sit on top of earlier ones without a blend mode.
 */
export function paintDither(
  img: ImageData,
  x0: number,
  y0: number,
  w: number,
  h: number,
  density: Density,
  color: Rgb,
  alpha = 255,
): void {
  const { data, width, height } = img;
  const xa = Math.max(0, Math.floor(x0));
  const ya = Math.max(0, Math.floor(y0));
  const xb = Math.min(width, Math.ceil(x0 + w));
  const yb = Math.min(height, Math.ceil(y0 + h));
  if (w <= 0 || h <= 0) return;

  for (let y = ya; y < yb; y++) {
    const ny = (y - y0) / h;
    for (let x = xa; x < xb; x++) {
      const d = density((x - x0) / w, ny);
      if (d <= 0) continue;
      // Absolute pixel coordinates for the threshold, not rect-relative: the halftone is one
      // continuous field across the whole canvas, so adjacent shapes share a grid instead of each
      // starting their own and showing a seam.
      const t = (BAYER4[(y % BAYER_N) * BAYER_N + (x % BAYER_N)]! + 0.5) / BAYER_MAX;
      if (d < t) continue;
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = alpha;
    }
  }
}

/** Fill variants, the dither-kit vocabulary: how a region converts its value into ink. */
export type Variant = "gradient" | "solid" | "dotted" | "hatched";

export function variantDensity(variant: Variant, base = 1): Density {
  switch (variant) {
    // Dense at the baseline, thinning upward — reads as depth without a colour ramp.
    case "gradient":
      return (_nx, ny) => base * (0.1 + 0.74 * ny);
    case "dotted":
      return () => base * 0.34;
    case "hatched":
      return (nx, ny) => (Math.abs(((nx * 7 + ny * 7) % 0.5) - 0.25) < 0.1 ? base : base * 0.12);
    case "solid":
    default:
      return () => base;
  }
}

/**
 * Bloom: a soft halo of sparse dots outside the shape.
 *
 * Purely decorative and deliberately cheap — a second pass at low density over a dilated bound,
 * not a blur. A real blur on a halftone just produces grey.
 */
export type Bloom = "off" | "low" | "high" | "aura";
export const bloomStrength: Record<Bloom, number> = { off: 0, low: 0.1, high: 0.22, aura: 0.34 };

/** Device-pixel canvas sizing. Returns the ImageData to paint into. */
export function prepare(canvas: HTMLCanvasElement, cssW: number, cssH: number): {
  ctx: CanvasRenderingContext2D;
  img: ImageData;
  dpr: number;
} | null {
  // Cap at 2: dithering is a per-device-pixel loop, and a 3x display triples the work to render
  // structure nobody can see. The dot pitch is the point, not the resolution.
  const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  ctx.clearRect(0, 0, w, h);
  return { ctx, img: ctx.createImageData(w, h), dpr };
}

export const INK: Rgb = [23, 23, 23];
export const SIGNAL: Rgb = [244, 81, 8];
export const PAPER: Rgb = [242, 241, 238];
export const MARK: Rgb = [119, 118, 113];

// ---------------------------------------------------------------- the horse

/**
 * The ledger horse as a dot matrix, sampled from the master outline.
 *
 * The emblem ships as two files — a solid path and a 20-column matrix — and they have to stay the
 * same animal. Sampling the path is how: the matrix is derived, so there is no second drawing to
 * keep in sync, and any column count produces a mark that is by construction the same shape.
 */
export const HORSE_PATH =
  "M 6 40 C 5 44 4 47 5 50 C 8 53 13 54 18 53 C 24 52 26 51 30 52 C 34 53 36 54 38 58 " +
  "C 42 66 46 74 48 82 C 49 88 50 92 50 95 L 97 95 C 97 86 96 78 94 70 C 90 56 84 44 76 34 " +
  "C 74 30 72 26 71 22 L 68 6 L 61 20 L 56 22 L 49 3 L 43 19 C 38 23 30 28 22 32 " +
  "C 15 35 9 37 6 40 Z M 61.4 28 a 3.4 3.4 0 1 0 -6.8 0 a 3.4 3.4 0 1 0 6.8 0 Z";

let hitCtx: CanvasRenderingContext2D | null = null;
let horsePath: Path2D | null = null;
const cellCache = new Map<number, [number, number][]>();

/** Cells of a `cols`x`cols` grid whose centre falls inside the horse. */
export function horseCells(cols: number): [number, number][] {
  const hit = cellCache.get(cols);
  if (hit) return hit;
  if (typeof document === "undefined") return [];
  if (!hitCtx) hitCtx = document.createElement("canvas").getContext("2d");
  if (!horsePath) horsePath = new Path2D(HORSE_PATH);
  if (!hitCtx) return [];
  const cells: [number, number][] = [];
  const step = 100 / cols;
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      // The emblem's own eye is a counter in the path; fill-rule evenodd keeps it a hole here too.
      if (hitCtx.isPointInPath(horsePath, (c + 0.5) * step, (r + 0.5) * step, "evenodd")) cells.push([c, r]);
    }
  }
  cellCache.set(cols, cells);
  return cells;
}
