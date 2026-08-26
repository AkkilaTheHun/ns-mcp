/**
 * assign-shades — show the model an image and the collection's shade
 * descriptions, and ask which shade it is.
 *
 * This is the direct approach to the actual problem: images are in the wrong
 * folders, which is an ASSIGNMENT question, not a measurement question. It
 * needs no stable per-frame colour, no clustering, no thresholds — the model
 * matches a photograph against ten descriptions, which is what the descriptions
 * were written for.
 *
 *   pnpm tsx scripts/assign-shades.ts <folderPath> [maxImages]
 *   pnpm tsx scripts/assign-shades.ts --files <dir> [maxImages]
 */
import "dotenv/config";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { listOwnFolderImages, downloadOwnFile } from "../src/dropbox/client.js";

const DATA = JSON.parse(readFileSync(join(process.cwd(), "data", "halloween-2026.json"), "utf-8"));
const OUT = join(process.cwd(), "output", "vision-ab", "assign");
mkdirSync(OUT, { recursive: true });

const shades = Object.entries(DATA.shades as Record<string, { vendorDescription: string; polishType: string }>);

const SHADE_LIST = shades
  .map(([name, s], i) => `${i + 1}. ${name} — ${s.vendorDescription} (type: ${s.polishType})`)
  .join("\n");

/**
 * Deliberately short. The model is being asked to recognise, not to measure —
 * the elaborate measurement guidance that a colour-catalog pass needs would
 * only distract from a matching decision.
 */
const PROMPT = `This photograph shows one nail polish from the ${DATA.brand} ${DATA.collection} collection. Identify which one.

The collection:
${SHADE_LIST}

How these polishes render, so you can read the photograph:
- A MAGNETIC has its metallic particles pulled into a bright concentrated band or swirl, with a duller field either side. In the BOTTLE the polish is unmagnetised, so there is no band — just the base and scattered particles. An "aurora" shimmer travels through several colours, so one polish can look green in one frame and orange in another.
- A THERMAL has two states and may show both at once mid-transition. A frame showing only one state still belongs to that thermal.
- A TOPPER has a clear base; the particles are the product. Whatever colour sits underneath is NOT this polish.
- A base described as "sheer" may be almost invisible under dense particles.

Judge on the whole combination — base colour, particle colours, and what kind of effect it is — not on whichever colour happens to fill the most pixels, which changes with the angle.

If two shades are plausible, say so rather than guessing. If it matches none of them, say that.

Return ONLY this JSON, no fencing:
{"shade": "<exact name from the list, or null>", "confidence": <0.0-1.0>, "alternative": "<second-best name, or null>", "reason": "<max 20 words>"}`;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
const client = new Anthropic({ apiKey });

/**
 * Assign a BATCH of frames in one call.
 *
 * Judging frames together beats judging them one at a time, because a single
 * frame can be genuinely ambiguous while the set is not: one angle of an aurora
 * shimmer, a bottle shot with no magnetic band, a thermal caught in one state.
 * Seeing the group lets an unambiguous frame settle its neighbours — and a
 * swatcher's burst is usually one shade, so the group carries real evidence.
 */
async function assignBatch(files: Array<{ name: string; buf: Buffer }>): Promise<any[]> {
  const content: any[] = [];
  for (let i = 0; i < files.length; i++) {
    const jpg = await sharp(files[i].buf, { failOn: "none" }).rotate()
      .resize({ width: 1568, withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    content.push({ type: "text", text: `IMAGE ${i + 1}: ${files[i].name}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  content.push({ type: "text", text: `${PROMPT}

You are shown ${files.length} images together. Judge each one, but USE THE GROUP: a
frame that is ambiguous alone is often settled by a clearer frame of the same
polish. These images may or may not all be the same shade — say what each one is,
and do not force them to agree.

Return ONLY a JSON array, one object per image in order, no fencing:
[{"image": <number>, "shade": "<exact name or null>", "confidence": <0.0-1.0>, "alternative": "<name or null>", "reason": "<max 20 words>"}]` });

  const res = await client.messages.create({
    model: "claude-sonnet-4-6", max_tokens: 8000,
    messages: [{ role: "user", content }],
  });
  const b = res.content.find((x) => x.type === "text");
  const text = (b && "text" in b ? b.text : "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // Salvage per-object rather than all-or-nothing: a truncated array used to
  // discard every result in the batch, which looked like a method failure when
  // it was only a max_tokens problem.
  let arr: any[] = [];
  try {
    arr = JSON.parse(text);
  } catch {
    arr = [...text.matchAll(/\{[^{}]*"shade"[^{}]*\}/g)]
      .map((m) => { try { return JSON.parse(m[0]); } catch { return null; } })
      .filter(Boolean) as any[];
  }
  const byIndex = new Map<number, any>();
  arr.forEach((o, i) => byIndex.set(typeof o?.image === "number" ? o.image - 1 : i, o));
  return files.map((f, i) => ({
    file: f.name,
    ...(byIndex.get(i) ?? { shade: null, confidence: 0, reason: "no result returned" }),
  }));
}

const arg = process.argv[2];
const MAX = Number(process.argv[3] ?? 40);
const CONCURRENCY = 6;

interface Item { name: string; load: () => Promise<Buffer> }
let items: Item[] = [];
let label = "";

if (arg === "--files") {
  const dir = process.argv[3];
  label = basename(dir);
  items = readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f))
    .map((f) => ({ name: f, load: async () => readFileSync(join(dir, f)) }));
} else {
  label = basename(arg);
  const files = (await listOwnFolderImages(arg)).slice(0, MAX);
  items = files.map((f) => ({ name: f.name, load: () => downloadOwnFile(f.path) }));
}

console.log(`Assigning ${items.length} images from "${label}" against ${shades.length} descriptions\n`);

const swatcherOf = (f: string) => /_swatcher-(.+)\.\w+$/i.exec(f)?.[1] ?? "?";

// Batch by swatcher: a burst is usually one shade, so grouping gives the model
// the most useful context without asserting they must agree.
const groups = new Map<string, Item[]>();
for (const it of items) {
  const k = swatcherOf(it.name);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(it);
}

const results: any[] = [];
for (const [swatcher, group] of groups) {
  const loaded = await Promise.all(group.map(async (g) => ({ name: g.name, buf: await g.load() })));
  // Cap per call so a large burst does not blow the context.
  // Past 20 images per request a stricter 2000px per-image cap applies,
  // so keep batches under that to stay at full resolution.
  for (let i = 0; i < loaded.length; i += 6) {
    results.push(...await assignBatch(loaded.slice(i, i + 6)));
  }
  process.stderr.write(`  ${swatcher}: ${group.length} frames\n`);
}
for (const r of results.sort((a, b) => swatcherOf(a.file).localeCompare(swatcherOf(b.file)))) {
  const alt = r.alternative ? ` (alt: ${r.alternative})` : "";
  console.log(`${swatcherOf(r.file).padEnd(20)} ${String(r.shade ?? "NONE").padEnd(30)} ${r.confidence}${alt}`);
  console.log(`     ${r.reason}`);
}

const tally: Record<string, number> = {};
for (const r of results) tally[r.shade ?? "NONE"] = (tally[r.shade ?? "NONE"] ?? 0) + 1;
console.log(`\nTally for folder "${label}":`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}${k === label ? "   <-- matches folder name" : ""}`);
}

writeFileSync(join(OUT, `${label.replace(/[^\w'\- ]/g, "_")}.json`), JSON.stringify(results, null, 2));
