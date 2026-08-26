/**
 * sweep-report — shade clustering + contamination report for a staging collection.
 *
 * Reads the raw analyze_images output written by scripts/folder-sweep.ts.
 *
 *   pnpm tsx scripts/sweep-report.ts [threshold] [--global] [--assert]
 *
 * Design notes, each earned the hard way on Halloween 2026:
 *
 *  - PER IMAGE, not per session. Grouping by "same swatcher, small time gap"
 *    looked perfect until lacquer_is_life shot two different polishes 107
 *    seconds apart, and yyulia_m exported four shades under one timestamp.
 *    Session identity is not shade identity. It is not even a safe prior.
 *
 *  - COMPLETE LINK, not single link. Single link chains: with ~30 frames of a
 *    holo spanning a warm-to-cool gradient, one intermediate frame welds two
 *    distinct shades into one blob. Complete link requires every member to be
 *    within threshold of every other, which is what "these are the same
 *    polish" actually means.
 *
 *  - Flake colours carry the signal. Two shades routinely share a base and
 *    differ only in flake colour (rose-gold vs violet over the same mauve).
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { hexToLab, deltaE76, type Lab } from "../src/util/color.js";

const args = process.argv.slice(2);
const THRESHOLD = Number(args.find((a) => !a.startsWith("--")) ?? 20);
const GLOBAL = args.includes("--global");
const ASSERT = args.includes("--assert");
const DIR = join(process.cwd(), "output", "vision-ab", "sweep");

interface Img {
  folder: string;
  file: string;
  swatcher: string;
  imageType: string;
  baseHex: string;
  base: Lab;
  flakes: Lab[];
  sat: number;
}

const swatcherOf = (f: string) => /_swatcher-(.+)\.\w+$/i.exec(f)?.[1] ?? "?";
const safeLab = (h?: string | null): Lab | null => {
  if (!h) return null;
  try { return hexToLab(h); } catch { return null; }
};
const satOf = (hex: string): number => {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};

function load(): Img[] {
  const out: Img[] = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".json") && x !== "halloween-2026.json")) {
    const doc = JSON.parse(readFileSync(join(DIR, f), "utf-8"));
    for (const im of doc.images ?? []) {
      if (im.error) continue;
      const d = im.discriminators;

      // Anchor: bottle-rim read first (most repeatable sampling location), then
      // the face-on nail patch, then whatever the frame emphasised.
      const anchorHex =
        d?.bottleEdgeColor?.hex ?? d?.baseColor?.hex ?? (im.dominantColors ?? [])[0]?.hex;
      const base = safeLab(anchorHex);
      if (!base || !anchorHex) continue;

      /**
       * The GAMUT: every colour this polish is reported to travel through.
       *
       * A shifting polish has no single base — two frames of one bottle can
       * disagree by 136 ΔE on which point is "the" colour while reporting the
       * same set of colours overall. Its identity is the set, not any point.
       */
      const gamut: Lab[] = [];
      const push = (hex?: string) => { const l = safeLab(hex); if (l) gamut.push(l); };
      push(d?.bottleEdgeColor?.hex);
      push(d?.baseColor?.hex);
      for (const c of d?.shiftColors ?? []) push(c.hex);
      for (const c of d?.shimmerFlashColors ?? []) push(c.hex);
      push(d?.magneticLineColor?.hex);
      for (const c of d?.glitterColors ?? []) push(c.hex);
      for (const c of d?.flakeColors ?? []) push(c.hex);
      for (const c of im.nailColors ?? []) push(c.hex);
      if (!gamut.length) for (const c of im.dominantColors ?? []) push(c.hex);

      out.push({
        folder: doc.folder ?? doc.folderName ?? f.replace(/\.json$/, ""),
        file: im.filename,
        swatcher: swatcherOf(im.filename),
        imageType: im.imageType ?? "unknown",
        baseHex: anchorHex,
        base,
        flakes: gamut,
        sat: satOf(anchorHex),
      });
    }
  }
  return out;
}

