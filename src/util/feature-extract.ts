/**
 * Feature extraction for nail polish shade signatures.
 *
 * Converts a vision-model `ImageAnalysis` (or aggregated catalog data) into
 * structured fields plus a 50-dim feature vector suitable for nearest-neighbor
 * lookup via pgvector cosine similarity.
 *
 * Vector layout (50 dims):
 *   [0..2]   Base color LAB (normalized: L→[0,1], a→[-1,1]→[0,1], b→[-1,1]→[0,1])
 *   [3]      Base color saturation proxy (chroma magnitude)
 *   [4]      Base color brightness (L normalized)
 *   [5..11]  Finish type one-hot (creme, crelly, jelly, holo, magnetic, glitter, multichrome)
 *   [12..16] Flake type multi-hot (ultrachrome, iridescent, holographic, thermal, scattered_glitter)
 *   [17..20] Flake size one-hot (none, fine, medium, large)
 *   [21..29] Top-3 flake colors LAB (3 colors × 3 dims, normalized)
 *   [30..49] Reserved (zeros) — room for future learned features without re-indexing
 */

import { rgbToLab, hexToLab as colorHexToLab, parseColor, type Lab } from "./color.js";

export type Vector50 = number[]; // length 50

const FINISH_KEYS = ["creme", "crelly", "jelly", "holo", "magnetic", "glitter", "multichrome"] as const;
const FLAKE_KEYS = ["ultrachrome", "iridescent", "holographic", "thermal", "scattered_glitter"] as const;
const FLAKE_SIZE_KEYS = ["none", "fine", "medium", "large"] as const;

type FinishKey = typeof FINISH_KEYS[number];
type FlakeKey = typeof FLAKE_KEYS[number];
type FlakeSizeKey = typeof FLAKE_SIZE_KEYS[number];

export interface FlakeAttrs {
  finishType?: FinishKey;
  hasUltrachrome: boolean;
  hasIridescent: boolean;
  hasHolographic: boolean;
  hasThermal: boolean;
  hasMagnetic: boolean;
  flakeSize: FlakeSizeKey;
  flakeColorsHex: string[];
}

export interface ImageAnalysisLike {
  dominantColors: Array<{ hex?: string; label: string } | string>;
  observedEffects: string[];
  altText?: string;
}

/** Normalize an LAB triple from CIE ranges to a [0,1]-ish space for embedding stability. */
function normalizeLab(lab: Lab): [number, number, number] {
  // L in [0,100], a/b roughly in [-128,128]. Map all to ~[0,1].
  return [lab[0] / 100, (lab[1] + 128) / 256, (lab[2] + 128) / 256];
}

function chromaFromLab(lab: Lab): number {
  // Sqrt(a² + b²) is the chroma; normalize roughly into [0,1] (max ~150 in practice).
  const c = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
  return Math.min(1, c / 150);
}

function safeHexToLab(hex: string | undefined): Lab | null {
  if (!hex) return null;
  try {
    return colorHexToLab(hex);
  } catch {
    return null;
  }
}

