/**
 * group-check — ask whether the frames in one group are actually one polish.
 *
 * THE CHECK THE PIPELINE NEVER MADE.
 *
 * Every frame is judged ALONE against prose descriptions, then grouped by burst
 * and matching. At no point does anything look at a finished group and ask the
 * obvious question: do these look like the same polish? So a group containing
 * dense pink holographic glitter next to blue metallic shimmer passes silently,
 * both frames at 0.83-0.88 confidence, because neither frame ever saw the other.
 *
 * A human spots that instantly at thumbnail size. It needs no resolution, no
 * colour science and no vendor description — only comparison, which is the one
 * thing the per-frame path structurally cannot do.
 *
 * Cheap by construction: Claude bills images by AREA, so a whole group tiled
 * into one small sheet costs about what a single frame costs, and there are
 * only ~10 groups per shoot.
 *
 *   pnpm tsx scripts/group-check.ts <Swatcher> [tilePx]
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { listOwnFolderImages, downloadOwnFile } from "../src/dropbox/client.js";

const SWATCHER = process.argv[2];
const TILE = Number(process.argv[3] ?? 260);
if (!SWATCHER) throw new Error("usage: group-check.ts <Swatcher> [tilePx]");

const COLLECTION = process.env.COLLECTION ?? "data/halloween-2026.json";
const DATA = JSON.parse(readFileSync(COLLECTION, "utf-8"));
const DIR = join(process.cwd(), "output", "vision-ab", "swatcher");
const doc = JSON.parse(readFileSync(join(DIR, `${SWATCHER}.json`), "utf-8")) as {
  folder: string;
  results: Array<{ file: string; shade: string | null; confidence: number; reason: string }>;
};

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const files = await listOwnFolderImages(doc.folder);
const byName = new Map(files.map((f) => [f.name, f.path]));

/** Tile a group into one labelled sheet, numbered so the model can point. */
async function sheet(names: string[]) {
  const cols = Math.min(5, names.length);
  const rows = Math.ceil(names.length / cols);
  const LABEL = 22;
  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < names.length; i++) {
    const path = byName.get(names[i]);
    if (!path) continue;
    const left = (i % cols) * TILE;
    const top = Math.floor(i / cols) * (TILE + LABEL);
    composites.push({
      input: await sharp(await downloadOwnFile(path), { failOn: "none" })
        .rotate().resize(TILE, TILE, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer(),
      left, top,
    });
    composites.push({
      input: Buffer.from(
        `<svg width="${TILE}" height="${LABEL}"><rect width="100%" height="100%" fill="#111"/>` +
        `<text x="6" y="16" font-family="monospace" font-size="14" fill="#fff">TILE ${i + 1}</text></svg>`,
      ),
      left, top: top + TILE,
    });
  }

  return sharp({ create: { width: cols * TILE, height: rows * (TILE + LABEL), channels: 3, background: "#000" } })
    .composite(composites)
    .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 }).toBuffer();
}

const groups = new Map<string, string[]>();
for (const r of doc.results) {
  if (!r.shade) continue;
  if (!groups.has(r.shade)) groups.set(r.shade, []);
  groups.get(r.shade)!.push(r.file);
}

const shadeList = Object.entries<any>(DATA.shades)
  .map(([n, s]) => `- ${n}: ${s.vendorDescription}`).join("\n");

const findings: any[] = [];
let tokensIn = 0;

for (const [shade, names] of [...groups.entries()].sort()) {
  if (names.length < 2) continue;
  const img = await sheet(names);

  const res = await client.messages.create({
    model: process.env.ASSIGN_MODEL ?? "claude-sonnet-4-6",
    max_tokens: 900,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") } },
        { type: "text", text: `These ${names.length} photographs have all been filed as ONE nail polish: "${shade}" — described by the maker as "${DATA.shades[shade]?.vendorDescription ?? "?"}".

They are numbered TILE 1 to TILE ${names.length}.

Your ONLY job is comparison: do these all show the SAME polish? Ignore the descriptions if you like — the question is whether these tiles look like one product.

Judge on the combination of base colour and effect. Be tolerant of things that genuinely vary between photographs of one polish:
- these are interference pigments, so colour shifts with viewing angle
- lighting, white balance and exposure differ between shots
- a bottle and a painted nail look different in the same frame
- a macro of one nail looks different from a full hand

Be INTOLERANT of a different product: a dense glitter next to a smooth metallic, particles present in some tiles and absent in others, a completely different colour family with no shared effect.

If some tiles do not belong, say which, and say what they look like instead — choosing from this collection where you can:
${shadeList}

Return ONLY this JSON, no fencing:
{"allSame": true|false, "confidence": 0.0-1.0, "oddTiles": [<tile numbers>], "oddLooksLike": "<shade name or description>", "reason": "<max 25 words>"}` },
      ],
    }],
  });

  tokensIn += res.usage.input_tokens;
  const blk = res.content.find((c) => c.type === "text");
  const text = (blk && "text" in blk ? blk.text : "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let v: any;
  try { v = JSON.parse(text); } catch { v = { allSame: null, reason: "unparseable", oddTiles: [] }; }

  const odd = (v.oddTiles ?? []).map((n: number) => names[n - 1]).filter(Boolean);
  findings.push({ shade, frames: names.length, ...v, oddFiles: odd });

  const flag = v.allSame === false ? `SPLIT — tiles ${(v.oddTiles ?? []).join(", ")} look like ${v.oddLooksLike ?? "?"}` : v.allSame === true ? "consistent" : "??";
  console.log(`${shade.padEnd(30)} ${String(names.length).padStart(2)}f  ${flag}`);
  if (v.reason) console.log(`     ${v.reason}`);
  for (const f of odd) console.log(`     -> ${f}`);
}

mkdirSync(join(process.cwd(), "output", "vision-ab", "group-check"), { recursive: true });
writeFileSync(
  join(process.cwd(), "output", "vision-ab", "group-check", `${SWATCHER}.json`),
  JSON.stringify({ swatcher: SWATCHER, findings }, null, 2),
);

const split = findings.filter((f) => f.allSame === false);
console.log(`\n${split.length}/${findings.length} groups hold more than one polish`);
console.log(`${tokensIn.toLocaleString()} input tokens (~$${((tokensIn / 1e6) * 3).toFixed(3)})`);
