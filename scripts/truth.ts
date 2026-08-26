/**
 * truth — freeze and score against operator-verified assignments.
 *
 * Until now every change was judged by rendering a contact sheet and looking at
 * it, which is slow, needs the operator, and gives no number. Once a shoot has
 * been verified frame by frame, that verdict is ground truth and should be
 * frozen so any later change can be scored automatically.
 *
 *   pnpm tsx scripts/truth.ts freeze <Swatcher>   # snapshot current assignment as truth
 *   pnpm tsx scripts/truth.ts score [Swatcher]    # score current assignment against truth
 *
 * Freeze only AFTER the operator has confirmed the shoot. Freezing a bad run
 * bakes in its errors and every later "improvement" is scored against them.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const MODE = process.argv[2];
const ARG = process.argv[3];
const TRUTH = join(process.cwd(), "data", "truth");
const RUNS = join(process.cwd(), "output", "vision-ab", "swatcher");
mkdirSync(TRUTH, { recursive: true });

type Row = { file: string; shade: string | null; confidence: number; reason: string };
const run = (s: string) => JSON.parse(readFileSync(join(RUNS, `${s}.json`), "utf-8")) as { results: Row[] };

if (MODE === "freeze") {
  if (!ARG) throw new Error("usage: truth.ts freeze <Swatcher>");
  const rows = run(ARG).results;
  const unplaced = rows.filter((r) => !r.shade).length;
  if (unplaced) console.log(`  warning: ${unplaced} frame(s) have no shade and will be frozen as null`);
  const map = Object.fromEntries(rows.map((r) => [r.file, r.shade]));
  writeFileSync(join(TRUTH, `${ARG}.json`), JSON.stringify({ swatcher: ARG, frames: map }, null, 2));
  console.log(`froze ${rows.length} frames as truth for ${ARG}`);
  process.exit(0);
}

if (MODE !== "score") throw new Error("usage: truth.ts <freeze|score> [Swatcher]");

const swatchers = ARG
  ? [ARG]
  : readdirSync(TRUTH).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

let totalRight = 0;
let totalScored = 0;

for (const s of swatchers) {
  const tf = join(TRUTH, `${s}.json`);
  if (!existsSync(tf)) { console.log(`${s}: no truth frozen, skipping`); continue; }
  if (!existsSync(join(RUNS, `${s}.json`))) { console.log(`${s}: no run to score, skipping`); continue; }

  const truth = JSON.parse(readFileSync(tf, "utf-8")).frames as Record<string, string | null>;
  const rows = run(s).results;

  const wrong: Array<{ file: string; got: string | null; want: string | null; conf: number; reason: string }> = [];
  let right = 0;
  let scored = 0;
  for (const r of rows) {
    if (!(r.file in truth)) continue;
    scored++;
    if (r.shade === truth[r.file]) right++;
    else wrong.push({ file: r.file, got: r.shade, want: truth[r.file], conf: r.confidence, reason: r.reason });
  }

  totalRight += right;
  totalScored += scored;
  const pct = scored ? ((right / scored) * 100).toFixed(1) : "0.0";
  console.log(`${s.padEnd(20)} ${right}/${scored}  ${pct}%`);
  for (const w of wrong) {
    console.log(`   ${w.file.replace(/^Foto /, "")}`);
    console.log(`     got  ${w.got ?? "null"}  (conf ${w.conf})`);
    console.log(`     want ${w.want ?? "null"}`);
    console.log(`     said "${w.reason}"`);
  }
}

console.log(
  `\n${totalRight}/${totalScored} frames correct${totalScored ? ` — ${((totalRight / totalScored) * 100).toFixed(1)}%` : ""} across ${swatchers.length} shoot(s)`,
);
