/**
 * Recompute aggregate shade_signatures fields from the underlying image_signatures rows.
 * Shared between the MCP shade_index tool and the standalone CLI scripts.
 *
 * Aggregation model (see ~/dev/lacqr/docs/shade-aggregation-model.md):
 *   Phase 1: Confidence-weighted averaging
 *   Phase 2: Image-type weighting (separate weight tables for base vs flake features)
 *
 * Effective weight per image:
 *   base_weight  = BASE_WEIGHTS[image_type] × confidence
 *   flake_weight = FLAKE_WEIGHTS[image_type] × confidence
 */
import { getSupabase } from "./client.js";
import { extractAndEmbed, meanLab, labToHex, type ImageAnalysisLike } from "../util/feature-extract.js";

function parseEmbedding(raw: number[] | string | null): number[] | null {
  if (raw === null) return null;
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw) as number[];
  } catch {
    return null;
  }
}

// Phase 2 weight tables.
// Base color and embedding: representative-of-the-shade view.
// Macro is downweighted because it fills the frame with flakes, not base.
// Bottle_standalone is heavily downweighted because the bottle glass tints color.
const BASE_WEIGHTS: Record<string, number> = {
  swatch_on_nails:   1.0,
  bottle_in_hand:    0.7,
  macro_detail:      0.5,
  swatch_wheel:      0.4,
  swatch_stick:      0.4,
  layering_demo:     0.3,
  bottle_standalone: 0.1,
  lifestyle:         0.1,
  group_shot:        0.0,
  unknown:           0.3,
};

// Flake features (colors, sizes, effect booleans): macro is best signal.
// Bottle_standalone gets a bit more weight here than for base color,
// because flake colors are visible through the glass.
const FLAKE_WEIGHTS: Record<string, number> = {
  macro_detail:      1.5,
  swatch_on_nails:   1.0,
  swatch_wheel:      0.6,
  swatch_stick:      0.6,
  bottle_in_hand:    0.6,
  layering_demo:     0.5,
  bottle_standalone: 0.3,
  lifestyle:         0.2,
  group_shot:        0.0,
  unknown:           0.4,
};

// Minimum flake_weight for an image to vote on flake_size. Below this
// threshold the image's "I sort of saw fine flakes through bottle glass"
// vote is suppressed.
const FLAKE_SIZE_VOTE_THRESHOLD = 0.5;

function baseWeight(imageType: string | null, confidence: number | null): number {
  const type = imageType ?? "unknown";
  const tw = BASE_WEIGHTS[type] ?? BASE_WEIGHTS.unknown;
  const c = confidence ?? 0.5;
  return tw * c;
}

function flakeWeight(imageType: string | null, confidence: number | null): number {
  const type = imageType ?? "unknown";
  const tw = FLAKE_WEIGHTS[type] ?? FLAKE_WEIGHTS.unknown;
  const c = confidence ?? 0.5;
  return tw * c;
}

/**
 * Vendor-supplied overrides for shade attributes. When provided, these
 * BYPASS the per-image majority-vote aggregation for those specific fields.
 * Use to enforce vendor-truth attrs from product description over Sonnet's
 * possibly-hallucinatory per-image perception.
 */
export interface VendorAttrs {
  finishType?: string | null;
  hasUltrachrome?: boolean;
  hasIridescent?: boolean;
  hasHolographic?: boolean;
  hasThermal?: boolean;
  hasMagnetic?: boolean;
  flakeSize?: string | null;
}

