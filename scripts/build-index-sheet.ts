/**
 * build-index-sheet — a numbered visual reference of every shade, built from
 * operator-verified frames.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every frame in this pipeline has been judged ALONE against PROSE. The model
 * reads "deep mulberry base, packed with blue shimmer" and has to imagine what
 * that looks like on a nail, at an unknown angle, under someone's kitchen
 * light. Every accuracy failure measured so far traces back to that: shades
 * that look nothing alike to a person end up in one folder because their
 * sentences are similar and their photographs were never compared.
 *
 * An index replaces the imagining with looking. The model gets real photographs
 * of each candidate and answers a much easier question — "which of these ten
 * does the new frame resemble?" — instead of mapping words onto pigment.
 *
 * WHY TWO EXEMPLARS PER SHADE
 * ---------------------------
 * These are goniochromatic pigments: one photograph shows one angle, and a
 * single exemplar would teach the model that a shade IS that colour. Two frames
 * from DIFFERENT swatchers, with different lighting and skin tone, show the
 * range instead — which is the whole difficulty of the task.
 *
 * SOURCE QUALITY MATTERS
 * ----------------------
 * Exemplars are drawn from the shoots the operator identified as the
 * best-photographed and then verified frame by frame. An index built from
 * guesses would teach the model its own mistakes, so only frozen truth is used.
 *
 *   pnpm tsx scripts/build-index-sheet.ts [tilePx]
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { listOwnFolderImages, downloadOwnFile } from "../src/dropbox/client.js";
import { rgbToLab } from "../src/util/color.js";

const TILE = Number(process.argv[2] ?? 300);
const COLLECTION = process.env.COLLECTION ?? "data/halloween-2026.json";
const DATA = JSON.parse(readFileSync(COLLECTION, "utf-8"));

/**
 * Shoots to draw exemplars from, best-photographed first.
 *
 * Order matters: the first available frame per shade is preferred, so a
 * higher-quality shoot supplies the exemplar wherever it has one.
 */
const PREFERRED = (process.env.INDEX_SOURCES ?? "Doseoflolade,_always_polished_,Serpentine13").split(",");
const PER_SHADE = Number(process.env.INDEX_PER_SHADE ?? 2);

/**
 * How much a fresh photographer is worth, in LAB units of colour distance.
 *
 * Exemplars need range in TWO dimensions: viewing angle (colour) and lighting
 * (photographer). Maximising colour alone drew five shades' pair from one
 * shoot, which shows how a shade shifts with angle while hiding how it shifts
 * with light.
 */
const SWATCHER_BONUS = Number(process.env.INDEX_SWATCHER_BONUS ?? 12);

const SOURCE_ROOT = process.env.SOURCE_ROOT ?? "/Halloween 2026";
const OUT_DIR = join(process.cwd(), "output", "vision-ab");
mkdirSync(OUT_DIR, { recursive: true });

/** shade -> [{swatcher, file}], drawn from frozen truth only. */
const candidates = new Map<string, Array<{ swatcher: string; file: string }>>();
for (const swatcher of PREFERRED) {
  const tf = join(process.cwd(), "data", "truth", `${swatcher}.json`);
  if (!existsSync(tf)) { console.log(`  (no frozen truth for ${swatcher}, skipping)`); continue; }
  const frames = JSON.parse(readFileSync(tf, "utf-8")).frames as Record<string, string | null>;
  for (const [file, shade] of Object.entries(frames)) {
    if (!shade) continue;
    if (!candidates.has(shade)) candidates.set(shade, []);
    candidates.get(shade)!.push({ swatcher, file });
  }
}

const shades = Object.keys(DATA.shades);

/**
 * Pick exemplars, preferring DIFFERENT swatchers.
 *
 * Two frames from one shoot share lighting and skin tone and would understate
 * how much a shade varies between photographers — which is precisely the
 * variation the model keeps failing on.
 */
function pickFor(shade: string) {
  const all = candidates.get(shade) ?? [];
  const picked: Array<{ swatcher: string; file: string }> = [];
  const used = new Set<string>();
  for (const swatcher of PREFERRED) {
    if (picked.length >= PER_SHADE) break;
    const hit = all.find((c) => c.swatcher === swatcher && !used.has(c.file));
    if (hit) { picked.push(hit); used.add(hit.file); }
  }
  // Top up from anywhere if some shoot lacked this shade.
  for (const c of all) {
    if (picked.length >= PER_SHADE) break;
    if (!used.has(c.file)) { picked.push(c); used.add(c.file); }
  }
  return picked;
}

/**
 * Average colour of a frame, ignoring background and blown highlights, used to
 * measure how DIFFERENT two frames of the same shade look.
 */
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

/**
 * Choose the exemplars that look LEAST alike.
 *
 * A shade with travelling shimmer shows a different colour at each end of its
 * travel, and picking the first two available frames is a coin flip on which
 * end you get. Measured consequence: both exemplars for a green-to-blue
 * traveller showed its GREEN face, so frames catching its BLUE end failed to
 * match their own index entry and matched a genuinely blue shade instead —
 * four errors in one verified shoot, with the model citing the wrong index
 * number by name.
 *
 * Maximising visual distance between exemplars covers the range instead. This
 * needs no knowledge of which shades travel: a single-colour shade simply has
 * little distance to maximise, so the choice is harmless there.
 */
