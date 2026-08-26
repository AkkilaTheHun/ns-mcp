/**
 * compare-two-folders — render every frame from TWO staging folders side by
 * side, and measure which of two accent colours dominates each one.
 *
 * Built for the pair nothing else separates. Two clear-base shades whose flake
 * and glitter colours are INVERTED — blue flakes with red glitter versus warm
 * flakes with blue glitter — defeat the description vetoes (identical particle
 * palettes) and defeat a naive hue test (both contain red and blue).
 *
 * But the two particle TYPES are not equally visible. Reflective glitter is
 * sparse; micro flakes are dense and fill the frame. So the reliable signal is
 * FLAKE TEMPERATURE — cool-dominant versus warm-dominant — not the inverted
 * glitter that makes the pair hard in the first place.
 *
 * The chroma floor matters: skin is warm and would otherwise register as warm
 * flakes on every frame. Only vivid pixels are counted, which skin does not
 * reach.
 *
 *   pnpm tsx scripts/compare-two-folders.ts "<root>" "Folder A" "Folder B"
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { listOwnFolderImages, downloadOwnFile } from "../src/dropbox/client.js";
import { detectAccents } from "../src/vision/accent.js";

const ROOT = process.argv[2];
const A = process.argv[3];
const B = process.argv[4];
if (!ROOT || !A || !B) throw new Error('usage: compare-two-folders.ts "<root>" "Folder A" "Folder B"');

const TILE = Number(process.env.TILE ?? 240);
const OUT_DIR = join(process.cwd(), "output", "vision-ab");
mkdirSync(OUT_DIR, { recursive: true });

/**
 * Cool versus warm micro flakes.
 *
 * Wide hue tolerance because these are interference flakes that shift with
 * angle; the question is only which side of the wheel the frame sits on.
 * minChroma 40 clears skin, which sits around 20-30.
 */
const FLAKE_TEMPERATURE = [
  { name: "cool (blue flakes)", hex: "#2E6FD8", minChroma: 40, hueTolerance: 45 },
  { name: "warm (pink/orange/gold flakes)", hex: "#E8853A", minChroma: 40, hueTolerance: 45 },
];

const swatcherOf = (f: string) => /_swatcher-(.+)\.\w+$/i.exec(f)?.[1] ?? "?";

interface Row { folder: string; name: string; buf: Buffer; cool: number; warm: number; verdict: string }

async function load(folder: string): Promise<Row[]> {
  const files = await listOwnFolderImages(`${ROOT}/${folder}`);
  const out: Row[] = [];
  for (const f of files) {
    const buf = await downloadOwnFile(f.path);
    const hits = await detectAccents(buf, FLAKE_TEMPERATURE);
    const cool = hits.find((h) => h.name.startsWith("cool"))?.strength ?? 0;
    const warm = hits.find((h) => h.name.startsWith("warm"))?.strength ?? 0;
    // Abstain when neither reading is clear. A weak margin on a frame that is
    // mostly bottle or mostly skin says nothing, and a confident wrong move is
    // worse than leaving it where a person put it.
    const total = cool + warm;
    const margin = total > 0 ? Math.abs(cool - warm) / total : 0;
    const verdict = total < 0.05 || margin < 0.2 ? "unclear" : cool > warm ? "cool" : "warm";
    out.push({ folder, name: f.name, buf, cool, warm, verdict });
  }
  return out;
}

const rowsA = await load(A);
const rowsB = await load(B);
console.log(`${A}: ${rowsA.length} frames\n${B}: ${rowsB.length} frames\n`);

// --- sheet ------------------------------------------------------------------
const LABEL_H = 34;
const COLS = 8;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const composites: sharp.OverlayOptions[] = [];
let y = 0;