function colorLabelToLab(label: string): Lab | null {
  // Try to parse a color name from the label using our existing color util.
  // Falls back to null if the label isn't a recognized color word.
  const cleaned = label.toLowerCase().replace(/[^a-z #]/g, "").trim();
  // Use the longest matching known color name in the label.
  const candidates = [
    "pastel blue", "light blue", "powder blue", "blue",
    "pastel mint", "mint", "pastel teal", "teal",
    "pastel pink", "pink", "pastel purple", "purple",
    "lavender", "lilac", "periwinkle",
    "grey", "gray", "green", "red", "orange", "yellow", "white", "black",
  ];
  for (const c of candidates.sort((a, b) => b.length - a.length)) {
    if (cleaned.includes(c)) {
      try {
        return parseColor(c);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Extract a hex string from a dominantColors entry, falling back to color-name parsing. */
function entryToHexAndLab(entry: { hex?: string; label: string } | string): { hex?: string; lab: Lab | null } {
  if (typeof entry === "string") {
    return { hex: undefined, lab: colorLabelToLab(entry) };
  }
  const fromHex = safeHexToLab(entry.hex);
  if (fromHex) return { hex: entry.hex, lab: fromHex };
  return { hex: entry.hex, lab: colorLabelToLab(entry.label) };
}

/** Parse observedEffects strings into structured flake attributes. */
export function extractFlakeAttrs(effects: string[], dominantColors: ImageAnalysisLike["dominantColors"]): FlakeAttrs {
  const joined = effects.join(" ").toLowerCase();

  // Finish type — pick the first match in priority order.
  let finishType: FinishKey | undefined;
  if (joined.includes("crelly")) finishType = "crelly";
  else if (joined.includes("jelly")) finishType = "jelly";
  else if (joined.includes("creme") || joined.includes("cream")) finishType = "creme";
  else if (joined.includes("holo")) finishType = "holo";
  else if (joined.includes("magnetic")) finishType = "magnetic";
  else if (joined.includes("multichrome")) finishType = "multichrome";
  else if (joined.includes("glitter")) finishType = "glitter";

  const hasUltrachrome = /\bultrachrome|chameleon\s+(flak|shard)/i.test(joined);
  const hasIridescent = /\biridescent|pearly\s+shimmer/i.test(joined);
  const hasHolographic = /\bholo|holographic/i.test(joined);
  const hasThermal = /\bthermal|color[\- ]chang/i.test(joined);
  const hasMagnetic = /\bmagnetic/i.test(joined);

  // Flake size: look for explicit size descriptors. Default to fine if any flakes detected.
  let flakeSize: FlakeSizeKey = "none";
  if (/\blarge|big|chunky|shards?\b/i.test(joined)) flakeSize = "large";
  else if (/\bmedium|moderate\b/i.test(joined)) flakeSize = "medium";
  else if (/\bfine|small|micro|tiny|pearly|scatter/i.test(joined)) flakeSize = "fine";
  else if (hasUltrachrome) flakeSize = "large";
  else if (hasIridescent || hasHolographic) flakeSize = "fine";

  // Flake colors: take the 2nd and 3rd entries from dominantColors as flake colors
  // (the 1st is usually the base). Convert to hex via direct hex codes if present
  // OR fall back to color-name resolution from the label.
  const flakeColorsHex: string[] = [];
  for (let i = 1; i < dominantColors.length && flakeColorsHex.length < 3; i++) {
    const entry = dominantColors[i];
    if (typeof entry === "string") {
      const lab = colorLabelToLab(entry);
      if (lab) flakeColorsHex.push(labToHex(lab));
      continue;
    }
    if (entry.hex) {
      flakeColorsHex.push(entry.hex);
      continue;
    }
    const lab = colorLabelToLab(entry.label);
    if (lab) flakeColorsHex.push(labToHex(lab));
  }

  return {
    finishType,
    hasUltrachrome,
    hasIridescent,
    hasHolographic,
    hasThermal,
    hasMagnetic,
    flakeSize,
    flakeColorsHex,
  };
}

/** Extract the base color (LAB + hex) from the first dominantColors entry. */
export function extractBaseColor(dominantColors: ImageAnalysisLike["dominantColors"]): { hex?: string; lab: Lab | null } {
  if (!dominantColors.length) return { lab: null };
  return entryToHexAndLab(dominantColors[0]);
}

/** Build a 50-dim feature vector from structured fields. */
export function buildEmbedding(params: {
  baseColorLab?: Lab | null;
  flake: FlakeAttrs;
}): Vector50 {
  const v = new Array<number>(50).fill(0);

  // [0..2] base color LAB (normalized)
  if (params.baseColorLab) {
    const norm = normalizeLab(params.baseColorLab);
    v[0] = norm[0];
    v[1] = norm[1];
    v[2] = norm[2];
    // [3] chroma; [4] brightness
    v[3] = chromaFromLab(params.baseColorLab);
    v[4] = params.baseColorLab[0] / 100;
  }

  // [5..11] finish type one-hot
  if (params.flake.finishType) {
    const idx = FINISH_KEYS.indexOf(params.flake.finishType);
    if (idx >= 0) v[5 + idx] = 1;
  }

  // [12..16] flake type multi-hot
  if (params.flake.hasUltrachrome) v[12] = 1;
  if (params.flake.hasIridescent) v[13] = 1;
  if (params.flake.hasHolographic) v[14] = 1;
  if (params.flake.hasThermal) v[15] = 1;
  // 16 is reserved for scattered_glitter — derive from finishType when finish === "glitter"
  if (params.flake.finishType === "glitter") v[16] = 1;

  // [17..20] flake size one-hot
  const sizeIdx = FLAKE_SIZE_KEYS.indexOf(params.flake.flakeSize);
  if (sizeIdx >= 0) v[17 + sizeIdx] = 1;

  // [21..29] top-3 flake colors LAB
  // (filled in extractAndEmbed below; left as zeros if no flake colors)

  // [30..49] reserved zeros

  return v;
}

/** Convenience: extract structured fields + embedding from an image analysis. */
export function extractAndEmbed(analysis: ImageAnalysisLike): {
  baseColorHex: string | undefined;
  baseColorLab: Lab | null;
  flake: FlakeAttrs;
  embedding: Vector50;
} {
  const base = extractBaseColor(analysis.dominantColors);
  const flake = extractFlakeAttrs(analysis.observedEffects, analysis.dominantColors);
  const embedding = buildEmbedding({ baseColorLab: base.lab, flake });

  // Fill flake-color LAB dims
  let dim = 21;
  for (const hex of flake.flakeColorsHex.slice(0, 3)) {
    const lab = safeHexToLab(hex);
    if (lab) {
      const n = normalizeLab(lab);
      embedding[dim] = n[0];
      embedding[dim + 1] = n[1];
      embedding[dim + 2] = n[2];
    }
    dim += 3;
  }

  return {
    baseColorHex: base.hex,
    baseColorLab: base.lab,
    flake,
    embedding,
  };
}

/** Average several LAB triples component-wise (skipping nulls). */
export function meanLab(labs: Array<Lab | null>): Lab | null {
  const valid = labs.filter((l): l is Lab => l !== null);
  if (!valid.length) return null;
  const sum = valid.reduce<[number, number, number]>(
    ([l, a, b], [l2, a2, b2]) => [l + l2, a + a2, b + b2],
    [0, 0, 0],
  );
  const n = valid.length;
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

/** Convert LAB back to hex (sRGB) — useful for storing aggregate base color hex. */
export function labToHex(lab: Lab): string {
  // Inverse of color.ts pipeline: LAB → XYZ → linear RGB → sRGB → hex.
  const [L, a, b] = lab;
  const Yn = 100, Xn = 95.047, Zn = 108.883;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const finv = (t: number) => (t > 0.206893 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = finv(fx) * Xn / 100;
  const y = finv(fy) * Yn / 100;
  const z = finv(fz) * Zn / 100;
  const r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const g = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  const linToSrgb = (v: number) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  const r8 = Math.max(0, Math.min(255, Math.round(linToSrgb(r) * 255)));
  const g8 = Math.max(0, Math.min(255, Math.round(linToSrgb(g) * 255)));
  const b8 = Math.max(0, Math.min(255, Math.round(linToSrgb(bl) * 255)));
  return "#" + [r8, g8, b8].map((c) => c.toString(16).padStart(2, "0")).join("");
}

// Re-export rgbToLab for callers that already have raw RGB values.
export { rgbToLab };
