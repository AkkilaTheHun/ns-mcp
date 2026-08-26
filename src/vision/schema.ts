/**
 * Shared vision analysis schema and prompt.
 *
 * Both providers (Gemini, Claude) render the SAME prompt and parse the SAME
 * shape. Previously each file carried its own near-identical copy, so every
 * prompt change had to be made twice and drifted in between.
 *
 * Design constraints, each traceable to a measured failure:
 *
 *  - bottle and nail colours are never merged. On a magnetic, multichrome or
 *    thermal the bottle and the nails are different colours; reporting one
 *    blended list makes two different polishes indistinguishable downstream.
 *
 *  - a colour-shifting polish must yield a STABLE anchor. Measured on the
 *    Halloween 2026 set: two frames of one bottle reported base colours 136
 *    ΔE apart (#2A2FBF "royal blue" vs #4A7A2E "olive green") because each
 *    frame reported whichever end of the shift dominated that angle. The
 *    within-shade spread (median 28.3 ΔE) exceeded the between-shade signal
 *    (17.0 ΔE), which makes clustering impossible. `baseColor` is therefore
 *    pinned to the flattest, most face-on patch, with the shift endpoints
 *    reported separately in `shiftColors`.
 *
 *  - the model never names the shade in collection mode. Given a list of
 *    candidate shades it will pick one and assert it at high confidence.
 *
 *  - a property of a particle is not a property of the polish. "Matte glitter"
 *    in a glossy polish must not make the product Matte.
 */

export interface ColorEntry {
  hex: string;
  label: string;
}

export interface Discriminators {
  /**
   * The polish body colour read at the EDGE of the bottle glass.
   *
   * Operator insight, and the most repeatable anchor available: at the rim the
   * light passes through a thicker column of lacquer at a shallow angle, so the
   * clean base shows even when the face of the bottle is drowned in shimmer. A
   * "teal base with purple shimmer" reads purple across the bottle face and
   * clean teal at the glass edge. Unlike a nail patch, the sampling location is
   * physically defined, so two photographers hit the same spot.
   */
  bottleEdgeColor: ColorEntry | null;
  /** Face-on base colour read off the nail. */
  baseColor: ColorEntry | null;
  /** Other endpoints of a multichrome/duochrome shift, if any. */
  shiftColors: ColorEntry[];
  shimmerFlashColors: ColorEntry[];
  /** The line colour on a magnetic — often the ONLY thing separating two shades. */
  magneticLineColor: ColorEntry | null;
  glitterColors: ColorEntry[];
  flakeColors: ColorEntry[];
  thermalCold: ColorEntry | null;
  thermalWarm: ColorEntry | null;
}

/** Finishes belonging to the PARTICLES, never promoted to the product. */
export interface ComponentFinish {
  glitterFinish: string | null;
  flakeFinish: string | null;
  flakeSize: "none" | "fine" | "medium" | "large" | null;
}

export interface ImageAnalysis {
  imageType: string;
  lightingCondition: string;
  nailCount: number;
  skinTone: string | null;

  /** Colours read off the BOTTLE only. Null when no bottle is visible. */
  bottleColors: ColorEntry[] | null;
  /** Colours read off the NAILS only. Null when no swatched nail is visible. */
  nailColors: ColorEntry[] | null;

  discriminators: Discriminators;
  componentFinish: ComponentFinish;

  /** Finishes/effects actually observed. Vision is the authority here. */
  observedEffects: string[];
  altText: string;

  /** Is the IMAGE legible: focus, exposure, framing. Not about identification. */
  imageQuality: number;
  /** How confidently this polish could be pinned down from this frame alone. */
  identification: number;

  /**
   * Legacy view, derived from nailColors ?? bottleColors so existing consumers
   * (shade_index, recompute, the CLI scripts) keep working unchanged.
   */
  dominantColors: ColorEntry[];
  confidence: number;

  /** Set when the model's reply could not be parsed; drives the retry. */
  parseFailed?: boolean;
}

import { typeGuidance, type PolishFinish, type PolishType } from "./polish-types.js";

