/**
 * screen-folders — cross-swatcher consistency check on a staging tree.
 *
 * For each shade folder: tile every swatcher's frames into ONE labelled sheet
 * and ask whether they are all the same polish.
 *
 * This is the check the per-swatcher assignment structurally cannot do. Each
 * swatcher is assigned independently, so a shoot can be internally perfect —
 * ten mutually-distinct groups, every burst confident — while being globally
 * permuted against everyone else's. Only a view that puts two swatchers'
 * frames side by side reveals "your teal is everyone else's blue".
 *
 * Cheap by construction: Claude bills images by AREA, not count, and a sheet is
 * one image capped at a 1568px long edge. ~28 frames tiled cost the same ~1.5k
 * tokens as 12 would — roughly 10x less than sending them individually.
 *
 * The tradeoff is per-frame resolution (~250-300px). That is enough for gross
 * mismatches (blue vs teal) and NOT enough for two genuinely similar shades —
 * the neon-pink vs neon-green thermals would likely survive this pass. Those
 * need the deterministic accent detector, which is free.
 *
 *   pnpm tsx scripts/screen-folders.ts [stagingRoot]
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { listOwnFolder, listOwnFolderImages, downloadOwnFile } from "../src/dropbox/client.js";

const ROOT = process.argv[2] ?? "/NailStuff Staging/Halloween 2026 - v2";
const DATA = JSON.parse(readFileSync(join(process.cwd(), "data", "halloween-2026.json"), "utf-8"));
const OUT = join(process.cwd(), "output", "vision-ab", "screen");
mkdirSync(OUT, { recursive: true });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const swatcherOf = (f: string) => /_swatcher-(.+)\.\w+$/i.exec(f)?.[1] ?? "?";

const TILE = 300;
const LABEL_H = 26;

/** Tile a folder's frames into one sheet, grouped and labelled by swatcher. */
async function buildSheet(files: Array<{ name: string; buf: Buffer }>) {
  // Group by swatcher so a whole group reads as a block — the unit of error is
  // a swatcher's shoot, not an individual frame.
  const sorted = [...files].sort((a, b) => swatcherOf(a.name).localeCompare(swatcherOf(b.name)));
  const cols = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(sorted.length))));
  const rows = Math.ceil(sorted.length / cols);
  const W = cols * TILE;
  const H = rows * (TILE + LABEL_H);

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const left = (i % cols) * TILE;
    const top = Math.floor(i / cols) * (TILE + LABEL_H);
    composites.push({
      input: await sharp(sorted[i].buf, { failOn: "none" }).rotate()
        .resize(TILE, TILE, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer(),
      left, top,
    });
    const svg = `<svg width="${TILE}" height="${LABEL_H}">
      <rect width="100%" height="100%" fill="#111"/>
      <text x="5" y="18" font-family="monospace" font-size="13" fill="#fff">#${String(i + 1).padStart(2, "0")} ${esc(swatcherOf(sorted[i].name))}</text>
    </svg>`;
    composites.push({ input: Buffer.from(svg), left, top: top + TILE });
  }

  const sheet = await sharp({ create: { width: W, height: H, channels: 3, background: "#000" } })
    .composite(composites)
    .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 }).toBuffer();

  return { sheet, order: sorted.map((f) => f.name) };
}

async function screen(shade: string, files: Array<{ name: string; buf: Buffer }>) {
  const { sheet, order } = await buildSheet(files);
  const desc = DATA.shades[shade]?.vendorDescription ?? "(no vendor description on file)";
  const swatchers = [...new Set(order.map(swatcherOf))];

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: sheet.toString("base64") } },
        { type: "text", text: `These ${order.length} photographs have all been filed as ONE nail polish shade — "${shade}" — shot by ${swatchers.length} different swatchers (labelled under each tile: ${swatchers.join(", ")}).

The vendor describes this shade as: "${desc}"

Are they all the same polish?

Judge on the polish itself, not on overall image brightness — different swatchers have different lighting, skin tones and nail shapes, and these are interference pigments whose colour changes with viewing angle, so the SAME polish can look different across frames. What should be consistent is the combination of base colour and effect colours.

Errors here happen a whole swatcher at a time, not one frame at a time, so if a group doesn't belong it will usually be every tile from that swatcher.

Return ONLY this JSON, no fencing:
{"allSame": true|false, "confidence": 0.0-1.0, "oddSwatchers": ["<swatcher name>"], "reason": "<max 25 words>"}` },
      ],
    }],
  });

  const b = res.content.find((c) => c.type === "text");
  const text = (b && "text" in b ? b.text : "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let verdict: any;
  try { verdict = JSON.parse(text); } catch { verdict = { allSame: null, reason: "unparseable", oddSwatchers: [] }; }
  return { shade, frames: order.length, swatchers, ...verdict, tokens: res.usage.input_tokens };
}

const { entries } = await listOwnFolder(ROOT);
const folders = entries.filter((e) => e[".tag"] === "folder").map((e) => e.name).sort();
console.log(`Screening ${folders.length} folders in ${ROOT}\n`);

const results: any[] = [];
let totalIn = 0;

for (const shade of folders) {
  const list = await listOwnFolderImages(`${ROOT}/${shade}`);
  if (!list.length) { console.log(`${shade.padEnd(32)} (empty)`); continue; }
  const files = await Promise.all(list.map(async (f) => ({ name: f.name, buf: await downloadOwnFile(f.path) })));
  const r = await screen(shade, files);
  totalIn += r.tokens ?? 0;
  results.push(r);

  const flag = r.allSame === false ? `SPLIT -> ${(r.oddSwatchers ?? []).join(", ") || "?"}` : r.allSame === true ? "consistent" : "??";
  console.log(`${shade.padEnd(32)} ${String(r.frames).padStart(2)}f  ${String(flag).padEnd(42)} ${r.confidence ?? ""}`);
  console.log(`     ${r.reason}`);
}

writeFileSync(join(OUT, "screen.json"), JSON.stringify(results, null, 2));
const bad = results.filter((r) => r.allSame === false);
console.log(`\n${bad.length}/${results.length} folders flagged as holding more than one polish`);
console.log(`${totalIn.toLocaleString()} input tokens total (~$${((totalIn / 1e6) * 3).toFixed(3)} at Sonnet 4.6 rates)`);
