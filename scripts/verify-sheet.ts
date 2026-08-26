/**
 * verify-sheet — render a swatcher's assignments as a labelled contact sheet,
 * one row per shade, so the grouping can be checked by eye in one glance.
 *
 * The tally says "4 frames in Once You See It". This says whether those four
 * are actually the same polish, which is the only thing that matters.
 *
 *   pnpm tsx scripts/verify-sheet.ts <Swatcher> [tilePx]
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { listOwnFolderImages, downloadOwnFile } from "../src/dropbox/client.js";

const SWATCHER = process.argv[2];
const TILE = Number(process.argv[3] ?? 260);
if (!SWATCHER) throw new Error("usage: verify-sheet.ts <Swatcher> [tilePx]");

const LABEL_W = 250;
const ROW_PAD = 6;

const doc = JSON.parse(
  readFileSync(join(process.cwd(), "output", "vision-ab", "swatcher", `${SWATCHER}.json`), "utf-8"),
) as { swatcher: string; folder: string; results: Array<{ file: string; shade: string | null; confidence: number }> };

const files = await listOwnFolderImages(doc.folder);
const byName = new Map(files.map((f) => [f.name, f.path]));

const groups = new Map<string, typeof doc.results>();
for (const r of doc.results) {
  const k = r.shade ?? "UNASSIGNED";
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}
const rows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const maxCols = Math.max(...rows.map(([, v]) => v.length));

const W = LABEL_W + maxCols * (TILE + ROW_PAD);
const H = rows.length * (TILE + ROW_PAD);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const composites: sharp.OverlayOptions[] = [];
let y = 0;

for (const [shade, items] of rows) {
  // Shade name down the left so a row reads as a claim: "these are all X".
  const svg = `<svg width="${LABEL_W}" height="${TILE}">
    <rect width="100%" height="100%" fill="${shade === "UNASSIGNED" ? "#3a1010" : "#111"}"/>
    <text x="8" y="26" font-family="sans-serif" font-size="15" font-weight="bold" fill="#fff">${esc(shade.slice(0, 26))}</text>
    <text x="8" y="48" font-family="monospace" font-size="12" fill="#9ad">${items.length} frame(s)</text>
  </svg>`;
  composites.push({ input: Buffer.from(svg), left: 0, top: y });

  let x = LABEL_W;
  for (const it of items) {
    const path = byName.get(it.file);
    if (!path) { x += TILE + ROW_PAD; continue; }
    const tile = await sharp(await downloadOwnFile(path), { failOn: "none" })
      .rotate().resize(TILE, TILE, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
    composites.push({ input: tile, left: x, top: y });

    const conf = `<svg width="${TILE}" height="18">
      <rect width="100%" height="100%" fill="#000" opacity="0.65"/>
      <text x="4" y="13" font-family="monospace" font-size="11" fill="${it.confidence >= 0.8 ? "#8f8" : "#fc6"}">${it.confidence}  ${esc(it.file.replace(/^Foto /, "").replace(/\.jpg$/i, ""))}</text>
    </svg>`;
    composites.push({ input: Buffer.from(conf), left: x, top: y + TILE - 18 });
    x += TILE + ROW_PAD;
  }
  y += TILE + ROW_PAD;
}

mkdirSync(join(process.cwd(), "output", "vision-ab"), { recursive: true });
const out = join(process.cwd(), "output", "vision-ab", `verify-${SWATCHER}.jpg`);
writeFileSync(out, await sharp({ create: { width: W, height: H, channels: 3, background: "#000" } })
  .composite(composites).jpeg({ quality: 84 }).toBuffer());
console.log(`${doc.results.length} frames, ${rows.length} groups -> ${out} (${W}x${H})`);
