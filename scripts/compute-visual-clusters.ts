#!/usr/bin/env tsx
/**
 * Offline pass: compute visual_cluster_id for every shade.
 *
 * Two shades belong to the same cluster if ALL of:
 *   - cosine(embedding_a, embedding_b) > 0.95
 *   - delta_e(base_color_lab_a, base_color_lab_b) < 5
 *   - finish_type matches
 *   - has_holographic, has_thermal, has_magnetic all match
 *
 * Singleton clusters (one-shade clusters) are NOT assigned a cluster_id,
 * which makes "in a tied cluster" a clean boolean check.
 *
 * Usage:
 *   tsx scripts/compute-visual-clusters.ts          # all brands
 *   tsx scripts/compute-visual-clusters.ts --reset  # clear all cluster ids first
 *   tsx scripts/compute-visual-clusters.ts -v       # verbose: print every cluster
 */
import "dotenv/config";
import { getSupabase } from "../src/supabase/client.js";

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const verbose = args.includes("-v") || args.includes("--verbose");

const COS_THRESHOLD = 0.95;     // embedding similarity (1 - cosine_distance)
const DELTA_E_THRESHOLD = 5;    // perceptual color distance

interface Shade {
  id: number;
  brand: string;
  shade_name: string;
  embedding: number[] | null;
  base_color_lab: number[] | null;
  finish_type: string | null;
  has_holographic: boolean | null;
  has_thermal: boolean | null;
  has_magnetic: boolean | null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < a.length; k++) { dot += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Simple CIE76 delta-E
function deltaE(a: number[], b: number[]): number {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dl*dl + da*da + db*db);
}

function parseVec(v: any): number[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v) as number[]; } catch { return null; }
}

async function main() {
  const sb = getSupabase();

  if (reset) {
    console.log("Resetting all visual_cluster_id...");
    const { error } = await sb.from("shade_signatures").update({ visual_cluster_id: null }).neq("id", -1);
    if (error) { console.error(error); process.exit(1); }
  }

  console.log("Loading shades with embeddings...");
  const { data: raw, error } = await sb
    .from("shade_signatures")
    .select("id, brand, shade_name, embedding, base_color_lab, finish_type, has_holographic, has_thermal, has_magnetic")
    .not("embedding", "is", null);
  if (error) { console.error(error); process.exit(1); }

  const shades: Shade[] = (raw ?? []).map((r: any) => ({
    id: r.id, brand: r.brand, shade_name: r.shade_name,
    embedding: parseVec(r.embedding),
    base_color_lab: parseVec(r.base_color_lab),
    finish_type: r.finish_type,
    has_holographic: r.has_holographic,
    has_thermal: r.has_thermal,
    has_magnetic: r.has_magnetic,
  })).filter(s => s.embedding && s.embedding.length === 50);

  console.log(`${shades.length} shades to cluster`);

  // Union-find structure to merge connected shades
  const parent = new Map<number, number>();
  for (const s of shades) parent.set(s.id, s.id);
  function find(x: number): number {
    let cur = x;
    while (parent.get(cur)! !== cur) cur = parent.get(cur)!;
    // path compression
    let it = x;
    while (parent.get(it)! !== cur) { const next = parent.get(it)!; parent.set(it, cur); it = next; }
    return cur;
  }
  function union(a: number, b: number) { parent.set(find(a), find(b)); }

  // O(N²) pass — at ~700 shades = ~250k comparisons, fine
  console.log("Pairwise comparing...");
  let pairs = 0;
  for (let i = 0; i < shades.length; i++) {
    const a = shades[i];
    for (let j = i + 1; j < shades.length; j++) {
      const b = shades[j];
      if (a.finish_type !== b.finish_type) continue;
      if ((a.has_holographic ?? false) !== (b.has_holographic ?? false)) continue;
      if ((a.has_thermal ?? false) !== (b.has_thermal ?? false)) continue;
      if ((a.has_magnetic ?? false) !== (b.has_magnetic ?? false)) continue;
      const cos = cosine(a.embedding!, b.embedding!);
      if (cos < COS_THRESHOLD) continue;
      if (a.base_color_lab && b.base_color_lab) {
        if (deltaE(a.base_color_lab, b.base_color_lab) >= DELTA_E_THRESHOLD) continue;
      }
      union(a.id, b.id);
      pairs++;
    }
    if (i % 100 === 0) console.log(`  [${i}/${shades.length}] pairs merged so far: ${pairs}`);
  }
  console.log(`Total pair merges: ${pairs}`);

  // Group shades by cluster root, assign IDs to multi-member clusters only
  const clusterMembers = new Map<number, Shade[]>();
  for (const s of shades) {
    const root = find(s.id);
    if (!clusterMembers.has(root)) clusterMembers.set(root, []);
    clusterMembers.get(root)!.push(s);
  }
  const multiMember = [...clusterMembers.entries()].filter(([, m]) => m.length > 1);
  console.log(`\n${multiMember.length} multi-member clusters (${shades.length - multiMember.reduce((a, [, m]) => a + m.length, 0)} singletons)`);

  if (verbose) {
    for (const [root, members] of multiMember.sort((a, b) => b[1].length - a[1].length).slice(0, 30)) {
      console.log(`\n  Cluster #${root} (${members.length} shades):`);
      for (const m of members) console.log(`    ${m.brand.padEnd(22)}  ${m.shade_name}`);
    }
    if (multiMember.length > 30) console.log(`\n  ... and ${multiMember.length - 30} more multi-member clusters`);
  }

  // Persist: write cluster id per shade
  console.log("\nPersisting cluster ids...");
  let written = 0;
  for (const [root, members] of multiMember) {
    for (const m of members) {
      await sb.from("shade_signatures").update({ visual_cluster_id: root }).eq("id", m.id);
      written++;
      if (written % 50 === 0) console.log(`  [${written}]`);
    }
  }
  console.log(`Wrote cluster_id on ${written} shades.\n`);
  console.log("Done.");
}

main().catch(err => { console.error(err); process.exit(1); });
