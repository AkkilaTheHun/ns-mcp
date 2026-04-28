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

import { rgbToLab, hexToLab as colorHexToLab, parseColor, deltaE76, COLOR_NAMES, type Lab } from "./color.js";

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

// Sorted longest-first so "pastel blue" matches before "blue", "rose gold"
// before "gold" / "rose", etc.
const COLOR_CANDIDATES = [
  "rose gold", "pastel blue", "powder blue", "light blue", "sky blue",
  "pastel mint", "pastel teal", "pastel pink", "pastel purple",
  "periwinkle", "turquoise", "burgundy", "charcoal", "magenta", "fuchsia",
  "lavender", "indigo", "violet", "maroon", "bronze", "copper", "silver",
  "amber", "coral", "cream", "ivory", "brown", "olive", "plum", "navy",
  "lilac", "beige", "sage", "mint", "teal", "rose", "gold", "blue",
  "pink", "purple", "green", "red", "orange", "yellow", "grey", "gray",
  "white", "black", "tan",
].sort((a, b) => b.length - a.length);

function colorLabelToLab(label: string): Lab | null {
  // Sonnet labels often pack multiple colors into one entry like
  // "copper/gold ultrachrome flakes" or "pink/magenta flakes". Split on
  // common separators and try the first match found across all parts.
  const parts = label.toLowerCase().split(/[\/,]|\s+(?:and|or)\s+/);
  for (const part of parts) {
    const cleaned = part.replace(/[^a-z #]/g, "").trim();
    if (!cleaned) continue;
    for (const c of COLOR_CANDIDATES) {
      if (cleaned.includes(c)) {
        try {
          return parseColor(c);
        } catch {
          // try next candidate
        }
      }
    }
  }
  return null;
}

/**
 * Like colorLabelToLab but returns ALL color matches found in the label,
 * useful when one Sonnet entry packs multiple flake colors.
 */
function colorLabelToAllLabs(label: string): Lab[] {
  const labs: Lab[] = [];
  const seen = new Set<string>();
  const parts = label.toLowerCase().split(/[\/,]|\s+(?:and|or)\s+/);
  for (const part of parts) {
    const cleaned = part.replace(/[^a-z #]/g, "").trim();
    if (!cleaned) continue;
    for (const c of COLOR_CANDIDATES) {
      if (cleaned.includes(c) && !seen.has(c)) {
        try {
          labs.push(parseColor(c));
          seen.add(c);
          break; // one color per part is plenty
        } catch {
          // try next candidate
        }
      }
    }
  }
  return labs;
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

  // Flake colors: scan the 2nd+ entries from dominantColors (the 1st is the
  // base color). For each entry, harvest all color words found (handles
  // compound labels like "copper/gold ultrachrome flakes" → both copper AND
  // gold). Cap at 3 unique flake colors total.
  const flakeColorsHex: string[] = [];
  const seenHex = new Set<string>();
  for (let i = 1; i < dominantColors.length && flakeColorsHex.length < 3; i++) {
    const entry = dominantColors[i];
    if (typeof entry === "object" && entry.hex && !seenHex.has(entry.hex)) {
      flakeColorsHex.push(entry.hex);
      seenHex.add(entry.hex);
      continue;
    }
    const label = typeof entry === "string" ? entry : entry.label;
    for (const lab of colorLabelToAllLabs(label)) {
      if (flakeColorsHex.length >= 3) break;
      const hex = labToHex(lab);
      if (!seenHex.has(hex)) {
        flakeColorsHex.push(hex);
        seenHex.add(hex);
      }
    }
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

/**
 * Find the nearest named color from COLOR_NAMES given a hex string.
 * Uses LAB Delta-E for perceptual nearest-neighbor — sage-grey #afc9c0
 * lands on "mint" (closest LAB), not "grey" (closer in RGB).
 */
export function nearestNamedColor(hex: string): string {
  let bestName = "grey";
  let bestDist = Infinity;
  let target: Lab;
  try {
    target = colorHexToLab(hex);
  } catch {
    return bestName;
  }
  for (const [name, namedHex] of Object.entries(COLOR_NAMES)) {
    try {
      const lab = colorHexToLab(namedHex);
      const d = deltaE76(target, lab);
      if (d < bestDist) {
        bestDist = d;
        bestName = name;
      }
    } catch {
      // skip malformed entries
    }
  }
  return bestName;
}

/**
 * Strip HTML tags and decode common entities. Vendor descriptionHtml from
 * Shopify comes wrapped in <p>...</p> with occasional &amp; etc.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the base color label from vendor description.
 * Looks for a color word (from COLOR_NAMES) immediately preceding the finish
 * type or "polish" — typically "X crelly", "X jelly", "X nail polish", etc.
 *
 * Vendor copy for Sweet Nothing: "...is a pink crelly packed with..." → "pink"
 * Vendor copy for Fresh Sheets: "...is a pastel mint crelly..." → "pastel mint"
 *
 * Returns the longest matching color word so "pastel mint" beats "mint" and
 * "rose gold" beats "rose" or "gold".
 */
export function extractBaseColorLabel(rawText: string, finishType?: string): string | null {
  const text = stripHtml(rawText).toLowerCase();

  // Sort COLOR_NAMES keys longest-first so multi-word colors win
  const colorKeys = Object.keys(COLOR_NAMES).sort((a, b) => b.length - a.length);
  const colorPattern = colorKeys
    .map((k) => k.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&"))
    .join("|");

  // Try with explicit finish type first ("pink crelly", "pastel mint crelly")
  if (finishType) {
    const re = new RegExp(`\\b(${colorPattern})\\s+${finishType}\\b`, "i");
    const m = text.match(re);
    if (m) return m[1].toLowerCase();
  }

  // Fallback: any color word followed by polish/nail polish
  const fallback = new RegExp(`\\b(${colorPattern})\\s+(?:nail\\s+)?polish\\b`, "i");
  const m2 = text.match(fallback);
  if (m2) return m2[1].toLowerCase();

  return null;
}

/**
 * Extract VENDOR-AUTHORITATIVE shade attributes from a product description.
 *
 * Sonnet's per-image perception can hallucinate (e.g., "multichrome" on a
 * photo with strong directional lighting), but the vendor's product copy
 * is ground truth for whether a polish IS multichrome / ultrachrome /
 * iridescent / etc. Use this to override Sonnet-derived booleans when
 * persisting to the catalog.
 *
 * Returns ONLY the boolean / enum attrs — base color and flake_colors_hex
 * still come from per-image perception (vendor copy doesn't give pixel-
 * accurate hex codes).
 */
export interface VendorDescriptionAttrs extends Pick<
  FlakeAttrs,
  "finishType" | "hasUltrachrome" | "hasIridescent" | "hasHolographic" | "hasThermal" | "hasMagnetic" | "flakeSize"
> {
  baseColorLabel: string | null;
}

export function extractFromVendorDescription(rawText: string): VendorDescriptionAttrs {
  const text = stripHtml(rawText).toLowerCase();

  // Reuse the same regex bank as the per-image extractor — vendor copy and
  // Sonnet output use the same vocabulary.
  let finishType: FinishKey | undefined;
  if (text.includes("crelly")) finishType = "crelly";
  else if (text.includes("jelly")) finishType = "jelly";
  else if (text.includes("creme") || text.includes("cream")) finishType = "creme";
  else if (text.includes("holo")) finishType = "holo";
  else if (text.includes("magnetic")) finishType = "magnetic";
  else if (text.includes("multichrome")) finishType = "multichrome";
  else if (text.includes("glitter")) finishType = "glitter";

  const hasUltrachrome = /\bultrachrome|chameleon\s+(flak|shard)/i.test(text);
  const hasIridescent = /\biridescent|pearly\s+shimmer/i.test(text);
  const hasHolographic = /\bholo|holographic/i.test(text);
  const hasThermal = /\bthermal|color[\- ]chang/i.test(text);
  const hasMagnetic = /\bmagnetic/i.test(text);

  // Vendor descriptions rarely use explicit "(large)" / "(small)" but the
  // presence of ultrachrome/chameleon flakes implies large; iridescent-only
  // implies fine.
  let flakeSize: FlakeSizeKey = "none";
  if (/\blarge|big|chunky|shards?\b/i.test(text)) flakeSize = "large";
  else if (/\bmedium|moderate\b/i.test(text)) flakeSize = "medium";
  else if (/\bfine|small|micro|tiny|pearly|scatter/i.test(text)) flakeSize = "fine";
  else if (hasUltrachrome) flakeSize = "large";
  else if (hasIridescent || hasHolographic) flakeSize = "fine";

  const baseColorLabel = extractBaseColorLabel(rawText, finishType);

  return {
    finishType,
    hasUltrachrome,
    hasIridescent,
    hasHolographic,
    hasThermal,
    hasMagnetic,
    flakeSize,
    baseColorLabel,
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
