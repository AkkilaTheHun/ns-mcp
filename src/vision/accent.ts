/**
 * Accent detection — deterministic tie-breaking on saturated, hue-distant cues.
 *
 * Every pair of shades the model confuses in this collection is separated by a
 * highly saturated accent colour that is far away in hue:
 *
 *   What Lurks Within / Strange Happenings   neon PINK vs neon GREEN glitter
 *   Once You See It  / I Found A Place       ORANGE vs LIME GREEN magnetic band
 *   I'll Be Right Back / You Wished For This RED vs BLUE reflective glitter
 *
 * Those accents survive what the base colours do not. Base colours here are
 * interference pigments — goniochromatic, so their measured colour depends on
 * an uncontrolled viewing angle (see docs/effect-pigment-optics.md). A saturated
 * accent 100°+ away in hue survives white balance, exposure and angle, because
 * we are only asking "is there a cluster of pixels in this hue region", not
 * "what exactly is this colour".
 *
 * This does NOT try to reconstruct the image or unmix it into endmembers. That
 * general approach founders on skin and background contributing their own
 * modes, on colour words mapping too coarsely ("murky teal" and "teal green"
 * land on the same anchor), and on goniochromatic pigments producing a
 * continuum rather than separable modes. Asking one narrow question avoids all
 * three.
 */
import sharp from "sharp";
import { rgbToLab, hexToLab, type Lab } from "../util/color.js";

export interface AccentSpec {
  name: string;
  /** Representative colour of the accent. */
  hex: string;
  /** Hue tolerance in degrees. Wider for accents that shift with angle. */
  hueTolerance?: number;
  /** Minimum LAB chroma. Skin sits around 20-30, so a vivid accent clears it. */
  minChroma?: number;
}

export interface AccentHit {
  name: string;
  /** Percent of sampled pixels matching this accent. */
  pct: number;
  /** Mean chroma of the matching pixels — vividness, not just presence. */
  meanChroma: number;
  /** pct weighted by how far above the chroma floor the matches sit. */
  strength: number;
}

const hueOf = (lab: Lab): number => {
  const h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
};
const chromaOf = (lab: Lab): number => Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);

/** Smallest absolute difference between two hue angles, in degrees. */
function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const DEFAULT_TOLERANCE = 28;
const DEFAULT_MIN_CHROMA = 32;

/**
 * Measure how strongly each accent is present.
 *
 * Very dark and very light pixels are skipped: near-black loses hue to noise,
 * and blown highlights are the light source rather than the polish.
 */
export async function detectAccents(
  image: Buffer,
  accents: AccentSpec[],
  sample = 400,
): Promise<AccentHit[]> {
  const { data, info } = await sharp(image, { failOn: "none" })
    .rotate()
    .resize(sample, sample, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const targets = accents.map((a) => {
    const lab = hexToLab(a.hex);
    return {
      spec: a,
      hue: hueOf(lab),
      tol: a.hueTolerance ?? DEFAULT_TOLERANCE,
      minC: a.minChroma ?? DEFAULT_MIN_CHROMA,
      count: 0,
      chromaSum: 0,
      excessSum: 0,
    };
  });

  let considered = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * info.channels;
    const lab = rgbToLab(data[o], data[o + 1], data[o + 2]);
    if (lab[0] < 12 || lab[0] > 94) continue; // near-black noise, or blown highlight
    considered++;
    const c = chromaOf(lab);
    const h = hueOf(lab);
    for (const t of targets) {
      if (c >= t.minC && hueDelta(h, t.hue) <= t.tol) {
        t.count++;
        t.chromaSum += c;
        t.excessSum += c - t.minC;
      }
    }
  }

  const denom = considered || 1;
  return targets.map((t) => ({
    name: t.spec.name,
    pct: Math.round((t.count / denom) * 10000) / 100,
    meanChroma: t.count ? Math.round((t.chromaSum / t.count) * 10) / 10 : 0,
    // Presence x vividness: a large area of barely-qualifying pixels should not
    // outrank a small area of unmistakable ones.
    strength: Math.round((t.excessSum / denom) * 100) / 100,
  }));
}

/**
 * Confusable pairs where a hue test genuinely separates the two.
 *
 * The bar for inclusion: the accent colour must appear in ONE member of the
 * pair and be essentially absent from the other. Verified against a
 * burst-reconciled shoot — 11/11 correct on the cases these speak to, with
 * abstentions elsewhere.
 */
export const HALLOWEEN_2026_ACCENTS: Record<string, AccentSpec[]> = {
  thermalGlitter: [
    { name: "neon pink glitter (What Lurks Within)", hex: "#FF2D95", minChroma: 45 },
    { name: "neon green glitter (Strange Happenings)", hex: "#39FF14", minChroma: 45 },
  ],
  magneticBand: [
    // Orange overlaps skin in hue, so it needs a high chroma floor to separate.
    { name: "orange band (Once You See It)", hex: "#E8641A", minChroma: 48, hueTolerance: 22 },
    { name: "lime green band (I Found A Place)", hex: "#8FD400", minChroma: 40, hueTolerance: 26 },
  ],
  // DELIBERATELY ABSENT: the two toppers.
  //
  // I'll Be Right Back is "blue micro flakes, blue shimmer, charcoal and RED
  // reflective glitter"; You Wished For This is "red-orange to yellow micro
  // flakes, charcoal and BLUE reflective glitter". The colours are INVERTED
  // between flake and glitter, so both shades contain substantial red AND blue.
  //
  // A hue histogram cannot separate them, because separating them requires
  // telling a flake from a glitter particle — a morphology question, not a
  // colour one. An accent pair only works when the accent colour is present in
  // ONE member of the pair; here it is present in both, so this detector would
  // be confidently wrong. Left to the model, which can see particle shape.
};

/**
 * Minimum evidence required before this detector will express an opinion.
 *
 * Calibrated against Doseoflolade's burst-verified shoot. With no floor the
 * detector scored 14/16, and both errors were cases where BOTH accents were
 * near-absent — it was reading noise. With the floor it scores 11/11 on the
 * cases it speaks to and abstains on the other 5, which is the behaviour we
 * want: this exists to break ties the model cannot, not to add a second
 * unreliable voice.
 */
const MIN_STRENGTH = 0.10;
const MIN_RELATIVE_MARGIN = 0.5;

/**
 * Which of a pair is better supported.
 *
 * Returns winner: null when the evidence is too weak or too close to call.
 * An abstention is useful — a wrong tie-break is worse than none, because it
 * would override the model's own judgement with noise.
 */
export function resolvePair(hits: AccentHit[]): { winner: string | null; margin: number; abstained: string | null } {
  const ranked = [...hits].sort((a, b) => b.strength - a.strength);
  const top = ranked[0];
  if (!top || top.strength <= 0) return { winner: null, margin: 0, abstained: "no accent detected" };

  const margin = top.strength - (ranked[1]?.strength ?? 0);
  if (top.strength < MIN_STRENGTH) {
    return { winner: null, margin, abstained: `strongest accent below floor (${top.strength} < ${MIN_STRENGTH})` };
  }
  if (margin / top.strength < MIN_RELATIVE_MARGIN) {
    return { winner: null, margin, abstained: `too close to call (margin ${Math.round((margin / top.strength) * 100)}%)` };
  }
  return { winner: top.name, margin: Math.round(margin * 100) / 100, abstained: null };
}
