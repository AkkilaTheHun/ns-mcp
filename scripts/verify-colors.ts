/**
 * verify-colors — check that reported colours actually exist in the pixels.
 *
 * A vision model can return a plausible hex that is nowhere in the frame, and
 * nothing downstream would notice. This measures, deterministically:
 *
 *   support  — what fraction of pixels sit within ΔE 10 of the reported colour.
 *              Near-zero means the value was invented.
 *   sat      — saturation of the reported colour vs the frame, which is the
 *              specific test for "did bottleEdgeColor actually sample the
 *              LACQUER at the rim, or just the clear glass?" Glass reads
 *              desaturated and takes its colour from the background; lacquer
 *              at the rim reads at or above the saturation of the bottle face.
 *   spread   — how spatially concentrated the matching pixels are. A rim read
 *              should be a thin band, not the whole frame.
 *
 *   pnpm tsx scripts/verify-colors.ts <runs.json | sweepFolder.json> [imageDir]
 */
import { readFileSync } from "fs";
import { basename, join } from "path";
import sharp from "sharp";
import { rgbToLab, hexToLab, deltaE76, type Lab } from "../src/util/color.js";

const SRC = process.argv[2];
const IMG_DIR = process.argv[3] ?? join(process.cwd(), "output", "vision-ab", "_cache");
if (!SRC) throw new Error("usage: verify-colors.ts <json> [imageDir]");

const MATCH_DE = 10;
const SAMPLE = 500;

interface Report {
  supportPct: number;
  satReported: number;
  spreadPct: number;
  cx: number;
  cy: number;
}

const satOfHex = (hex: string): number => {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : Math.round(((max - min) / max) * 100);
};

async function analyzeImagePixels(file: string) {
  const { data, info } = await sharp(file, { failOn: "none" })
    .rotate()
    .resize(SAMPLE, SAMPLE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const labs: Lab[] = [];
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * info.channels;
    labs.push(rgbToLab(data[o], data[o + 1], data[o + 2]));
  }
  return { labs, w: info.width, h: info.height };
}

function support(px: { labs: Lab[]; w: number; h: number }, hex: string): Report | null {
  let target: Lab;
  try { target = hexToLab(hex); } catch { return null; }

  let hits = 0, sx = 0, sy = 0;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < px.labs.length; i++) {
    if (deltaE76(px.labs[i], target) <= MATCH_DE) {
      const x = i % px.w, y = Math.floor(i / px.w);
      hits++; sx += x; sy += y; xs.push(x); ys.push(y);
    }
  }
  if (!hits) return { supportPct: 0, satReported: satOfHex(hex), spreadPct: 0, cx: 0, cy: 0 };

  const cx = sx / hits, cy = sy / hits;
  // RMS radius of matching pixels, as a % of the frame's half-diagonal.
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += (xs[i] - cx) ** 2 + (ys[i] - cy) ** 2;
  const rms = Math.sqrt(sum / hits);
  const halfDiag = Math.sqrt(px.w ** 2 + px.h ** 2) / 2;

  return {
    supportPct: Math.round((hits / px.labs.length) * 10000) / 100,
    satReported: satOfHex(hex),
    spreadPct: Math.round((rms / halfDiag) * 100),
    cx: Math.round((cx / px.w) * 100),
    cy: Math.round((cy / px.h) * 100),
  };
}

const doc = JSON.parse(readFileSync(SRC, "utf-8"));
const entries: Array<{ file: string; analysis: any }> =
  doc.runs ? doc.runs.filter((r: any) => r.analysis).map((r: any) => ({ file: doc.imageName, analysis: r.analysis }))
  : (doc.images ?? []).filter((i: any) => !i.error).map((i: any) => ({ file: i.filename, analysis: i }));

console.log(`support = % of pixels within ΔE ${MATCH_DE}   spread = RMS radius (low = tight region)   pos = centroid x,y %\n`);

for (const e of entries) {
  const path = join(IMG_DIR, basename(e.file));
  let px;
  try { px = await analyzeImagePixels(path); }
  catch { console.log(`(image not cached: ${basename(e.file)})`); continue; }

  const d = e.analysis.discriminators ?? {};
  const targets: Array<[string, string | undefined]> = [
    ["bottleEdgeColor", d.bottleEdgeColor?.hex],
    ["baseColor", d.baseColor?.hex],
    ["bottleColors[0]", (e.analysis.bottleColors ?? [])[0]?.hex],
    ["nailColors[0]", (e.analysis.nailColors ?? [])[0]?.hex],
  ];

  console.log(`${basename(e.file).slice(0, 52)}`);
  for (const [name, hex] of targets) {
    if (!hex) { console.log(`  ${name.padEnd(16)} —`); continue; }
    const r = support(px, hex);
    if (!r) continue;
    const flag = r.supportPct < 0.05 ? "  <-- NOT IN IMAGE" : "";
    console.log(`  ${name.padEnd(16)} ${hex}  sat ${String(r.satReported).padStart(3)}%  support ${String(r.supportPct).padStart(6)}%  spread ${String(r.spreadPct).padStart(3)}%  pos ${r.cx},${r.cy}${flag}`);
  }

  const edgeSat = d.bottleEdgeColor?.hex ? satOfHex(d.bottleEdgeColor.hex) : null;
  const faceSat = (e.analysis.bottleColors ?? [])[0]?.hex ? satOfHex(e.analysis.bottleColors[0].hex) : null;
  if (edgeSat !== null && faceSat !== null) {
    // Clear glass is desaturated and borrows the background. If the rim read
    // were glass, it would come back markedly LESS saturated than the face.
    const verdict = edgeSat < faceSat - 15 ? "SUSPECT — much flatter than the bottle face, may be glass"
      : edgeSat < 20 ? "SUSPECT — very low saturation, may be glass or highlight"
      : "consistent with lacquer, not clear glass";
    console.log(`  => edge sat ${edgeSat}% vs face sat ${faceSat}%: ${verdict}`);
  }
  console.log();
}
