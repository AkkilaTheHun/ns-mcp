/**
 * Pixel snapping — turn reported colours into measured ones.
 *
 * Vision models return colours that are approximately right in hue but are
 * reconstructions rather than samples. Measured on the Halloween 2026 set:
 * most reported hexes had under 1% of pixels within ΔE 10 of them, and one
 * came back with 0.04% — effectively a colour that is not in the photograph.
 *
 * That matters because every downstream number (the shade embedding, the ΔE
 * match, the cluster) treats those hexes as measurements. This module moves
 * each reported colour to the nearest ACTUAL density peak in the image, using
 * mean-shift in LAB space, and reports how far it moved and how much pixel
 * support it ended up with.
 *
 * Mean-shift rather than a plain windowed average: an average over a wide
 * window drags toward whatever dominates the frame (skin, background), which
 * would be worse than not snapping at all. Mean-shift climbs to the nearest
 * local mode and stays there.
 */
import sharp from "sharp";
import { rgbToLab, hexToLab, deltaE76, type Lab } from "../util/color.js";
import { labToHex } from "../util/feature-extract.js";
import type { ColorEntry, ImageAnalysis } from "./schema.js";

export interface PixelIndex {
  labs: Lab[];
  width: number;
  height: number;
}

/** Decode an image to a flat LAB array at reduced resolution. */
export async function buildPixelIndex(buffer: Buffer, sample = 320): Promise<PixelIndex> {
  const { data, info } = await sharp(buffer, { failOn: "none" })
    .resize(sample, sample, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const labs: Lab[] = new Array(info.width * info.height);
  for (let i = 0; i < labs.length; i++) {
    const o = i * info.channels;
    labs[i] = rgbToLab(data[o], data[o + 1], data[o + 2]);
  }
  return { labs, width: info.width, height: info.height };
}

export interface SnapResult {
  hex: string;
  originalHex: string;
  /** How far the colour moved to reach a real cluster. */
  movedDeltaE: number;
  /** Fraction of pixels (0-100) within the final window. */
  supportPct: number;
  /** False when no cluster was found and the original was kept as-is. */
  snapped: boolean;
}

const RADIUS = 18;      // LAB window for the mode search
const MIN_SUPPORT = 30; // pixels; below this there is nothing to snap to
const ITERATIONS = 4;

/**
 * Move `hex` to the nearest colour density peak in the image.
 *
 * The window is deliberately modest: wide enough to find the real cluster a
 * near-miss reconstruction belongs to, narrow enough that a sparse-but-real
 * colour (a magnetic line, scattered flakes) is not swallowed by the base.
 */
export function snapColor(index: PixelIndex, hex: string): SnapResult {
  let target: Lab;
  try { target = hexToLab(hex); } catch {
    return { hex, originalHex: hex, movedDeltaE: 0, supportPct: 0, snapped: false };
  }

  let current = target;
  let hits = 0;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let wsum = 0, l = 0, a = 0, b = 0;
    hits = 0;
    for (const px of index.labs) {
      const d = deltaE76(px, current);
      if (d > RADIUS) continue;
      // Triangular kernel: closer pixels pull harder, so the mode wins over
      // a long tail of marginal matches.
      const w = 1 - d / RADIUS;
      wsum += w; hits++;
      l += px[0] * w; a += px[1] * w; b += px[2] * w;
    }
    if (hits < MIN_SUPPORT || wsum === 0) {
      return { hex, originalHex: hex, movedDeltaE: 0, supportPct: 0, snapped: false };
    }
    const next: Lab = [l / wsum, a / wsum, b / wsum];
    const step = deltaE76(next, current);
    current = next;
    if (step < 0.5) break; // converged
  }

  return {
    hex: labToHex(current),
    originalHex: hex,
    movedDeltaE: Math.round(deltaE76(current, target) * 10) / 10,
    supportPct: Math.round((hits / index.labs.length) * 10000) / 100,
    snapped: true,
  };
}

export interface SnapReport {
  snappedCount: number;
  unsnappedCount: number;
  /** Largest distance any single colour had to move. Large = the model drifted. */
  maxMovedDeltaE: number;
  meanMovedDeltaE: number;
  details: Array<{ field: string; from: string; to: string; movedDeltaE: number; supportPct: number }>;
}

/**
 * Snap every colour in an analysis in place and return an audit trail.
 *
 * The snapped values REPLACE the reported ones, because everything downstream
 * consumes them as measurements. The originals are preserved in the report so a
 * drifting model is visible rather than silently corrected.
 */
export function snapAnalysis(index: PixelIndex, analysis: ImageAnalysis): SnapReport {
  const details: SnapReport["details"] = [];
  let snappedCount = 0, unsnappedCount = 0, movedSum = 0, maxMoved = 0;

  const apply = (field: string, entry: ColorEntry | null | undefined) => {
    if (!entry?.hex) return;
    const r = snapColor(index, entry.hex);
    if (!r.snapped) { unsnappedCount++; return; }
    snappedCount++;
    movedSum += r.movedDeltaE;
    if (r.movedDeltaE > maxMoved) maxMoved = r.movedDeltaE;
    if (r.movedDeltaE >= 1) {
      details.push({ field, from: r.originalHex, to: r.hex, movedDeltaE: r.movedDeltaE, supportPct: r.supportPct });
    }
    entry.hex = r.hex;
  };

  const list = (field: string, entries?: ColorEntry[] | null) =>
    (entries ?? []).forEach((e, i) => apply(`${field}[${i}]`, e));

  const d = analysis.discriminators;
  apply("discriminators.bottleEdgeColor", d.bottleEdgeColor);
  apply("discriminators.baseColor", d.baseColor);
  list("discriminators.shiftColors", d.shiftColors);
  list("discriminators.shimmerFlashColors", d.shimmerFlashColors);
  apply("discriminators.magneticLineColor", d.magneticLineColor);
  list("discriminators.glitterColors", d.glitterColors);
  list("discriminators.flakeColors", d.flakeColors);
  apply("discriminators.thermalCold", d.thermalCold);
  apply("discriminators.thermalWarm", d.thermalWarm);
  list("bottleColors", analysis.bottleColors);
  list("nailColors", analysis.nailColors);

  // dominantColors is a derived view; rebuild it from the snapped anchors so
  // legacy consumers get measured values too.
  const anchor = d.bottleEdgeColor ?? d.baseColor;
  const legacy: ColorEntry[] = [];
  if (anchor) legacy.push({ ...anchor });
  for (const c of analysis.nailColors ?? analysis.bottleColors ?? []) {
    if (!legacy.some((x) => x.hex.toLowerCase() === c.hex.toLowerCase())) legacy.push({ ...c });
  }
  if (legacy.length) analysis.dominantColors = legacy;

  return {
    snappedCount,
    unsnappedCount,
    maxMovedDeltaE: Math.round(maxMoved * 10) / 10,
    meanMovedDeltaE: snappedCount ? Math.round((movedSum / snappedCount) * 10) / 10 : 0,
    details,
  };
}
