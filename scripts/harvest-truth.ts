/**
 * harvest-truth — turn a hand-corrected staging tree into permanent ground truth.
 *
 * When the operator fixes folders by dragging files in Dropbox, that verdict is
 * the highest-quality data in the system: a human looked at the picture and
 * decided. It must not be throwaway cleanup that a later re-run silently undoes
 * — which is exactly what happened when a shoot was staged, corrected by hand,
 * and then re-derived from scratch.
 *
 * So this walks the finished tree, maps every file back to its source frame,
 * and writes the result as BOTH:
 *   - data/truth/<Swatcher>.json   scoring baseline for future changes
 *   - _operatorCorrections         applied automatically on every future run
 *
 *   pnpm tsx scripts/harvest-truth.ts "/NailStuff Staging/Halloween 2026 - v4"
 *   pnpm tsx scripts/harvest-truth.ts "<root>" --apply
 *
 * Dry run by default: prints what it would record and what disagrees with the
 * current assignment, so a mis-drag is visible before it becomes canon.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { listOwnFolder, listOwnFolderImages } from "../src/dropbox/client.js";

const ROOT = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!ROOT) throw new Error('usage: harvest-truth.ts "<stagingRoot>" [--apply]');

const SOURCE_ROOT = process.env.SOURCE_ROOT ?? "/Halloween 2026";
const COLLECTION = process.env.COLLECTION ?? "data/halloween-2026.json";
const REVIEW = "_Needs Review";

/** Same sanitiser stage-swatcher uses, so staged names map back to source. */
function stagedBase(originalName: string): string {
  return originalName
    .replace(/\.[^.]+$/, "")
    .replace(/[,]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

// Source frames, indexed by (swatcher, sanitised base) so a staged filename
// resolves back to the real one. The sanitiser is lossy, so it must be applied
// in the same direction rather than inverted.
const { entries } = await listOwnFolder(SOURCE_ROOT);
const swatcherFolders = entries.filter((e) => e[".tag"] === "folder").map((e) => e.name);
const sourceIndex = new Map<string, string>();
for (const sw of swatcherFolders) {
  for (const f of await listOwnFolderImages(`${SOURCE_ROOT}/${sw}`)) {
    sourceIndex.set(`${sw}|${stagedBase(f.name)}`, f.name);
  }
}

/** Folder names lose characters Dropbox rejects; map back to the real shade. */
const DATA = JSON.parse(readFileSync(COLLECTION, "utf-8"));
const shadeByFolder = new Map<string, string>();
for (const name of Object.keys(DATA.shades)) {
  shadeByFolder.set(name.replace(/[?*:<>"|\\]/g, "").trim(), name);
}

const { entries: rootEntries } = await listOwnFolder(ROOT);
const folders = rootEntries.filter((e) => e[".tag"] === "folder").map((e) => e.name).sort();

/** swatcher -> file -> shade */
const harvested = new Map<string, Map<string, string | null>>();
let unmatched = 0;

for (const folder of folders) {
  const shade = folder === REVIEW || folder.startsWith("_") ? null : shadeByFolder.get(folder) ?? folder;
  if (shade === null && folder !== REVIEW && folder.startsWith("_")) {
    console.log(`  (skipping ${folder} — treated as not-a-shade)`);
  }
  for (const f of await listOwnFolderImages(`${ROOT}/${folder}`)) {
    const m = /^(.*)_swatcher-(.+)\.(\w+)$/i.exec(f.name);
    if (!m) { unmatched++; continue; }
    const [, base, swatcher] = m;
    const original = sourceIndex.get(`${swatcher}|${base}`);
    if (!original) { console.log(`  UNRESOLVED ${f.name}`); unmatched++; continue; }
    if (!harvested.has(swatcher)) harvested.set(swatcher, new Map());
    harvested.get(swatcher)!.set(original, shade);
  }
}

// Compare against what the pipeline currently believes, so a drag that
// CHANGES an assignment is visible rather than silently absorbed.
const RUNS = join(process.cwd(), "output", "vision-ab", "swatcher");
let changes = 0;
let total = 0;

for (const [swatcher, frames] of [...harvested.entries()].sort()) {
  const runPath = join(RUNS, `${swatcher}.json`);
  const current = new Map<string, string | null>();
  if (existsSync(runPath)) {
    for (const r of JSON.parse(readFileSync(runPath, "utf-8")).results) current.set(r.file, r.shade);
  }
  const diffs = [...frames.entries()].filter(([file, shade]) => current.has(file) && current.get(file) !== shade);
  total += frames.size;
  changes += diffs.length;
  console.log(`${swatcher.padEnd(20)} ${String(frames.size).padStart(3)} frames, ${diffs.length} differ from current assignment`);
  for (const [file, shade] of diffs) {
    console.log(`   ${file}`);
    console.log(`     was ${current.get(file) ?? "UNPLACED"}  ->  now ${shade ?? "UNPLACED"}`);
  }
}

console.log(`\n${total} frames harvested, ${changes} differ${unmatched ? `, ${unmatched} unresolved` : ""}`);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write data/truth/ and _operatorCorrections.");
  process.exit(0);
}

mkdirSync(join(process.cwd(), "data", "truth"), { recursive: true });
for (const [swatcher, frames] of harvested) {
  writeFileSync(
    join(process.cwd(), "data", "truth", `${swatcher}.json`),
    JSON.stringify({ swatcher, frames: Object.fromEntries(frames) }, null, 2),
  );
}

// Corrections are keyed by a filename fragment so they survive re-segmentation.
// The full basename is used, which is unique within a swatcher and cannot
// collide the way a "(5)" style fragment can with "(50)".
DATA._operatorCorrections ??= {};
const stamp = new Date().toISOString().slice(0, 10);
for (const [swatcher, frames] of harvested) {
  for (const [file, shade] of frames) {
    if (!shade) continue;
    DATA._operatorCorrections[file.replace(/\.[^.]+$/, "")] = {
      swatcher,
      shade,
      note: `Owner-placed in staging, harvested ${stamp}.`,
    };
  }
}
writeFileSync(COLLECTION, JSON.stringify(DATA, null, 2) + "\n");

console.log(`\nWrote data/truth/ for ${harvested.size} swatcher(s)`);
console.log(`${Object.keys(DATA._operatorCorrections).length} operator correction(s) now on file in ${COLLECTION}`);