for (const [folder, rows, tint] of [[A, rowsA, "#1d3a5c"], [B, rowsB, "#5c3a1d"]] as const) {
  composites.push({
    input: Buffer.from(
      `<svg width="${COLS * TILE}" height="${LABEL_H}"><rect width="100%" height="100%" fill="${tint}"/>` +
      `<text x="8" y="24" font-family="sans-serif" font-size="19" font-weight="bold" fill="#fff">${esc(folder)} — ${rows.length} frames</text></svg>`,
    ),
    left: 0, top: y,
  });
  y += LABEL_H;

  for (let i = 0; i < rows.length; i++) {
    const left = (i % COLS) * TILE;
    const top = y + Math.floor(i / COLS) * (TILE + LABEL_H);
    composites.push({
      input: await sharp(rows[i].buf, { failOn: "none" }).rotate().resize(TILE, TILE, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer(),
      left, top,
    });
    const v = rows[i].verdict;
    const colour = v === "cool" ? "#7fb2ff" : v === "warm" ? "#ffb06b" : "#999";
    composites.push({
      input: Buffer.from(
        `<svg width="${TILE}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#000"/>` +
        `<text x="4" y="14" font-family="monospace" font-size="11" fill="${colour}">${v.toUpperCase()}  c${rows[i].cool.toFixed(2)} w${rows[i].warm.toFixed(2)}</text>` +
        `<text x="4" y="28" font-family="monospace" font-size="10" fill="#bbb">${esc(rows[i].name.replace(/^Foto_/, "").replace(/_swatcher-.*$/, ""))} ${esc(swatcherOf(rows[i].name).slice(0, 10))}</text></svg>`,
      ),
      left, top: top + TILE,
    });
  }
  y += Math.ceil(rows.length / COLS) * (TILE + LABEL_H) + 10;
}

const sheet = await sharp({ create: { width: COLS * TILE, height: y, channels: 3, background: "#000" } })
  .composite(composites).jpeg({ quality: 86 }).toBuffer();
const out = join(OUT_DIR, "compare-toppers.jpg");
writeFileSync(out, sheet);
console.log(`sheet -> ${out}`);

// --- proposed moves ---------------------------------------------------------
//
// A is expected COOL and B WARM only if the caller passed them that way round;
// infer it from whichever folder the measurements already favour, so this makes
// no assumption about which folder is which shade.
const score = (rows: Row[]) => rows.filter((r) => r.verdict === "cool").length - rows.filter((r) => r.verdict === "warm").length;
const aIsCool = score(rowsA) >= score(rowsB);
const expect = (folder: string) => (folder === A ? (aIsCool ? "cool" : "warm") : aIsCool ? "warm" : "cool");

console.log(`\nMeasured: ${A} is ${aIsCool ? "COOL" : "WARM"}-dominant, ${B} is ${aIsCool ? "WARM" : "COOL"}-dominant\n`);

const moves: Array<{ from: string; to: string; name: string; cool: number; warm: number }> = [];
for (const rows of [rowsA, rowsB]) {
  for (const r of rows) {
    if (r.verdict === "unclear") continue;
    if (r.verdict === expect(r.folder)) continue;
    moves.push({ from: r.folder, to: r.folder === A ? B : A, name: r.name, cool: r.cool, warm: r.warm });
  }
}

if (!moves.length) console.log("No moves suggested — every measurable frame already sits in the folder its flake temperature implies.");
else {
  console.log(`${moves.length} frame(s) sit in the folder OPPOSITE to their flake temperature:\n`);
  for (const m of moves) console.log(`  ${m.from}  ->  ${m.to}\n     ${m.name}   cool ${m.cool.toFixed(2)} / warm ${m.warm.toFixed(2)}`);
}
const unclear = [...rowsA, ...rowsB].filter((r) => r.verdict === "unclear");
console.log(`\n${unclear.length} frame(s) too ambiguous to measure — left alone:`);
for (const u of unclear) console.log(`  ${u.folder}: ${u.name}  cool ${u.cool.toFixed(2)} / warm ${u.warm.toFixed(2)}`);
