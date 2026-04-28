/**
 * Recompute aggregate shade_signatures fields from the underlying image_signatures rows.
 * Shared between the MCP shade_index tool and the standalone CLI scripts.
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

export async function recomputeShadeAggregate(shadeId: number): Promise<void> {
  const supabase = getSupabase();

  const { data: images, error } = await supabase
    .from("image_signatures")
    .select("base_color_lab, embedding, observed_effects, dominant_colors")
    .eq("shade_id", shadeId);
  if (error) throw new Error(`Failed to load image signatures: ${error.message}`);
  if (!images || !images.length) return;

  // Average LAB
  const labs = images
    .map((i) => i.base_color_lab as number[] | null)
    .filter((l): l is number[] => Array.isArray(l) && l.length === 3) as Array<[number, number, number]>;
  const avgLab = meanLab(labs);

  // Average embedding
  const embeddings = images
    .map((i) => parseEmbedding(i.embedding as number[] | string | null))
    .filter((e): e is number[] => e !== null && e.length === 50);
  const avgEmb = embeddings.length
    ? embeddings.reduce<number[]>((acc, e) => acc.map((v, idx) => v + e[idx]), new Array(50).fill(0))
        .map((s) => s / embeddings.length)
    : null;

  // Re-derive structured attrs from per-image features
  type Img = { observed_effects?: string[] | null; dominant_colors?: unknown };
  const perImageFeatures = (images as Img[]).map((img) =>
    extractAndEmbed({
      observedEffects: img.observed_effects ?? [],
      dominantColors: (img.dominant_colors as ImageAnalysisLike["dominantColors"]) ?? [],
    }),
  );

  // Boolean attrs: ≥50% vote
  const counts = { ultrachrome: 0, iridescent: 0, holographic: 0, thermal: 0, magnetic: 0 };
  for (const f of perImageFeatures) {
    if (f.flake.hasUltrachrome) counts.ultrachrome++;
    if (f.flake.hasIridescent) counts.iridescent++;
    if (f.flake.hasHolographic) counts.holographic++;
    if (f.flake.hasThermal) counts.thermal++;
    if (f.flake.hasMagnetic) counts.magnetic++;
  }
  const threshold = perImageFeatures.length / 2;

  // finish_type: mode (most common non-null)
  const finishCounts = new Map<string, number>();
  for (const f of perImageFeatures) {
    if (f.flake.finishType) {
      finishCounts.set(f.flake.finishType, (finishCounts.get(f.flake.finishType) ?? 0) + 1);
    }
  }
  const finishType = [...finishCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // flake_size: largest size present (large > medium > fine > none)
  const sizeRank = { none: 0, fine: 1, medium: 2, large: 3 } as const;
  type SizeKey = keyof typeof sizeRank;
  let maxSize: SizeKey = "none";
  for (const f of perImageFeatures) {
    if (sizeRank[f.flake.flakeSize] > sizeRank[maxSize]) {
      maxSize = f.flake.flakeSize;
    }
  }
  const flakeSize = maxSize === "none" ? null : maxSize;

  // flake_colors_hex: top-3 most-frequent across all images
  const colorCounts = new Map<string, number>();
  for (const f of perImageFeatures) {
    for (const hex of f.flake.flakeColorsHex) {
      colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
    }
  }
  const flakeColorsHex = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hex]) => hex);

  await supabase
    .from("shade_signatures")
    .update({
      base_color_lab: avgLab,
      base_color_hex: avgLab ? labToHex(avgLab) : null,
      embedding: avgEmb,
      finish_type: finishType,
      flake_size: flakeSize,
      flake_colors_hex: flakeColorsHex.length ? flakeColorsHex : null,
      has_ultrachrome: counts.ultrachrome > threshold,
      has_iridescent: counts.iridescent > threshold,
      has_holographic: counts.holographic > threshold,
      has_thermal: counts.thermal > threshold,
      has_magnetic: counts.magnetic > threshold,
      photo_count: images.length,
    })
    .eq("id", shadeId);
}
