/**
 * review-queue — surface only the frames a human needs to look at.
 *
 * The operator's time is the scarce resource in this pipeline, not API calls.
 * Reviewing a whole shoot frame by frame is what we are trying to stop doing,
 * so this ranks frames by how likely they are to be wrong and reports only
 * those, with the reason they were flagged.
 *
 * Ranking uses the two signals measured to work, in the order they earned:
 *
 *   1. CONTRADICTION — the frame's own wording rules out its label. Across 280
 *      frames this caught every contradicted frame with no false positives by
 *      construction, and cost no API call.
 *   2. LOW CONFIDENCE — genuinely murky frames that make no false claim.
 *      Measured to catch a DIFFERENT class: confidence alone found 0/8 of the
 *      contradicted frames, so neither signal substitutes for the other.
 *   3. UNPLACED — the pipeline declined to guess.
 *
 * A frame flagged by nothing is not guaranteed right; it is just not where the
 * evidence says to look first.
 *
 *   pnpm tsx scripts/review-queue.ts [Swatcher ...]
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { vetoesFor } from "../src/vision/veto.js";
import { parseAll } from "../src/vision/signature.js";

const COLLECTION = process.env.COLLECTION ?? "data/halloween-2026.json";
const DATA = JSON.parse(readFileSync(COLLECTION, "utf-8"));
const SIGNATURES = parseAll(
  Object.fromEntries(
    Object.entries<any>(DATA.shades).map(([k, v]) => [
      k,
      { vendorDescription: v.vendorDescription, polishType: v.polishType },
    ]),
  ),
);

const LOW_CONFIDENCE = Number(process.env.REVIEW_CONFIDENCE ?? 0.8);
const DIR = join(process.cwd(), "output", "vision-ab", "swatcher");
const TRUTH = join(process.cwd(), "data", "truth");

const swatchers = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

interface Flag { file: string; shade: string | null; confidence: number; reason: string; why: string; rank: number }

let totalFrames = 0;
let totalFlagged = 0;
const shadeTotals = new Map<string, number>();

for (const s of swatchers) {
  const path = join(DIR, `${s}.json`);
  if (!existsSync(path)) continue;
  const doc = JSON.parse(readFileSync(path, "utf-8")) as {
    results: Array<{ file: string; shade: string | null; confidence: number; reason: string }>;
  };
  const confirmed = existsSync(join(TRUTH, `${s}.json`));

  const flags: Flag[] = [];
  for (const r of doc.results) {
    totalFrames++;
    if (r.shade) shadeTotals.set(r.shade, (shadeTotals.get(r.shade) ?? 0) + 1);

    if (!r.shade) {
      flags.push({ ...r, why: "unplaced — pipeline declined to guess", rank: 1 });
      continue;
    }
    const hit = vetoesFor(r.reason, SIGNATURES).find((v) => v.shade === r.shade);
    if (hit) {
      flags.push({ ...r, why: `CONTRADICTED — ${hit.because}`, rank: 0 });
      continue;
    }
    if (r.confidence < LOW_CONFIDENCE) {
      flags.push({ ...r, why: `low confidence (${r.confidence})`, rank: 2 });
    }
  }

  flags.sort((a, b) => a.rank - b.rank || a.confidence - b.confidence);
  totalFlagged += flags.length;

  const tally = new Map<string, number>();
  for (const r of doc.results) if (r.shade) tally.set(r.shade, (tally.get(r.shade) ?? 0) + 1);
  const missing = Object.keys(DATA.shades).filter((n) => !tally.has(n));

  console.log(`\n=== ${s} — ${doc.results.length} frames, ${tally.size} shades, ${flags.length} to review${confirmed ? "  [ALREADY CONFIRMED]" : ""} ===`);
  if (missing.length) console.log(`  not present: ${missing.join(", ")}`);
  for (const f of flags) {
    console.log(`  ${f.file.replace(/^Foto /, "").padEnd(30)} ${String(f.shade ?? "UNPLACED").padEnd(30)} ${f.why}`);
    console.log(`      said: "${f.reason.replace(/^(burst\+matching|2nd pass): /, "")}"`);
  }
}

console.log(`\n${totalFlagged}/${totalFrames} frames flagged for review (${((totalFlagged / (totalFrames || 1)) * 100).toFixed(0)}%)`);
console.log(`\nframes per shade across all shoots:`);
for (const n of Object.keys(DATA.shades)) {
  const c = shadeTotals.get(n) ?? 0;
  console.log(`  ${String(c).padStart(3)}  ${n}${c === 0 ? "   <-- NO FRAMES ANYWHERE" : ""}`);
}
