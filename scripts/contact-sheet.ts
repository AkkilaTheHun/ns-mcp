/**
 * contact-sheet — tile a folder of images into a labelled grid for eyeballing.
 *
 * Used to hand-verify folder groupings before trusting any automated cluster.
 *
 *   pnpm tsx scripts/contact-sheet.ts <imageDir> <outFile.jpg> [tilePx] [cols]
 */
import { readdirSync, writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";

const dir = process.argv[2];
const out = process.argv[3] ?? "contact-sheet.jpg";
const TILE = Number(process.argv[4] ?? 320);
const COLS = Number(process.argv[5] ?? 5);
const LABEL_H = 34;

const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(f)).sort();
if (!files.length) throw new Error(`No images in ${dir}`);

const rows = Math.ceil(files.length / COLS);
const cellH = TILE + LABEL_H;
const W = COLS * TILE;
const H = rows * cellH;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const composites: sharp.OverlayOptions[] = [];
for (let i = 0; i < files.length; i++) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const left = col * TILE;
  const top = row * cellH;

  const tile = await sharp(join(dir, files[i]), { failOn: "none" })
    .rotate()
    .resize(TILE, TILE, { fit: "cover" })
    .jpeg({ quality: 88 })
    .toBuffer();
  composites.push({ input: tile, left, top });

  // Index + swatcher + timestamp, pulled straight out of the camera filename.
  const m = /^Foto_(\d\d\.\d\d\.\d\d)_(\d\d_\d\d_\d\d)(?:_(\d+(?:_\d+)*))?_swatcher-(.+)\.\w+$/i.exec(files[i]);
  const line1 = `#${String(i + 1).padStart(2, "0")}  ${m ? m[4] : files[i].slice(0, 24)}`;
  const line2 = m ? `${m[1]} ${m[2].replace(/_/g, ":")}${m[3] ? `  (${m[3].replace(/_/g, ".")})` : ""}` : "";

  const svg = `<svg width="${TILE}" height="${LABEL_H}">
    <rect width="100%" height="100%" fill="#111"/>
    <text x="6" y="14" font-family="monospace" font-size="12" fill="#fff">${esc(line1)}</text>
    <text x="6" y="28" font-family="monospace" font-size="11" fill="#9ad">${esc(line2)}</text>
  </svg>`;
  composites.push({ input: Buffer.from(svg), left, top: top + TILE });
}

const sheet = await sharp({ create: { width: W, height: H, channels: 3, background: "#000" } })
  .composite(composites)
  .jpeg({ quality: 88 })
  .toBuffer();

writeFileSync(out, sheet);
console.log(`${files.length} images -> ${out} (${W}x${H})`);
files.forEach((f, i) => console.log(`#${String(i + 1).padStart(2, "0")}  ${f}`));
