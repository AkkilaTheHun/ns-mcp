/**
 * stage-swatcher — write a swatcher's assignments into a new staging tree.
 *
 * Copies (never moves) from the source shoot into per-shade folders so the
 * grouping can be eyeballed. Source is left untouched, and the target is a new
 * tree rather than the existing staging, so a bad pass costs nothing.
 *
 *   pnpm tsx scripts/stage-swatcher.ts <Swatcher>            # dry run, prints the plan
 *   pnpm tsx scripts/stage-swatcher.ts <Swatcher> --apply    # actually copy
 *   pnpm tsx scripts/stage-swatcher.ts all --apply
 *
 * Reads output/vision-ab/swatcher/<Swatcher>.json, produced by assign-swatcher.
 */
import "dotenv/config";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { createDropboxFolder, copyDropboxFile, listOwnFolderImages } from "../src/dropbox/client.js";

const TARGET_ROOT = process.env.STAGING_ROOT ?? "/NailStuff Staging/Halloween 2026 - v2";
const SOURCE_ROOT = process.env.SOURCE_ROOT ?? "/Halloween 2026";
const REVIEW = "_Needs Review";

const arg = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!arg) throw new Error('usage: stage-swatcher.ts <Swatcher|all> [--apply]');

const DIR = join(process.cwd(), "output", "vision-ab", "swatcher");

/** Mirror the existing staging convention so v2 filenames match v1. */
function stagingFilename(originalName: string, swatcher: string): string {
  const ext = originalName.split(".").pop() ?? "jpg";
  const base = originalName.replace(/\.[^.]+$/, "");
  const sanitized = base
    .replace(/[,]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return `${sanitized}_swatcher-${swatcher}.${ext}`;
}

/** Dropbox rejects "?" and a few other characters in path segments. */
const safeFolder = (name: string) => name.replace(/[?*:<>"|\\]/g, "").trim();

interface Result { file: string; shade: string | null; confidence: number; reason: string }

const swatchers = arg === "all"
  ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
  : [arg];

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${SOURCE_ROOT} -> ${TARGET_ROOT}\n`);

let totalCopies = 0;
let totalReview = 0;
const plan: Array<{ from: string; to: string }> = [];

for (const swatcher of swatchers) {
  const file = join(DIR, `${swatcher}.json`);
  if (!existsSync(file)) { console.log(`${swatcher}: no assignment file, skipping`); continue; }

  const doc = JSON.parse(readFileSync(file, "utf-8")) as { swatcher: string; folder: string; results: Result[] };
  const sourceFiles = await listOwnFolderImages(doc.folder);
  const byName = new Map(sourceFiles.map((f) => [f.name, f.path]));

  const groups = new Map<string, Result[]>();
  for (const r of doc.results) {
    const key = r.shade ?? REVIEW;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  console.log(`${swatcher} — ${doc.results.length} frames into ${groups.size} folders`);
  for (const [shade, rows] of [...groups.entries()].sort()) {
    const isReview = shade === REVIEW;
    console.log(`  ${String(rows.length).padStart(2)}  ${shade}${isReview ? "   <-- needs a human" : ""}`);
    if (isReview) totalReview += rows.length;
    else totalCopies += rows.length;

    for (const r of rows) {
      const from = byName.get(r.file);
      if (!from) { console.log(`      MISSING IN SOURCE: ${r.file}`); continue; }
      // Unplaced frames keep a note of what the model leaned toward, so the
      // review folder is a starting point rather than a pile.
      const to = `${TARGET_ROOT}/${safeFolder(shade)}/${stagingFilename(r.file, swatcher)}`;
      plan.push({ from, to });
    }
  }
  console.log();
}

console.log(`${plan.length} copies planned — ${totalCopies} placed, ${totalReview} to review\n`);

if (!APPLY) {
  console.log("Sample of the plan:");
  for (const p of plan.slice(0, 8)) console.log(`  ${p.from.split("/").pop()}\n    -> ${p.to.replace(TARGET_ROOT + "/", "")}`);
  console.log(`\nRe-run with --apply to copy. Source files are never modified.`);
  process.exit(0);
}

// Create folders first; createDropboxFolder already tolerates existing ones.
const folders = [...new Set(plan.map((p) => p.to.slice(0, p.to.lastIndexOf("/"))))];
await createDropboxFolder(TARGET_ROOT).catch(() => {});
for (const f of folders) await createDropboxFolder(f).catch(() => {});
console.log(`${folders.length} folders ready`);

// SERIAL, not concurrent. Dropbox rate-limits writes to a namespace hard —
// four parallel copies produced 34 failures out of 43 with
// `too_many_write_operations`. Retry with backoff lives in the client.
let done = 0, skipped = 0, failed = 0;
for (const p of plan) {
  try {
    const r = await copyDropboxFile(p.from, p.to);
    if (r.skipped) skipped++; else done++;
  } catch (err) {
    failed++;
    console.log(`  FAILED ${p.from.split("/").pop()}: ${err}`);
  }
  const n = done + skipped + failed;
  if (n % 20 === 0) process.stderr.write(`  ${n}/${plan.length}\n`);
}

console.log(`\nCopied ${done}${skipped ? `, ${skipped} already present` : ""}${failed ? `, ${failed} failed` : ""} into ${TARGET_ROOT}`);
