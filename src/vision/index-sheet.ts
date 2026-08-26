/**
 * buildIndexSheet — tile verified exemplar photographs into one numbered
 * reference image.
 *
 * Measured to help: without it every frame is matched against PROSE, and the
 * model must imagine what "deep mulberry base packed with blue shimmer" looks
 * like on a nail at an unknown angle. Shades that no person would confuse end
 * up in one group because their sentences rhyme.
 *
 * Cheap: Claude bills images by AREA, so a 20-tile sheet capped at 1568px costs
 * about what a single frame costs.
 *
 * ONLY FEED THIS VERIFIED FRAMES. An index built from the pipeline's own
 * guesses teaches the model its own mistakes, and the errors compound silently
 * because the index then looks like evidence.
 *
 * WHEN SCORING, EXCLUDE THE SHOOT UNDER TEST. Exemplar selection pulls toward
 * the best-verified shoot, which is usually also the benchmark — that leaks the
 * answers and inflates the result. Observed in practice, not hypothetical.
 */
import sharp from "sharp";
import { rgbToLab } from "../util/color.js";

export interface Exemplar {
  shade: string;
  bytes: Buffer;
  /** Who photographed it. Used to spread exemplars across lighting conditions. */
  source?: string;
}

export interface IndexSheetOptions {
  /** Shade order, which fixes the numbering the model will cite. */
  shades: string[];
  exemplars: Exemplar[];
  perShade?: number;
  tilePx?: number;
  /**
   * Value of a fresh photographer, in LAB units.
   *
   * Exemplars need range in TWO dimensions: viewing angle (colour) and lighting
   * (photographer). Maximising colour alone drew several shades' pairs from one
   * shoot, showing how a shade shifts with angle while hiding how it shifts
   * with light.
   */
  sourceBonus?: number;
}

/** Mean colour, skipping background noise and blown highlights. */
async function meanLab(buf: Buffer): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf, { failOn: "none" })
    .rotate().resize(160, 160, { fit: "cover" }).raw().toBuffer({ resolveWithObject: true });
  let L = 0, A = 0, B = 0, n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * info.channels;
    const lab = rgbToLab(data[o], data[o + 1], data[o + 2]);
    if (lab[0] < 12 || lab[0] > 94) continue;
    L += lab[0]; A += lab[1]; B += lab[2]; n++;
  }
  return n ? [L / n, A / n, B / n] : [0, 0, 0];
}

const dist = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Choose the exemplars that look LEAST alike.
 *
 * A shade with travelling shimmer shows a different colour at each end of its
 * travel, so taking the first two available frames is a coin flip on which end
 * you get. Measured consequence: both exemplars for a green-to-blue traveller
 * showed its GREEN face, so frames catching its BLUE end failed to match their
 * own index entry and matched a genuinely blue shade instead.
 *
 * No knowledge of which shades travel is needed: a single-colour shade simply
 * has little distance to maximise, so this is harmless there.
 */
async function pickDiverse(pool: Exemplar[], perShade: number, sourceBonus: number): Promise<Exemplar[]> {
  if (pool.length <= perShade) return pool;
  const scored: Array<{ e: Exemplar; lab: [number, number, number] }> = [];
  for (const e of pool.slice(0, 12)) scored.push({ e, lab: await meanLab(e.bytes) });
  if (scored.length <= perShade) return scored.map((s) => s.e);

  let best: [number, number] = [0, 1];
  let bestD = -1;
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const fresh = scored[i].e.source !== scored[j].e.source ? sourceBonus : 0;
      const d = dist(scored[i].lab, scored[j].lab) + fresh;
      if (d > bestD) { bestD = d; best = [i, j]; }
    }
  }
  const chosen = [scored[best[0]], scored[best[1]]];
  while (chosen.length < perShade) {
    let far: (typeof scored)[number] | null = null;
    let farD = -1;
    for (const s of scored) {
      if (chosen.includes(s)) continue;
      const fresh = chosen.every((c) => c.e.source !== s.e.source) ? sourceBonus : 0;
      const d = Math.min(...chosen.map((c) => dist(c.lab, s.lab))) + fresh;
      if (d > farD) { farD = d; far = s; }
    }
    if (!far) break;
    chosen.push(far);
  }
  return chosen.map((s) => s.e);
}

export async function buildIndexSheet(opts: IndexSheetOptions): Promise<{ sheet: Buffer; legend: string[] }> {
  const perShade = opts.perShade ?? 2;
  const tile = opts.tilePx ?? 300;
  const sourceBonus = opts.sourceBonus ?? 12;

  const byShade = new Map<string, Exemplar[]>();
  for (const e of opts.exemplars) {
    if (!byShade.has(e.shade)) byShade.set(e.shade, []);
    byShade.get(e.shade)!.push(e);
  }

  const LABEL_H = 30;
  const COLS = Math.min(5, Math.max(1, opts.shades.length));
  const BLOCK_H = tile * perShade + LABEL_H;
  const rows = Math.ceil(opts.shades.length / COLS);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const composites: sharp.OverlayOptions[] = [];
  const legend: string[] = [];

  for (let i = 0; i < opts.shades.length; i++) {
    const shade = opts.shades[i];
    const left = (i % COLS) * tile;
    const top = Math.floor(i / COLS) * BLOCK_H;

    // The number is what the model cites, which is far less error-prone than
    // retyping a long shade name.
    composites.push({
      input: Buffer.from(
        `<svg width="${tile}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#000"/>` +
        `<text x="6" y="21" font-family="sans-serif" font-size="17" font-weight="bold" fill="#fff">${i + 1}. ${esc(shade.slice(0, 24))}</text></svg>`,
      ),
      left, top,
    });

    const picks = await pickDiverse(byShade.get(shade) ?? [], perShade, sourceBonus);
    for (let j = 0; j < picks.length && j < perShade; j++) {
      composites.push({
        input: await sharp(picks[j].bytes, { failOn: "none" })
          .rotate().resize(tile, tile, { fit: "cover" }).jpeg({ quality: 90 }).toBuffer(),
        left,
        top: top + LABEL_H + j * tile,
      });
    }
    legend.push(`${i + 1}. ${shade} — ${picks.map((p) => p.source ?? "?").join(", ") || "NO EXEMPLAR"}`);
  }

  const sheet = await sharp({ create: { width: COLS * tile, height: rows * BLOCK_H, channels: 3, background: "#000" } })
    .composite(composites)
    .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();

  return { sheet, legend };
}