/** Symmetric nearest-neighbour distance between two colour sets. */
function gamutDistance(a: Lab[], b: Lab[]): number {
  if (!a.length || !b.length) return Infinity;
  const near = (from: Lab[], to: Lab[]) =>
    from.reduce((s, f) => s + Math.min(...to.map((t) => deltaE76(f, t))), 0) / from.length;
  return (near(a, b) + near(b, a)) / 2;
}

/**
 * Gamut-dominant distance.
 *
 * The anchor still carries information — for the many polishes that do NOT
 * shift, the bottle-rim read is highly repeatable — but it must not dominate,
 * because on a magnetic it is bimodal. Weighting gamut 2:1 over the anchor lets
 * a stable anchor help without letting an unstable one split a shade in half.
 */
function dist(a: Img, b: Img): number {
  const anchorD = deltaE76(a.base, b.base);
  const gamutD = gamutDistance(a.flakes, b.flakes);
  if (!Number.isFinite(gamutD)) return anchorD;
  return (anchorD + 2 * gamutD) / 3;
}

const LINKAGE = (process.env.LINKAGE ?? "average") as "single" | "average" | "complete";

/**
 * Agglomerative clustering with selectable linkage.
 *
 * Linkage matters more than the threshold here, and both extremes fail:
 *   single   — chains; one intermediate frame welds two shades into a blob
 *   complete — shatters; a multichrome's own frames legitimately span a wide
 *              ΔE as the angle changes, so demanding ALL pairs be close splits
 *              a single shade into a dozen fragments
 *   average  — the usable middle: a frame joins a shade if it is close to that
 *              shade ON AVERAGE, which tolerates angle swing without chaining.
 */
function clusterComplete(items: Img[], threshold: number): Img[][] {
  let clusters = items.map((i) => [i]);
  const d = (a: Img[], b: Img[]) => {
    if (LINKAGE === "single") {
      let min = Infinity;
      for (const x of a) for (const y of b) { const v = dist(x, y); if (v < min) min = v; }
      return min;
    }
    if (LINKAGE === "average") {
      let sum = 0;
      for (const x of a) for (const y of b) sum += dist(x, y);
      return sum / (a.length * b.length);
    }
    let max = 0;
    for (const x of a) for (const y of b) { const v = dist(x, y); if (v > max) max = v; }
    return max;
  };

  for (;;) {
    let best = { i: -1, j: -1, v: Infinity };
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const v = d(clusters[i], clusters[j]);
        if (v < best.v) best = { i, j, v };
      }
    if (best.i < 0 || best.v > threshold) break;
    clusters[best.i] = clusters[best.i].concat(clusters[best.j]);
    clusters.splice(best.j, 1);
  }
  return clusters.sort((a, b) => b.length - a.length);
}

const all = load();
const byFolder = new Map<string, Img[]>();
for (const im of all) {
  if (!byFolder.has(im.folder)) byFolder.set(im.folder, []);
  byFolder.get(im.folder)!.push(im);
}

console.log(`Shade clustering — ${all.length} images across ${byFolder.size} folders`);
console.log(`per-image, complete-link, threshold ${THRESHOLD}\n`);

const summary: Array<{ folder: string; n: number; groups: number; outliers: number }> = [];

