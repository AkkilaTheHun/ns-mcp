#!/usr/bin/env tsx
/**
 * Recompute shade aggregates for every shade touched by the discriminators
 * backfill.
 *
 * The backfill rewrote per-row discriminators, base_color_hex, base_color_lab
 * and embedding, but shade_signatures still holds aggregates computed from the
 * old scraped values. This applies the change.
 *
 * Usage:
 *   pnpm tsx scripts/recompute-backfilled.ts          # dry run: report only
 *   pnpm tsx scripts/recompute-backfilled.ts --apply  # recompute
 */
import "dotenv/config";
import { getSupabase } from "../src/supabase/client.js";
import { recomputeShadeAggregate } from "../src/supabase/recompute.js";

const APPLY = process.argv.includes("--apply");

type Snap = {
  id: number;
  shade_name: string;
  base_color_hex: string | null;
  finish_type: string | null;
  flake_size: string | null;
  flake_colors_hex: string[] | null;
  photo_count: number | null;
};

const SNAP_COLS = "id, shade_name, base_color_hex, finish_type, flake_size, flake_colors_hex, photo_count";

async function affectedShadeIds(): Promise<number[]> {
  const supabase = getSupabase();
  const ids = new Set<number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("image_signatures")
      .select("shade_id")
      .not("discriminators", "is", null)
      .order("shade_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const r of data as Array<{ shade_id: number }>) ids.add(r.shade_id);
    if (data.length < PAGE) break;
  }
  return [...ids].sort((a, b) => a - b);
}

async function snapshot(ids: number[]): Promise<Map<number, Snap>> {
  const supabase = getSupabase();
  const out = new Map<number, Snap>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await supabase
      .from("shade_signatures").select(SNAP_COLS).in("id", chunk);
    if (error) throw new Error(error.message);
    for (const s of (data ?? []) as Snap[]) out.set(s.id, s);
  }
  return out;
}

const sameArr = (a?: string[] | null, b?: string[] | null) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function main() {
  const ids = await affectedShadeIds();
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${ids.length} shades with reconstructed rows\n`);

  if (!APPLY) {
    console.log("Dry run — nothing recomputed. Re-run with --apply.\n");
    return;
  }

  const before = await snapshot(ids);

  let done = 0, failed = 0;
  const failures: Array<{ id: number; err: string }> = [];
  for (const id of ids) {
    try {
      await recomputeShadeAggregate(id);
      done++;
    } catch (err) {
      failed++;
      failures.push({ id, err: String(err) });
    }
    if (done % 50 === 0 || done + failed === ids.length) {
      console.log(`  ${done + failed}/${ids.length}`);
    }
  }

  const after = await snapshot(ids);

  const changed = { base: 0, finish: 0, size: 0, colors: 0, count: 0 };
  const samples: string[] = [];
  for (const id of ids) {
    const b = before.get(id), a = after.get(id);
    if (!b || !a) continue;
    const diffs: string[] = [];
    if (b.base_color_hex !== a.base_color_hex) { changed.base++; diffs.push(`base ${b.base_color_hex} -> ${a.base_color_hex}`); }
    if (b.finish_type !== a.finish_type) { changed.finish++; diffs.push(`finish ${b.finish_type} -> ${a.finish_type}`); }
    if (b.flake_size !== a.flake_size) { changed.size++; diffs.push(`size ${b.flake_size} -> ${a.flake_size}`); }
    if (!sameArr(b.flake_colors_hex, a.flake_colors_hex)) { changed.colors++; diffs.push(`flakes ${JSON.stringify(b.flake_colors_hex)} -> ${JSON.stringify(a.flake_colors_hex)}`); }
    if (b.photo_count !== a.photo_count) { changed.count++; diffs.push(`photos ${b.photo_count} -> ${a.photo_count}`); }
    if (diffs.length && samples.length < 12) samples.push(`  ${a.shade_name}\n    ${diffs.join("\n    ")}`);
  }

  console.log(`\nRecomputed ${done}, failed ${failed}\n`);
  console.log("Fields changed across shades:");
  console.log(`  base_color_hex   ${changed.base}`);
  console.log(`  finish_type      ${changed.finish}`);
  console.log(`  flake_size       ${changed.size}`);
  console.log(`  flake_colors_hex ${changed.colors}`);
  console.log(`  photo_count      ${changed.count}`);
  console.log(`\nSamples:\n${samples.join("\n")}\n`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures.slice(0, 10)) console.log(`  shade ${f.id}: ${f.err.slice(0, 120)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