export const SYSTEM_PROMPT = `You are an expert image analyst for NailStuff, a Canadian indie nail polish e-commerce store. You produce structured measurements of nail polish photographs for a colour-matching catalog, plus accessibility-focused alt text.

You are a measuring instrument. Two photographs of the same polish must produce comparable numbers, and two photographs of different polishes must produce different numbers. Everything below serves that goal.

THE BOTTLE AND THE NAILS ARE SEPARATE MEASUREMENTS
Report them separately and never reconcile them. On magnetic, multichrome, thermal and shimmer polishes the bottle and the swatched nails routinely read as completely different colours — a bottle can look magenta while the nails look bronze. That is expected and correct. Do not average them, do not let one correct the other, and do not suppress a reading because it disagrees with the other.

COLOUR-SHIFTING POLISHES NEED A STABLE ANCHOR
For a polish that changes colour with angle, do NOT report "the colour of the polish" as whichever shade happens to dominate this frame — that makes two photos of one bottle look like two different products.

- bottleEdgeColor: THE MOST RELIABLE ANCHOR. When a bottle is visible, look at the EDGE / RIM of the glass, not the face. At the edge the light travels through a thicker column of lacquer at a shallow angle, so the clean base colour shows through even when the face of the bottle is dominated by shimmer or flash. A polish that is "teal base with purple shimmer" will read purple across the bottle face and clean teal at the glass edge — report that teal here. Sample the lacquer at the rim, NOT the glass itself, NOT the cap, NOT a specular highlight.
- baseColor: read from the FLATTEST, most face-on patch of nail available, where the polish sits closest to its at-rest colour and is not catching a strong angular flash. Same rule in every photo.
- shiftColors: the OTHER colours the polish travels through at other angles, listed separately.

These are three separate observations; fill in each one you can actually see and set the others to null. Do not copy one into another. If no face-on nail patch exists, set baseColor to null rather than guessing — a null is recoverable, a wrong anchor is not. Likewise set bottleEdgeColor to null if no bottle edge is legible.

MEASURE THE DISCRIMINATORS
Shades within one collection are often near-identical on base colour and separable only by a fine detail. Two magnetics can share a base and differ only in the colour of the magnetic line; two thermals can differ only in glitter colour. Report these precisely and specifically. "Purple" is not a measurement; "#7B3FBF violet shimmer flash" is.

PARTICLE PROPERTIES ARE NOT PRODUCT PROPERTIES
If the glitter is matte and sits in a glossy polish, the glitter is matte — the polish is not. Report particle finishes under componentFinish only. Never let them reach observedEffects.

Hex values must be sampled from what is actually visible, not inferred from the colour's name.

Skin tone, when skin is visible, uses: fair, light, light-medium, medium, medium-deep, deep, rich.
Nail shape, when visible: stiletto, coffin, almond, oval, round, square, squoval, short natural.`;

export interface PromptContext {
  productName: string;
  brand: string;
  vendorHint?: string;
  /**
   * Operator ground truth (Shopify `custom.nailstuff_polish_type`). When set,
   * the measurement prompt is specialised to that type — what identifies a
   * magnetic is not what identifies a creme. Never inferred from vendor prose;
   * finish stays observation, type stays operator truth.
   */
  /** Operator ground truth. Governs WHERE the base colour is read. */
  polishType?: PolishType;
  /** Observed optics, multi-valued. Governs WHICH fields carry identity. */
  polishFinishes?: PolishFinish[];
  /**
   * What the vendor says this shade contains, e.g.
   * `{ baseColor: "sheer red", magneticLineColor: "orange" }`.
   *
   * Given as EXPECTATIONS TO VERIFY, never as answers to echo. This is safe in
   * a way that naming the shade is not: it tells the model where to look
   * without telling it what to conclude, and a disagreement is informative
   * rather than suppressed.
   */
  expectedFeatures?: Record<string, string | string[]>;
  /**
   * Collection mode. When true the shade identity is UNKNOWN to the model: it
   * must describe features only and must never name or guess a shade. Set this
   * whenever analyzing a folder of many shades — passing a candidate list makes
   * the model choose one and assert it at high confidence.
   */
  collectionMode?: boolean;
}

/**
 * Vendor expectations, rendered as things to CHECK.
 *
 * Deliberately phrased so a mismatch is reportable: the failure mode we are
 * avoiding is the model treating a supplied value as the answer and echoing it
 * back, which turns operator input into fabricated measurement.
 */
function expectedBlock(ctx: PromptContext): string {
  const e = ctx.expectedFeatures;
  if (!e || !Object.keys(e).length) return "";
  const lines = Object.entries(e)
    .map(([k, v]) => `- ${k}: vendor says ${Array.isArray(v) ? v.join(" then ") : v}`)
    .join("\n");
  return `

WHAT THE VENDOR SAYS THIS SHADE CONTAINS — treat as expectations to VERIFY, not as answers:
${lines}

Use these to know WHERE TO LOOK. A vendor saying the magnetic band is orange tells you to find the band and measure it; it does not tell you what hex to report. Measure from the pixels every time.
If what you see genuinely disagrees with the vendor, REPORT WHAT YOU SEE and lower "identification". Never bend a measurement to match the description, and never report a feature you cannot actually see just because the vendor listed it.`;
}