async function pickDiverse(shade: string, load: (c: { swatcher: string; file: string }) => Promise<Buffer | null>) {
  const all = candidates.get(shade) ?? [];
  if (all.length <= PER_SHADE) return all;

  const scored: Array<{ c: { swatcher: string; file: string }; lab: [number, number, number] }> = [];
  for (const c of all.slice(0, 12)) {
    const buf = await load(c);
    if (buf) scored.push({ c, lab: await meanLab(buf) });
  }
  if (scored.length <= PER_SHADE) return scored.map((s) => s.c);

  // Farthest-point sampling: start from the pair that differ most, then keep
  // adding whichever frame is least like everything already chosen.
  const dist = (a: [number, number, number], b: [number, number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  let best: [number, number] = [0, 1];
  let bestD = -1;
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const fresh = scored[i].c.swatcher !== scored[j].c.swatcher ? SWATCHER_BONUS : 0;
      const d = dist(scored[i].lab, scored[j].lab) + fresh;
      if (d > bestD) { bestD = d; best = [i, j]; }
    }
  }
  const chosen = [scored[best[0]], scored[best[1]]];
  while (chosen.length < PER_SHADE) {
    let far = null as null | (typeof scored)[number];
    let farD = -1;
    for (const s of scored) {
      if (chosen.includes(s)) continue;
      // Visual distance, bonused for coming from a swatcher not yet represented.
      // Colour range and lighting range are BOTH wanted, and optimising colour
      // alone collapsed five shades onto a single photographer.
      const fresh = chosen.every((c) => c.c.swatcher !== s.c.swatcher) ? SWATCHER_BONUS : 0;
      const d = Math.min(...chosen.map((c) => dist(c.lab, s.lab))) + fresh;
      if (d > farD) { farD = d; far = s; }
    }
    if (!far) break;
    chosen.push(far);
  }
  return chosen.map((s) => s.c);
}

// Resolve Dropbox paths once per swatcher.
const pathsBySwatcher = new Map<string, Map<string, string>>();
for (const swatcher of PREFERRED) {
  const files = await listOwnFolderImages(`${SOURCE_ROOT}/${swatcher}`).catch(() => []);
  pathsBySwatcher.set(swatcher, new Map(files.map((f) => [f.name, f.path])));
}

const LABEL_H = 30;
const COLS = 5;
const BLOCK_W = TILE;
const BLOCK_H = TILE * PER_SHADE + LABEL_H;
const rows = Math.ceil(shades.length / COLS);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const composites: sharp.OverlayOptions[] = [];
const legend: string[] = [];

for (let i = 0; i < shades.length; i++) {
  const shade = shades[i];
  const left = (i % COLS) * BLOCK_W;
  const top = Math.floor(i / COLS) * BLOCK_H;

  // Number the shade prominently — the model answers with this number, which is
  // far less error-prone than retyping a long shade name.
  composites.push({
    input: Buffer.from(
      `<svg width="${BLOCK_W}" height="${LABEL_H}">
         <rect width="100%" height="100%" fill="#000"/>
         <text x="6" y="21" font-family="sans-serif" font-size="17" font-weight="bold" fill="#fff">${i + 1}. ${esc(shade.slice(0, 24))}</text>
       </svg>`,
    ),
    left, top,
  });

  const loadFor = async (c: { swatcher: string; file: string }) => {
    const path = pathsBySwatcher.get(c.swatcher)?.get(c.file);
    return path ? await downloadOwnFile(path) : null;
  };
  const picks = process.env.NO_DIVERSE_INDEX ? pickFor(shade) : await pickDiverse(shade, loadFor);
  for (let j = 0; j < PER_SHADE; j++) {
    const p = picks[j];
    if (!p) continue;
    const path = pathsBySwatcher.get(p.swatcher)?.get(p.file);
    if (!path) continue;
    composites.push({
      input: await sharp(await downloadOwnFile(path), { failOn: "none" })
        .rotate().resize(TILE, TILE, { fit: "cover" }).jpeg({ quality: 90 }).toBuffer(),
      left,
      top: top + LABEL_H + j * TILE,
    });
  }
  legend.push(`${i + 1}. ${shade} — ${picks.map((p) => p.swatcher).join(", ") || "NO EXEMPLAR"}`);
}

const sheet = await sharp({
  create: { width: COLS * BLOCK_W, height: rows * BLOCK_H, channels: 3, background: "#000" },
})
  .composite(composites)
  .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
  .jpeg({ quality: 92 })
  .toBuffer();

const out = join(OUT_DIR, "index-sheet.jpg");
writeFileSync(out, sheet);
writeFileSync(join(OUT_DIR, "index-sheet.json"), JSON.stringify({ shades, legend }, null, 2));

const meta = await sharp(sheet).metadata();
console.log(`index sheet -> ${out} (${meta.width}x${meta.height}, ${(sheet.length / 1024).toFixed(0)} KB)`);
for (const l of legend) console.log(`  ${l}`);
