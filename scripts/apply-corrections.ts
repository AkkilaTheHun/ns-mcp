/**
 * apply-corrections — write operator answers into a saved assignment, without
 * re-running any analysis.
 *
 * An operator answer is ground truth and must survive every future re-run. It
 * is also expensive to obtain — it costs a person looking at pictures — so it
 * must never require paying for a full re-analysis to apply. This reads the
 * saved swatcher JSON, applies data/<collection>.json `_operatorCorrections`,
 * and writes it back.
 *
 * Corrections are keyed by filename FRAGMENT so they survive re-segmentation
 * and re-ordering. Fragments are matched as substrings, which can collide —
 * "(5)" would also match "(50)" — so every fragment is checked for ambiguity
 * and a collision is a hard error rather than a silent mis-application.
 *
 *   pnpm tsx scripts/apply-corrections.ts <Swatcher>
 *   pnpm tsx scripts/apply-corrections.ts all
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const arg = process.argv[2];
if (!arg) throw new Error("usage: apply-corrections.ts <Swatcher|all>");

const COLLECTION = process.env.COLLECTION ?? "data/halloween-2026.json";
const DATA = JSON.parse(readFileSync(COLLECTION, "utf-8"));
const CORRECTIONS = (DATA._operatorCorrections ?? {}) as Record<
  string,
  { swatcher: string; shade: string; note?: string }
>;

const DIR = join(process.cwd(), "output", "vision-ab", "swatcher");
const swatchers =
  arg === "all" ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [arg];

let totalApplied = 0;

for (const swatcher of swatchers) {
  const path = join(DIR, `${swatcher}.json`);
  const doc = JSON.parse(readFileSync(path, "utf-8")) as {
    results: Array<{ file: string; shade: string | null; confidence: number; reason: string }>;
  };

  const mine = Object.entries(CORRECTIONS).filter(([, c]) => c.swatcher === swatcher);
  if (!mine.length) { console.log(`${swatcher}: no corrections on file`); continue; }

  // Ambiguity check BEFORE applying anything. A fragment matching more than one
  // frame is not necessarily wrong — an operator may correct a whole run — but a
  // fragment matching a frame that ANOTHER fragment also matches is a genuine
  // collision and would apply two different shades to one frame.
  const matches = new Map<string, string[]>();
  for (const [frag] of mine) {
    matches.set(frag, doc.results.filter((r) => r.file.includes(frag)).map((r) => r.file));
  }
  const owners = new Map<string, string[]>();
  for (const [frag, files] of matches) {
    for (const f of files) {
      if (!owners.has(f)) owners.set(f, []);
      owners.get(f)!.push(frag);
    }
  }
  const collisions = [...owners.entries()].filter(([, frags]) => new Set(frags.map((f) => CORRECTIONS[f].shade)).size > 1);
  if (collisions.length) {
    for (const [file, frags] of collisions) console.error(`  COLLISION ${file} matched by ${frags.join(", ")}`);
    throw new Error(`${swatcher}: ambiguous correction fragments — refusing to apply`);
  }

  let applied = 0;
  let unmatched: string[] = [];
  for (const [frag, c] of mine) {
    const hits = matches.get(frag)!;
    if (!hits.length) { unmatched.push(frag); continue; }
    for (const r of doc.results) {
      if (!r.file.includes(frag)) continue;
      if (r.shade !== c.shade) {
        console.log(`  ${r.file}  ${r.shade ?? "UNPLACED"} -> ${c.shade}`);
        applied++;
      }
      r.shade = c.shade;
      r.confidence = Math.max(r.confidence, 0.99);
      r.reason = `operator-confirmed: ${c.note ?? ""}`.trim();
    }
  }

  writeFileSync(path, JSON.stringify(doc, null, 2));
  totalApplied += applied;
  console.log(`${swatcher}: ${applied} frame(s) changed, ${mine.length} correction(s) on file${
    unmatched.length ? `, ${unmatched.length} matched nothing: ${unmatched.join(", ")}` : ""
  }`);
}

console.log(`\n${totalApplied} frame(s) corrected in total`);
