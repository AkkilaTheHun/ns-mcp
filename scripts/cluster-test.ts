/**
 * cluster-test — per-image clustering with the base+flake metric.
 *
 * Tests whether shade separation survives WITHOUT the session-grouping prior.
 * That prior turned out to be unsafe: several swatchers export whole batches
 * under one timestamp, so "same swatcher + same second" spans multiple shades.
 *
 *   pnpm tsx scripts/cluster-test.ts "Fear What You Will Become" [thresholds...]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { hexToLab, deltaE76, type Lab } from "../src/util/color.js";

const folder = process.argv[2] ?? "Fear What You Will Become";
const thresholds = process.argv.slice(3).map(Number);
const FILE = join(process.cwd(), "output", "vision-ab", "sweep", "halloween-2026.json");

type Row = [string, string | null, string | null, string | null];
const data = JSON.parse(readFileSync(FILE, "utf-8")) as { folders: Record<string, Row[]> };
const rows = data.folders[folder];
if (!rows) throw new Error(`No sweep data for "${folder}". Have: ${Object.keys(data.folders).join(", ")}`);

const safeLab = (h: string | null | undefined): Lab | null => {
  if (!h) return null;
  try { return hexToLab(h); } catch { return null; }
};
const swatcherOf = (f: string) => /_swatcher-(.+)\.\w+$/i.exec(f)?.[1] ?? "?";
const satOf = (hex: string): number => {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};

interface Img { file: string; swatcher: string; baseHex: string; base: Lab; flakes: Lab[]; sat: number }
const imgs: Img[] = [];
for (const r of rows) {
  const base = safeLab(r[1]);
  if (!base || !r[1]) continue;
  imgs.push({
    file: r[0],
    swatcher: swatcherOf(r[0]),
    baseHex: r[1],
    base,
    flakes: [safeLab(r[2]), safeLab(r[3])].filter(Boolean) as Lab[],
    sat: satOf(r[1]),
  });
}

/**
 * base ΔE + symmetric nearest-flake ΔE + a saturation penalty.
 *
 * The saturation term exists because two shades can sit at nearly the same LAB
 * position and still be obviously different polishes — a vivid teal and a murky
 * greyed teal. Plain ΔE throws that away; scaling by 100 puts a full-range
 * saturation gap on roughly the same footing as a large ΔE.
 */
function dist(a: Img, b: Img, flakeW: number, satW: number): number {
  const baseD = deltaE76(a.base, b.base);
  let flakeD = baseD;
  if (a.flakes.length && b.flakes.length) {
    const near = (from: Lab[], to: Lab[]) =>
      from.reduce((s, f) => s + Math.min(...to.map((t) => deltaE76(f, t))), 0) / from.length;
    flakeD = (near(a.flakes, b.flakes) + near(b.flakes, a.flakes)) / 2;
  }
  const satD = Math.abs(a.sat - b.sat) * 100;
  return (baseD + flakeW * flakeD + satW * satD) / (1 + flakeW + satW);
}

function cluster(threshold: number, flakeW: number, satW: number) {
  const parent = imgs.map((_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const pairs: Array<{ a: number; b: number; d: number }> = [];
  for (let a = 0; a < imgs.length; a++)
    for (let b = a + 1; b < imgs.length; b++)
      pairs.push({ a, b, d: dist(imgs[a], imgs[b], flakeW, satW) });
  pairs.sort((x, y) => x.d - y.d);
  for (const p of pairs) if (p.d <= threshold) parent[find(p.a)] = find(p.b);

  const groups = new Map<number, Img[]>();
  imgs.forEach((im, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(im);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

console.log(`${folder} — ${imgs.length} images, per-image clustering (no session prior)\n`);

for (const t of thresholds.length ? thresholds : [14, 16, 18, 20]) {
  for (const [flakeW, satW] of [[1, 0], [1, 0.5]] as const) {
    const gs = cluster(t, flakeW, satW);
    console.log(`── threshold ${t}  flakeW ${flakeW}  satW ${satW}  →  ${gs.length} groups`);
    gs.forEach((g, i) => {
      const swat = [...new Set(g.map((x) => x.swatcher))];
      console.log(`     G${i + 1} (${String(g.length).padStart(2)}): ${g.map((x) => x.baseHex).join(" ")}`);
      console.log(`          ${swat.join(", ")}`);
    });
    console.log();
  }
}

// Ground-truth probe: the two frames confirmed by eye to be the same teal polish,
// versus a plum frame from the same swatcher and the same export timestamp.
const probe = (needle: string) => imgs.find((i) => i.file.includes(needle));
const teal = probe("21_48_28_1_swatcher-yyulia_m");
const plum = probe("21_48_29_1_swatcher-yyulia_m");
const dose = probe("13_55_18_swatcher-doseoflolade");
if (teal && plum && dose) {
  console.log("── ground-truth probe (visually confirmed)");
  console.log(`   yyulia teal  ${teal.baseHex}  vs  yyulia plum ${plum.baseHex}   d=${dist(teal, plum, 1, 0.5).toFixed(1)}  (must be FAR — different shades)`);
  console.log(`   yyulia teal  ${teal.baseHex}  vs  doseoflolade ${dose.baseHex}  d=${dist(teal, dose, 1, 0.5).toFixed(1)}  (should be NEAR — both teal)`);
}