export async function recomputeShadeAggregate(
  shadeId: number,
  vendorAttrs?: VendorAttrs,
): Promise<void> {
  const supabase = getSupabase();

  const { data: images, error } = await supabase
    .from("image_signatures")
    .select("base_color_lab, embedding, observed_effects, dominant_colors, discriminators, component_finish, image_type, confidence")
    .eq("shade_id", shadeId);
  if (error) throw new Error(`Failed to load image signatures: ${error.message}`);
  if (!images || !images.length) return;

  // ------------------------------------------------------------------
  // Weighted LAB and embedding average (Phase 1 × Phase 2 multiplicatively)
  // ------------------------------------------------------------------
  let labSum: [number, number, number] = [0, 0, 0];
  let labWeightSum = 0;
  const embSum = new Array<number>(50).fill(0);
  let embWeightSum = 0;

  for (const i of images as Array<{
    base_color_lab: number[] | null;
    embedding: number[] | string | null;
    image_type: string | null;
    confidence: number | null;
  }>) {
    const w = baseWeight(i.image_type, i.confidence);
    if (w <= 0) continue;

    const lab = i.base_color_lab;
    if (Array.isArray(lab) && lab.length === 3) {
      labSum[0] += lab[0] * w;
      labSum[1] += lab[1] * w;
      labSum[2] += lab[2] * w;
      labWeightSum += w;
    }

    const emb = parseEmbedding(i.embedding ?? null);
    if (emb && emb.length === 50) {
      for (let k = 0; k < 50; k++) embSum[k] += emb[k] * w;
      embWeightSum += w;
    }
  }

  // Fallback to unweighted mean if all images had zero weight
  // (e.g., catalog only has group_shot entries somehow). meanLab is the
  // straight unweighted average; only used as a safety net.
  let avgLab: [number, number, number] | null = null;
  if (labWeightSum > 0) {
    avgLab = [labSum[0] / labWeightSum, labSum[1] / labWeightSum, labSum[2] / labWeightSum];
  } else {
    const labs = (images as Array<{ base_color_lab: number[] | null }>)
      .map((i) => i.base_color_lab)
      .filter((l): l is number[] => Array.isArray(l) && l.length === 3) as Array<[number, number, number]>;
    avgLab = meanLab(labs);
  }

  let avgEmb: number[] | null = null;
  if (embWeightSum > 0) {
    avgEmb = embSum.map((s) => s / embWeightSum);
  } else {
    const emds = (images as Array<{ embedding: number[] | string | null }>)
      .map((i) => parseEmbedding(i.embedding ?? null))
      .filter((e): e is number[] => e !== null && e.length === 50);
    avgEmb = emds.length
      ? emds.reduce<number[]>((acc, e) => acc.map((v, idx) => v + e[idx]), new Array(50).fill(0)).map((s) => s / emds.length)
      : null;
  }

  // ------------------------------------------------------------------
  // Per-image structured features (flake attrs, finish_type, sizes)
  // ------------------------------------------------------------------
  type Img = {
    observed_effects?: string[] | null;
    dominant_colors?: unknown;
    // Without these the aggregate re-derives everything by scraping
    // dominant_colors, discarding the structured measurement stored per image.
    discriminators?: unknown;
    component_finish?: unknown;
    image_type?: string | null;
    confidence?: number | null;
  };
  const perImage = (images as Img[]).map((img) => ({
    flake: extractAndEmbed({
      discriminators: img.discriminators as never,
      componentFinish: img.component_finish as never,
      observedEffects: img.observed_effects ?? [],
      dominantColors: (img.dominant_colors as ImageAnalysisLike["dominantColors"]) ?? [],
    }).flake,
    flakeWeight: flakeWeight(img.image_type ?? null, img.confidence ?? null),
  }));

  // ------------------------------------------------------------------
  // Boolean attrs: weighted-yes vs weighted-no (≥50% by weight)
  // ------------------------------------------------------------------
  const yes = { ultrachrome: 0, iridescent: 0, holographic: 0, thermal: 0, magnetic: 0 };
  let totalFlakeWeight = 0;
  for (const p of perImage) {
    const w = p.flakeWeight;
    if (w <= 0) continue;
    totalFlakeWeight += w;
    if (p.flake.hasUltrachrome) yes.ultrachrome += w;
    if (p.flake.hasIridescent) yes.iridescent += w;
    if (p.flake.hasHolographic) yes.holographic += w;
    if (p.flake.hasThermal) yes.thermal += w;
    if (p.flake.hasMagnetic) yes.magnetic += w;
  }
  const threshold = totalFlakeWeight / 2;

  // ------------------------------------------------------------------
  // finish_type: weighted mode (sum of flake weights per type, take max)
  // ------------------------------------------------------------------
  const finishWeights = new Map<string, number>();
  for (const p of perImage) {
    if (!p.flake.finishType || p.flakeWeight <= 0) continue;
    finishWeights.set(p.flake.finishType, (finishWeights.get(p.flake.finishType) ?? 0) + p.flakeWeight);
  }
  const finishType = [...finishWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // ------------------------------------------------------------------
  // flake_size: largest size present, but only counting images with
  // sufficient flake-weight (suppresses "I see fine flakes through
  // tinted bottle glass" votes).
  // ------------------------------------------------------------------
  // Weighted mode, not max. Taking the largest size present let two outlying
  // frames out of twenty-four decide the shade: 22 images reported "none" and
  // the aggregate still came back "fine". A flake size is a property of the
  // polish, so it should be what most of the evidence says, not what the most
  // generous frame says.
  const sizeRank = { none: 0, fine: 1, medium: 2, large: 3 } as const;
  type SizeKey = keyof typeof sizeRank;
  const sizeWeights = new Map<SizeKey, number>();
  for (const p of perImage) {
    if (p.flakeWeight < FLAKE_SIZE_VOTE_THRESHOLD) continue;
    sizeWeights.set(p.flake.flakeSize, (sizeWeights.get(p.flake.flakeSize) ?? 0) + p.flakeWeight);
  }
  // Fallback: nothing cleared the weight threshold — vote unweighted so a
  // low-confidence set still yields an answer rather than defaulting to none.
  if (sizeWeights.size === 0) {
    for (const p of perImage) {
      sizeWeights.set(p.flake.flakeSize, (sizeWeights.get(p.flake.flakeSize) ?? 0) + 1);
    }
  }
  // Ties break toward the larger size — under-calling a flake is the worse error.
  const winningSize = [...sizeWeights.entries()]
    .sort((a, b) => b[1] - a[1] || sizeRank[b[0]] - sizeRank[a[0]])[0]?.[0] ?? "none";
  const flakeSize = winningSize === "none" ? null : winningSize;

  // ------------------------------------------------------------------
  // flake_colors_hex: top-3 by weighted frequency
  // ------------------------------------------------------------------
  const colorWeights = new Map<string, number>();
  for (const p of perImage) {
    if (p.flakeWeight <= 0) continue;
    for (const hex of p.flake.flakeColorsHex) {
      colorWeights.set(hex, (colorWeights.get(hex) ?? 0) + p.flakeWeight);
    }
  }
  const flakeColorsHex = [...colorWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hex]) => hex);

  // ------------------------------------------------------------------
  // Vendor overrides win unconditionally over computed values
  // ------------------------------------------------------------------
  const finalFinishType = vendorAttrs?.finishType !== undefined ? vendorAttrs.finishType : finishType;
  const finalFlakeSize = vendorAttrs?.flakeSize !== undefined ? vendorAttrs.flakeSize : flakeSize;
  const finalUltrachrome = vendorAttrs?.hasUltrachrome !== undefined ? vendorAttrs.hasUltrachrome : yes.ultrachrome > threshold;
  const finalIridescent = vendorAttrs?.hasIridescent !== undefined ? vendorAttrs.hasIridescent : yes.iridescent > threshold;
  const finalHolographic = vendorAttrs?.hasHolographic !== undefined ? vendorAttrs.hasHolographic : yes.holographic > threshold;
  const finalThermal = vendorAttrs?.hasThermal !== undefined ? vendorAttrs.hasThermal : yes.thermal > threshold;
  const finalMagnetic = vendorAttrs?.hasMagnetic !== undefined ? vendorAttrs.hasMagnetic : yes.magnetic > threshold;

  await supabase
    .from("shade_signatures")
    .update({
      base_color_lab: avgLab,
      base_color_hex: avgLab ? labToHex(avgLab) : null,
      embedding: avgEmb,
      finish_type: finalFinishType,
      flake_size: finalFlakeSize,
      flake_colors_hex: flakeColorsHex.length ? flakeColorsHex : null,
      has_ultrachrome: finalUltrachrome,
      has_iridescent: finalIridescent,
      has_holographic: finalHolographic,
      has_thermal: finalThermal,
      has_magnetic: finalMagnetic,
      photo_count: images.length,
    })
    .eq("id", shadeId);
}
