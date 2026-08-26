/**
 * classify-folders — determine each shade folder's polish type by majority vote.
 *
 * Type is normally operator ground truth (Shopify `custom.nailstuff_polish_type`).
 * This is the fallback for shades that have no product yet, and a cross-check
 * against the operator's own list.
 *
 * Votes across several frames rather than trusting one: a single frame of a
 * magnetic with no visible line, or a thermal caught mid-transition, is
 * genuinely ambiguous.
 *
 *   pnpm tsx scripts/classify-folders.ts "<collection path>" [framesPerFolder]
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { listOwnFolder, listOwnFolderImages, downloadOwnFile } from "../src/dropbox/client.js";
import { classifyPolish } from "../src/vision/analyze.js";
import type { PolishType, PolishFinish } from "../src/vision/polish-types.js";

const root = process.argv[2] ?? "/NailStuff Staging/Halloween 2026 - Staging";
const FRAMES = Number(process.argv[3] ?? 4);
const OUT = join(process.cwd(), "output", "vision-ab");
mkdirSync(OUT, { recursive: true });

const { entries } = await listOwnFolder(root);
const folders = entries
  .filter((e) => e[".tag"] === "folder" && !e.name.startsWith("_"))
  .map((e) => e.name)
  .sort();

console.log(`Classifying ${folders.length} folders, ${FRAMES} frames each\n`);

const result: Record<string, { polishType: PolishType | null; formulaVotes: Record<string, number>; finishes: PolishFinish[]; finishVotes: Record<string, number>; frames: number }> = {};

for (const name of folders) {
  const files = await listOwnFolderImages(`${root}/${name}`);
  if (!files.length) { console.log(`${name.padEnd(30)} (empty)`); continue; }

  // Spread the sample across the folder so one swatcher's session cannot
  // decide the type on its own.
  const step = Math.max(1, Math.floor(files.length / FRAMES));
  const picked = Array.from({ length: Math.min(FRAMES, files.length) }, (_, i) => files[i * step]);

  const formulaVotes: Record<string, number> = {};
  const finishVotes: Record<string, number> = {};
  const reasons: string[] = [];

  await Promise.all(picked.map(async (f) => {
    try {
      const raw = await downloadOwnFile(f.path);
      // Low resolution on purpose: type is a coarse judgement and this is a
      // cheap gate in front of the expensive measurement pass.
      const buf = await sharp(raw, { failOn: "none" }).rotate()
        .resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      const r = await classifyPolish(buf.toString("base64"), "image/jpeg", "Cadillacquer");
      if (r.polishType) formulaVotes[r.polishType] = (formulaVotes[r.polishType] ?? 0) + 1;
      // Finishes accumulate across frames rather than competing: a magnetic
      // whose line is only visible in one frame is still a magnetic, and a
      // thermal caught in one state in every frame but one is still a thermal.
      for (const f of r.finishes) finishVotes[f] = (finishVotes[f] ?? 0) + 1;
      reasons.push(`${r.polishType}/[${r.finishes.join(",")}] (${r.confidence}) ${r.reason}`);
    } catch (err) {
      reasons.push(`error: ${err}`);
    }
  }));

  const fRanked = Object.entries(formulaVotes).sort((a, b) => b[1] - a[1]);
  const topFormula = (fRanked[0]?.[0] as PolishType) ?? null;
  // A finish seen in ANY frame counts: these are existence claims, not a vote.
  const finishes = Object.entries(finishVotes).sort((a, b) => b[1] - a[1]).map(([k]) => k as PolishFinish);

  result[name] = { polishType: topFormula, formulaVotes, finishes, finishVotes, frames: picked.length };

  const fSpread = Object.entries(finishVotes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ");
  console.log(`${name.padEnd(30)} ${(topFormula ?? "?").padEnd(11)} | ${fSpread}`);
  for (const r of reasons.slice(0, 2)) console.log(`     ${r}`);
}

writeFileSync(join(OUT, "polish-types.json"), JSON.stringify(result, null, 2));
console.log(`\nWrote ${join(OUT, "polish-types.json")}`);
