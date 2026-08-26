/**
 * veto-regression — prove the description vetoes never contradict a known-good
 * assignment.
 *
 * A veto is a hard constraint: once it fires, no amount of soft score can put
 * the shade back. That power is only safe if the rules are provably silent on
 * assignments an operator has confirmed by eye. This checks exactly that, and
 * additionally reports what the rules WOULD have caught on unconfirmed shoots.
 *
 *   pnpm tsx scripts/veto-regression.ts [Swatcher ...]
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { vetoesFor } from "../src/vision/veto.js";
import { parseAll } from "../src/vision/signature.js";

/** Candidate descriptions for the collection under test — the only input. */
const COLLECTION = process.env.COLLECTION ?? "data/halloween-2026.json";
const data = JSON.parse(readFileSync(COLLECTION, "utf-8"));
const SIGNATURES = parseAll(
  Object.fromEntries(
    Object.entries<any>(data.shades).map(([k, v]) => [
      k,
      { vendorDescription: v.vendorDescription, polishType: v.polishType },
    ]),
  ),
);

/** Shoots the operator has verified frame by frame. */
const CONFIRMED = ["Doseoflolade", "_always_polished_", "Serpentine13"];

const DIR = join(process.cwd(), "output", "vision-ab", "swatcher");
type Row = { file: string; shade: string | null; reason: string };
const load = (s: string) =>
  JSON.parse(readFileSync(join(DIR, `${s}.json`), "utf-8")) as {
    rawVotes?: Row[];
    results: Row[];
  };

/**
 * Confirmed shade paired with the model's ORIGINAL wording.
 *
 * Applying an operator correction overwrites `reason` with "operator-confirmed",
 * which would make the regression pass trivially by having no text to test. The
 * real question is whether a veto would have fired on what the model actually
 * wrote about a frame whose true shade we now know — so the true label is taken
 * from `results` and the wording from `rawVotes`.
 */
function confirmedRows(s: string): Row[] {
  const doc = load(s);
  const raw = new Map((doc.rawVotes ?? []).map((r) => [r.file, r.reason]));

  // Labels come from the FROZEN TRUTH, never from the run file. The run file is
  // overwritten by every A/B run — including runs made with NO_CORRECTIONS — so
  // reading labels from it silently turns this regression into a check against
  // whatever the last experiment happened to produce. That is exactly how a
  // CORRECT veto got reported as a rule bug.
  const tf = join(process.cwd(), "data", "truth", `${s}.json`);
  const truth: Record<string, string | null> = existsSync(tf)
    ? JSON.parse(readFileSync(tf, "utf-8")).frames
    : {};

  return doc.results
    .filter((r) => r.file in truth)
    .map((r) => ({ file: r.file, shade: truth[r.file], reason: raw.get(r.file) ?? r.reason }));
}

let frames = 0;
let selfVetoes = 0;

console.log("=== regression: vetoes must be silent on confirmed frames ===\n");
for (const s of CONFIRMED) {
  for (const r of confirmedRows(s)) {
    if (!r.shade) continue;
    frames++;
    const hits = vetoesFor(r.reason, SIGNATURES).filter((h) => h.shade === r.shade);
    if (!hits.length) continue;
    selfVetoes++;
    console.log(`SELF-VETO  ${s}  ${r.shade}`);
    console.log(`   text: ${r.reason}`);
    for (const h of hits) console.log(`   ${h.attribute}: saw ${h.observed} ("${h.evidence}"), description says ${h.expected}`);
    console.log();
  }
}
console.log(`${frames} confirmed frames checked, ${selfVetoes} self-veto(es)${selfVetoes ? "  <-- RULE BUG" : "  OK"}\n`);

// What the rules catch elsewhere. These are candidate errors, not proven ones,
// but a rule that never fires anywhere is not earning its place either.
const others = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(DIR).map((f) => f.replace(/\.json$/, "")).filter((s) => !CONFIRMED.includes(s));

console.log("=== what the vetoes catch on unconfirmed shoots ===\n");
let caught = 0;
for (const s of others) {
  const rows = load(s).results.filter((r) => r.shade);
  const flagged = rows
    .map((r) => ({ r, hits: vetoesFor(r.reason, SIGNATURES).filter((h) => h.shade === r.shade) }))
    .filter((x) => x.hits.length);
  if (!flagged.length) { console.log(`${s.padEnd(20)} clean (${rows.length} placed)`); continue; }
  caught += flagged.length;
  console.log(`${s} — ${flagged.length}/${rows.length} placed frames contradict their own label`);
  for (const { r, hits } of flagged) {
    console.log(`   ${r.file}`);
    console.log(`     labelled ${r.shade}`);
    console.log(`     said     "${r.reason.replace(/^burst\+matching: /, "")}"`);
    console.log(`     ${hits[0].because}  [saw "${hits[0].evidence}"]`);
  }
  console.log();
}
console.log(`${caught} contradicted frame(s) found across ${others.length} unconfirmed shoot(s)`);