for (const [folder, imgs] of [...byFolder.entries()].sort()) {
  // Group shots legitimately contain many shades; clustering them is meaningless.
  if (folder.startsWith("_Group")) {
    console.log(`${"=".repeat(74)}\n${folder} — ${imgs.length} images (multi-shade by design, skipped)\n`);
    continue;
  }
  const groups = clusterComplete(imgs, THRESHOLD);
  const outliers = imgs.length - groups[0].length;
  const verdict = groups.length === 1 ? "CLEAN" : outliers > imgs.length / 2 ? "SEVERE" : "SPLIT";

  console.log(`${"=".repeat(74)}`);
  console.log(`${folder} — ${imgs.length} images, ${groups.length} group(s)   [${verdict}]`);
  groups.forEach((g, i) => {
    const swat = [...new Set(g.map((x) => x.swatcher))];
    console.log(`  ${(i === 0 ? "main" : `alt ${i}`).padEnd(6)} ${String(g.length).padStart(2)} img  ${g.slice(0, 6).map((x) => x.baseHex).join(" ")}${g.length > 6 ? " …" : ""}`);
    console.log(`         ${swat.join(", ")}`);
    if (i > 0) for (const x of g) console.log(`           ${x.file}`);
  });
  console.log();
  summary.push({ folder, n: imgs.length, groups: groups.length, outliers });
}

console.log(`${"=".repeat(74)}\nSUMMARY\n`);
console.log(`${"folder".padEnd(32)} ${"imgs".padStart(4)} ${"grp".padStart(3)} ${"offmain".padStart(7)}`);
for (const s of summary.sort((a, b) => b.outliers - a.outliers))
  console.log(`${s.folder.padEnd(32)} ${String(s.n).padStart(4)} ${String(s.groups).padStart(3)} ${String(s.outliers).padStart(7)}`);

// ---------------------------------------------------------------------------
// Ground truth established by eye on the contact sheets. These four assertions
// are the regression test for any change to the distance metric or linkage.
// ---------------------------------------------------------------------------
if (ASSERT) {
  const find = (needle: string) => all.find((i) => i.file.includes(needle));
  const cases: Array<[string, string, string, "same" | "diff"]> = [
    ["lacquer_is_life purple vs rose-gold (107s apart)", "14_52_08_swatcher-lacquer_is_life", "14_53_55_swatcher-lacquer_is_life", "diff"],
    ["rafinails gold vs purple (same export second)", "20_27_22_1_swatcher-rafinails", "20_27_22_4_swatcher-rafinails", "diff"],
    ["yyulia teal in FWYWB vs yyulia teal in IAFY", "21_48_28_1_swatcher-yyulia_m", "21_48_28_4_swatcher-yyulia_m", "same"],
    ["yyulia teal vs yyulia plum (same export second)", "21_48_28_1_swatcher-yyulia_m", "21_48_29_1_swatcher-yyulia_m", "diff"],
  ];
  console.log(`\n${"=".repeat(74)}\nGROUND-TRUTH ASSERTIONS (visually confirmed)\n`);
  let pass = 0;
  for (const [name, a, b, expect] of cases) {
    const x = find(a), y = find(b);
    if (!x || !y) { console.log(`  SKIP  ${name} (not found)`); continue; }
    const d = dist(x, y);
    const got = d <= THRESHOLD ? "same" : "diff";
    const ok = got === expect;
    if (ok) pass++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  d=${d.toFixed(1).padStart(5)}  expect ${expect}, got ${got}   ${name}`);
  }
  console.log(`\n  ${pass}/${cases.length} passed at threshold ${THRESHOLD}`);
}

// ---------------------------------------------------------------------------
// Cross-folder: where do the off-main groups actually belong?
// ---------------------------------------------------------------------------
if (GLOBAL) {
  console.log(`\n${"=".repeat(74)}\nCROSS-FOLDER SHADE GROUPS\n`);
  const pool = all.filter((i) => !i.folder.startsWith("_Group"));
  const groups = clusterComplete(pool, THRESHOLD);
  groups.forEach((g, i) => {
    const folders = new Map<string, number>();
    for (const x of g) folders.set(x.folder, (folders.get(x.folder) ?? 0) + 1);
    const spread = [...folders.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`  Shade ${String(i + 1).padStart(2)} (${String(g.length).padStart(2)} img): ${spread.map(([f, n]) => `${f}×${n}`).join("  ")}`);
  });
}