export function buildUserPrompt(ctx: PromptContext, hasCrop: boolean): string {
  const identity = ctx.collectionMode
    ? `Brand: ${ctx.brand}. THE SHADE IS UNKNOWN.
You do not know which shade this is and you must not try to work it out. Do not name a shade. Do not guess from packaging text, from other images, or from any list you may have seen. Describe only what this photograph shows. The shade will be assigned by an operator afterwards, and alt text will be written from that assignment — so write alt text that describes the image WITHOUT naming a shade.`
    : `Product: "${ctx.productName}" by ${ctx.brand}.`;

  const hint = ctx.vendorHint && !ctx.collectionMode
    ? `\n\nThe vendor describes it as: "${ctx.vendorHint}". Use this only to interpret what you see. If your eyes disagree, trust your eyes and lower "identification" — never bend a measurement to match the description.`
    : "";

  const crop = hasCrop
    ? `\n\nTWO IMAGES ARE PROVIDED. Use them with this hierarchy, do not average between them:
- IMAGE 1 (full frame): AUTHORITATIVE for all colour values. The full frame averages out topcoat shine and lighting hotspots, so it is the most reliable view of true colour.
- IMAGE 2 (closeup): ONLY for particle morphology — the size and shape of flakes, glitter and shimmer. Use it to set componentFinish.flakeSize and to describe particle character. Do NOT let it override any colour from image 1; zoomed pixels show topcoat artifacts, not polish colour.`
    : "";

  return `${identity}${hint}${crop}${typeGuidance(ctx.polishType, ctx.polishFinishes)}${expectedBlock(ctx)}

Return a JSON object with exactly these fields:

- "imageType": one of "bottle_in_hand", "bottle_standalone", "swatch_on_nails", "swatch_wheel", "swatch_stick", "lifestyle", "layering_demo", "group_shot", "macro_detail", "unknown"
- "lightingCondition": one of "direct_flash", "bright_daylight", "indoor_warm", "dim", "studio"
- "nailCount": number of nails visible (0 if none)
- "skinTone": one of "fair","light","light-medium","medium","medium-deep","deep","rich", or null if no skin visible

- "bottleColors": array of {"hex","label"} for colours on the BOTTLE only, or null if no bottle is visible
- "nailColors": array of {"hex","label"} for colours on the SWATCHED NAILS only, or null if no swatched nail is visible
  These two are independent measurements. They are expected to differ. Never merge or reconcile them.

- "discriminators": {
    "bottleEdgeColor": {"hex","label"} — the polish body colour sampled at the EDGE/RIM of the bottle glass, where the clean base shows through even if the bottle face is dominated by shimmer. null if no bottle edge is legible. This is the most reliable anchor available; prefer it over any face reading,
    "baseColor": {"hex","label"} read from the flattest most face-on patch of nail, or null if no such patch exists,
    "shiftColors": array of {"hex","label"} — other colours the polish travels through at other angles ([] if it does not shift),
    "shimmerFlashColors": array of {"hex","label"} — the colour(s) the shimmer flashes ([] if none),
    "magneticLineColor": {"hex","label"} — colour of the magnetic line/stripe itself, or null if not magnetic,
    "glitterColors": array of {"hex","label"} ([] if no glitter),
    "flakeColors": array of {"hex","label"} ([] if no flakes),
    "thermalCold": {"hex","label"} — the cold-state colour, or null if not thermal,
    "thermalWarm": {"hex","label"} — the warm-state colour, or null if not thermal
  }

- "componentFinish": {
    "glitterFinish": e.g. "matte" | "holographic" | "iridescent" | null,
    "flakeFinish": e.g. "ultrachrome" | "iridescent" | null,
    "flakeSize": "none" | "fine" | "medium" | "large" | null
  }
  These describe the PARTICLES only and must never describe the polish itself.

- "observedEffects": array of finishes/effects you can actually SEE in the polish (e.g. "shimmer","magnetic","holographic","multichrome","thermal","flakies","glitter","reflective"). Observation only — do not infer from any text.

- "altText": ${ctx.collectionMode
    ? `describe what is shown WITHOUT naming any shade. Format: "{effect/finish} ${ctx.brand} nail polish, {what's shown}, {skin tone if visible}, {lighting note}"`
    : `"{effect/finish} ${ctx.brand} nail polish in ${ctx.productName}, {what's shown}, {skin tone if visible}, {lighting note}"`}

- "imageQuality": 0.0-1.0 — is the IMAGE legible? Focus, exposure, framing, occlusion. A sharp well-lit photo scores high EVEN IF the polish is hard to identify.
- "identification": 0.0-1.0 — how confidently could this polish be pinned down from THIS FRAME ALONE, ignoring anything you were told? A sharp photo of an ambiguous shade scores LOW here and HIGH on imageQuality. These two are independent; do not copy one into the other.

Return ONLY the JSON object. No markdown fencing, no explanation.`;
}

