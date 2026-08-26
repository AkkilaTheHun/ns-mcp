/**
 * cluster-report — separate "which frames belong together" from "which shade
 * is this", using filename time and sequence rather than pixels.
 *
 * Some shades cannot be told apart by eye. Two clear-base toppers whose flake
 * and glitter colours are merely INVERTED look the same at a glance, defeat a
 * hue histogram (both contain red and blue), and defeat the description vetoes
 * (their particle palettes are identical). Nothing colour-based separates them.
 *
 * But the SHOOT separates them. A photographer removes one polish and applies
 * the next, so frames for one shade sit together in time and sequence. That
 * grouping is a physical fact about how the photos were taken, and it holds
 * even when the two shades are visually indistinguishable — which turns an
 * impossible question ("which topper is this frame?") into an easy one ("these
 * two clusters are the two toppers; which cluster is which?"), answerable once
 * per cluster instead of once per frame.
 *
 *   pnpm tsx scripts/cluster-report.ts ["Shade A" "Shade B" ...]
 *
 * With no arguments, reports the clear-base shades, which are the ones this
 * problem afflicts.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseAll } from "../src/vision/signature.js";
import { timeFromFilename, orderFromFilename } from "../src/vision/group.js";

const COLLECTION = process.env.COLLECTION ?? "data/halloween-2026.json";
const DATA = JSON.parse(readFileSync(COLLECTION, "utf-8"));
const DIR = join(process.cwd(), "output", "vision-ab", "swatcher");

const signatures = parseAll(
  Object.fromEntries(
    Object.entries<any>(DATA.shades).map(([k, v]) => [k, { vendorDescription: v.vendorDescription, polishType: v.polishType }]),
  ),
);

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : signatures.filter((s) => s.facts.some((f) => f.attribute === "base" && f.value === "clear")).map((s) => s.shade);

console.log(`Clustering by capture time and sequence for: ${targets.join(", ")}\n`);

const hhmm = (t: number | null) => (t === null ? "  ??:??  " : new Date(t).toISOString().slice(11, 19));

/** Minutes of silence that imply the polish was changed. */
const GAP = Number(process.env.CLUSTER_GAP ?? 4);

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const swatcher = file.replace(/\.json$/, "");
  const doc = JSON.parse(readFileSync(join(DIR, file), "utf-8")) as {
    results: Array<{ file: string; shade: string | null; confidence: number; reason: string }>;
  };
  const truthPath = join(process.cwd(), "data", "truth", `${swatcher}.json`);
  const truth: Record<string, string | null> = existsSync(truthPath)
    ? JSON.parse(readFileSync(truthPath, "utf-8")).frames
    : {};

  const rows = doc.results
    .filter((r) => r.shade && targets.includes(r.shade))
    .map((r) => ({ ...r, t: timeFromFilename(r.file), seq: orderFromFilename(r.file) }))
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));

  if (!rows.length) { console.log(`${swatcher}: none of these shades assigned\n`); continue; }

  // Split into sittings on a real time gap. Where every frame carries the same
  // export timestamp, fall back to a break in the sequence numbers — the only
  // ordering signal those filenames preserve.
  const clusters: (typeof rows)[] = [];
  for (const r of rows) {
    const cur = clusters[clusters.length - 1];
    const prev = cur?.[cur.length - 1];
    let boundary = !cur;
    if (prev) {
      if (r.t !== null && prev.t !== null && r.t !== prev.t) {
        boundary = (r.t - prev.t) / 60000 > GAP;
      } else if (r.seq !== null && prev.seq !== null) {
        boundary = r.seq - prev.seq > 1;
      }
    }
    if (boundary) clusters.push([r]);
    else cur!.push(r);
  }

  const verified = Object.keys(truth).length > 0;
  console.log(`=== ${swatcher} — ${rows.length} frames in ${clusters.length} sitting(s)${verified ? "  [truth available]" : ""} ===`);
  for (const c of clusters) {
    const labels = new Set(c.map((r) => r.shade!));
    const truthLabels = new Set(c.map((r) => truth[r.file]).filter(Boolean) as string[]);
    const span = c[0].t !== null && c[c.length - 1].t !== null ? `${hhmm(c[0].t)}-${hhmm(c[c.length - 1].t)}` : "single export stamp";
    const seqSpan = c[0].seq !== null ? `seq ${c[0].seq}-${c[c.length - 1].seq}` : "no seq";

    // A sitting is ONE polish. More than one label inside it is a split that
    // needs resolving to a single answer, which is one decision instead of N.
    const verdict = labels.size > 1 ? `  <-- SPLIT across ${[...labels].join(" / ")}` : "";
    const truthNote = truthLabels.size ? `  truth: ${[...truthLabels].join(" / ")}${truthLabels.size > 1 ? " <-- truth itself splits" : ""}` : "";
    console.log(`  ${String(c.length).padStart(2)}f  ${span}  ${seqSpan}  -> ${[...labels].join(" / ")}${verdict}${truthNote}`);
    for (const r of c) {
      const mark = truth[r.file] && truth[r.file] !== r.shade ? "  WRONG" : "";
      console.log(`        ${r.file.replace(/^Foto /, "").padEnd(28)} ${String(r.confidence).padEnd(5)} ${r.shade}${mark}`);
    }
  }
  console.log();
}

console.log(`A sitting holding TWO different labels is a frame-level inconsistency: the
photographer did not swap polish mid-burst. Resolving it is one decision for the
whole cluster, not one per frame — and it does not require telling the two
shades apart by eye, only saying which sitting was which.`);
