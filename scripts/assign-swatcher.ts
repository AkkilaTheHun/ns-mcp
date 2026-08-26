/**
 * assign-swatcher — run one photographer's shoot through the shade-assignment
 * pipeline and save the result for review.
 *
 * THIS SCRIPT CONTAINS NO JUDGEMENT. Every decision lives in
 * src/vision/assign-shades.ts, which the assign_shades MCP tool also calls, so
 * what is measured here is exactly what an agent gets from the server.
 *
 * That is the whole point of the file being this short. It used to hold the
 * prompt, the burst logic, the scoring, the matching and the guards — none of
 * which the server had — so the server quietly produced first-pass-quality
 * output while appearing to use the improved pipeline. Anything added here that
 * changes an outcome recreates that bug.
 *
 *   pnpm tsx scripts/assign-swatcher.ts "/Halloween 2026/<Swatcher>" [batchSize]
 *
 * Env:
 *   ASSIGN_MODEL      override the model (default claude-opus-5)
 *   NO_INDEX=1        skip the visual reference index
 *   NO_CORRECTIONS=1  withhold operator answers, to measure the pipeline alone
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import sharp from "sharp";
import { listOwnFolderImages, downloadOwnFile } from "../src/dropbox/client.js";
import { assignShades } from "../src/vision/assign-shades.js";
import { HALLOWEEN_2026_ACCENTS } from "../src/vision/accent.js";

const FOLDER = process.argv[2];
const BATCH = Number(process.argv[3] ?? 12);
if (!FOLDER) throw new Error('usage: assign-swatcher.ts "/Halloween 2026/<Swatcher>" [batchSize]');

const COLLECTION = process.env.COLLECTION ?? join(process.cwd(), "data", "halloween-2026.json");
const DATA = JSON.parse(readFileSync(COLLECTION, "utf-8"));
const OUT = join(process.cwd(), "output", "vision-ab", "swatcher");
mkdirSync(OUT, { recursive: true });

const swatcher = basename(FOLDER);

/** Candidate descriptions, passed as ARGUMENTS — the core never reads a file. */
const shades = Object.entries(DATA.shades as Record<string, any>).map(([name, s]) => ({
  name,
  description: s.vendorDescription,
  polishType: s.polishType,
  uniqueKey: s.uniqueKey,
}));

/**
 * Operator answers for THIS swatcher, keyed by filename.
 *
 * Stored against a filename fragment so they survive re-segmentation; expanded
 * to whole filenames here because the core matches on frame id exactly.
 */
function correctionsFor(files: Array<{ name: string }>): Record<string, string> {
  if (process.env.NO_CORRECTIONS) return {};
  const out: Record<string, string> = {};
  for (const [frag, c] of Object.entries((DATA._operatorCorrections ?? {}) as Record<string, any>)) {
    if (c.swatcher !== swatcher) continue;
    for (const f of files) if (f.name.includes(frag)) out[f.name] = c.shade;
  }
  return out;
}

/** 1568px long edge is the tier Claude downscales to; more is wasted, less loses flake detail. */
const prep = async (buf: Buffer) =>
  sharp(buf, { failOn: "none" }).rotate()
    .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 }).toBuffer();

const files = (await listOwnFolderImages(FOLDER)).sort((a, b) =>
  a.name.localeCompare(b.name, undefined, { numeric: true }),
);
console.log(`${swatcher}: ${files.length} frames, batches of ${BATCH}\n`);

const frames = [];
for (const f of files) frames.push({ id: f.name, bytes: await prep(await downloadOwnFile(f.path)) });

const INDEX_PATH = join(process.cwd(), "output", "vision-ab", "index-sheet.jpg");
const indexSheet = !process.env.NO_INDEX && existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH) : null;
if (indexSheet) console.log("  using reference index sheet");
if (process.env.NO_CORRECTIONS) console.log("  NO_CORRECTIONS=1 — measuring the pipeline alone");

const result = await assignShades({
  shades,
  frames,
  apiKey: process.env.ANTHROPIC_API_KEY!,
  indexSheet,
  corrections: correctionsFor(files),
  accents: HALLOWEEN_2026_ACCENTS,
  confusablePairs: DATA._discrimination?.confusablePairs,
  readingNotes: DATA._readingNotes,
  model: process.env.ASSIGN_MODEL,
  batchSize: BATCH,
  onProgress: (m) => process.stderr.write(`  ${m}\n`),
});

// Output shape is preserved for the review tooling: truth.ts scores `results`,
// verify-sheet renders it, stage-swatcher copies from it, and veto-regression
// reads `rawVotes` to test rules against the model's ORIGINAL wording.
const doc = {
  swatcher,
  folder: FOLDER,
  bursts: result.bursts,
  rawVotes: result.assignments.map((a) => ({
    file: a.id,
    shade: a.rawShade,
    alternative: a.alternative,
    confidence: a.confidence,
    reason: a.rawReason,
  })),
  results: result.assignments.map((a) => ({
    file: a.id,
    shade: a.shade,
    confidence: a.confidence,
    alternative: a.alternative,
    reason: a.reason,
  })),
};
writeFileSync(join(OUT, `${swatcher}.json`), JSON.stringify(doc, null, 2));

const tally = new Map<string, number>();
for (const a of result.assignments) if (a.shade) tally.set(a.shade, (tally.get(a.shade) ?? 0) + 1);

console.log(`\n=== ${swatcher}: ${result.assignments.length} frames across ${result.diagnostics.shadesFound} shades ===`);
for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
if (result.diagnostics.unplaced) console.log(`  ${String(result.diagnostics.unplaced).padStart(3)}  UNPLACED`);
if (result.diagnostics.notFound.length) console.log(`\n  not present: ${result.diagnostics.notFound.join(", ")} (may genuinely not have been shot)`);
if (result.diagnostics.rescuedFromStarvation) console.log(`  ${result.diagnostics.rescuedFromStarvation} burst(s) kept their own vote where matching had no slot`);
for (const d of result.diagnostics.duplicatedShades) console.log(`  ${d.shade} claimed by ${d.bursts} bursts — reshot, or one sitting split`);
for (const p of result.diagnostics.protectedFrames) console.log(`  protected: ${p}`);
for (const n of result.diagnostics.needsReview) console.log(`  NEEDS REVIEW: ${n}`);

console.log(`\nWrote ${join(OUT, `${swatcher}.json`)}`);