/** Fill in derived/legacy fields and normalize anything the model left out. */
export function normalizeAnalysis(raw: Partial<ImageAnalysis>, ctx: PromptContext): ImageAnalysis {
  const disc: Discriminators = {
    bottleEdgeColor: raw.discriminators?.bottleEdgeColor ?? null,
    baseColor: raw.discriminators?.baseColor ?? null,
    shiftColors: raw.discriminators?.shiftColors ?? [],
    shimmerFlashColors: raw.discriminators?.shimmerFlashColors ?? [],
    magneticLineColor: raw.discriminators?.magneticLineColor ?? null,
    glitterColors: raw.discriminators?.glitterColors ?? [],
    flakeColors: raw.discriminators?.flakeColors ?? [],
    thermalCold: raw.discriminators?.thermalCold ?? null,
    thermalWarm: raw.discriminators?.thermalWarm ?? null,
  };

  const nail = raw.nailColors ?? null;
  const bottle = raw.bottleColors ?? null;

  // Legacy dominantColors: prefer the NAIL reading (that is what the catalog
  // means by a shade's colour), anchored on baseColor so the first entry is the
  // stable value rather than whatever dominated the frame.
  // Anchor order: the bottle-edge read is the most repeatable, then the face-on
  // nail patch, then whatever the frame happened to emphasise.
  const legacy: ColorEntry[] = [];
  const anchor = disc.bottleEdgeColor ?? disc.baseColor;
  if (anchor) legacy.push(anchor);
  if (disc.baseColor && disc.baseColor !== anchor) legacy.push(disc.baseColor);
  for (const c of nail ?? bottle ?? []) {
    if (!legacy.some((x) => x.hex?.toLowerCase() === c.hex?.toLowerCase())) legacy.push(c);
  }

  const imageQuality = raw.imageQuality ?? raw.confidence ?? 0.5;
  const identification = raw.identification ?? raw.confidence ?? 0.5;

  return {
    imageType: raw.imageType ?? "unknown",
    lightingCondition: raw.lightingCondition ?? "unknown",
    nailCount: raw.nailCount ?? 0,
    skinTone: raw.skinTone ?? null,
    bottleColors: bottle,
    nailColors: nail,
    discriminators: disc,
    componentFinish: {
      glitterFinish: raw.componentFinish?.glitterFinish ?? null,
      flakeFinish: raw.componentFinish?.flakeFinish ?? null,
      flakeSize: raw.componentFinish?.flakeSize ?? null,
    },
    observedEffects: raw.observedEffects ?? [],
    altText: raw.altText ?? `${ctx.brand} nail polish`,
    imageQuality,
    identification,
    dominantColors: legacy,
    // Legacy single confidence: identification is the honest answer for
    // downstream weighting, since that is what callers were treating it as.
    confidence: identification,
    parseFailed: raw.parseFailed,
  };
}

/** The value returned when the model's reply cannot be parsed at all. */
export function parseFailure(ctx: PromptContext): ImageAnalysis {
  return normalizeAnalysis(
    {
      imageType: "unknown",
      lightingCondition: "unknown",
      nailCount: 0,
      skinTone: null,
      bottleColors: null,
      nailColors: null,
      observedEffects: [],
      altText: ctx.collectionMode
        ? `${ctx.brand} nail polish`
        : `${ctx.brand} nail polish ${ctx.productName}`,
      imageQuality: 0.1,
      identification: 0.1,
      parseFailed: true,
    },
    ctx,
  );
}

/** Strip markdown fencing some models add despite instructions, then parse. */
export function parseModelJson(text: string, ctx: PromptContext): ImageAnalysis {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return normalizeAnalysis(JSON.parse(cleaned) as Partial<ImageAnalysis>, ctx);
  } catch {
    // Models occasionally wrap the object in prose; salvage the outermost {...}.
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return normalizeAnalysis(JSON.parse(cleaned.slice(first, last + 1)) as Partial<ImageAnalysis>, ctx);
      } catch { /* fall through */ }
    }
    return parseFailure(ctx);
  }
}
