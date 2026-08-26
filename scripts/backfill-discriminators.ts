#!/usr/bin/env tsx
/**
 * Rebuild the `discriminators` block for rows indexed before it was persisted.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-discriminators.ts              # dry run (default)
 *   pnpm tsx scripts/backfill-discriminators.ts --apply      # write
 *   pnpm tsx scripts/backfill-discriminators.ts --limit 500  # cap rows
 *   pnpm tsx scripts/backfill-discriminators.ts --shade 102  # one shade
 *
 * WHY THIS IS POSSIBLE WITHOUT RE-RUNNING VISION
 *
 * add_image stored `dominant_colors` as [{hex, label}, ...] where the label is
 * the model's own prose: "warm orange-red shimmer shift", "pink iridescent
 * flakes", "deep blackened purple base". That is the same information the
 * discriminators block carries, just unparsed. 98.5% of entries have a hex.
 *
 * WHAT THIS DOES NOT DO
 *
 * It recovers structure, not accuracy. The labels are what the model said at
 * the time, through whatever crop was then in use — it cannot say anything
 * better. And dominant_colors averages ~3 entries, where a fresh structured
 * analysis separates shimmerFlash / shift / glitter / flake and adds
 * bottleEdgeColor, typically 8-12 values. Lower resolution, not equivalent.
 *
 * Rows that already have discriminators are skipped: a real measurement always
 * beats a reconstruction.
 */
import "dotenv/config";
import { getSupabase } from "../src/supabase/client.js";
import { extractAndEmbed } from "../src/util/feature-extract.js";

type ColorEntry = { hex?: string; label?: string };
type Bucket = "base" | "shimmer" | "flake" | "glitter" | "shift" | "thermalCold" | "thermalWarm" | "ignore" | "unknown";

const APPLY = process.argv.includes("--apply");
// Reprocess rows this script previously reconstructed. Never touches rows whose
// discriminators came from a real analyze_images run.
const FORCE = process.argv.includes("--force");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
})();
const SHADE = (() => {
  const i = process.argv.indexOf("--shade");
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
})();

/**
 * Classify one label into a discriminator bucket.
 *
 * Order matters: labels routinely carry more than one cue ("electric blue
 * flake glow", "sheer base with fine holo shimmer"). The most specific
 * particle claim wins, and "base" is checked last so a base mention does not
 * swallow an entry that is really describing a particle sitting in that base.
 */
function classify(label: string): Bucket {
  const l = label.toLowerCase();

  // Not polish. The bottle cap is hardware, and the old extractor scraped
  // dominantColors[1..3] blindly — so "black cap" has been stored as a flake
  // colour. Drop these outright rather than bucketing them.
  if (/\bcap\b|\blid\b|\bbrush\b|bottle glass|glass rim|label\b|背景|background/.test(l)) return "ignore";

  // Lighting variants describe the SAME material under different light. Taking
  // them as separate colours double-counts the base and inflates the particle
  // palette with tones that no pigment produces.
  if (/highlight|shadow|mid-?tone|shaded|lit area|reflection of/.test(l)
      && !/flak|glitter|shimmer|shift|holo/.test(l)) return "ignore";

  // Thermal states have their own fields in the discriminators block.
  // "hot" is used interchangeably with "warm" for the activated state, and the
  // state marker appears both as "(cold state)" and "cold state —".
  if (/cold state|cool state|cold thermal|\(cold/.test(l)) return "thermalCold";
  if (/warm state|warm thermal|\(warm|hot state|hot thermal|\(hot/.test(l)) return "thermalWarm";

  if (/\bflak(e|ie)/.test(l)) return "flake";
  // "scatter" is how the model describes dispersed particles; group it with
  // glitter rather than shimmer, which implies a continuous sheen.
  if (/\bglitter|micro-?glitter|sparkle|scatter|speck|particle/.test(l)) return "glitter";
  if (/\bshimmer|flash|iridescent|pearl|holo|holographic|reflect|metallic|chrome|foil/.test(l)) return "shimmer";
  if (/\bshift|duochrome|multichrome|chameleon|travel\b/.test(l)) return "shift";
  if (/\bbase|creme|cream|jelly|crelly|body\b/.test(l)) return "base";
  return "unknown";
}

function isHex(h?: string): h is string {
  return !!h && /^#[0-9a-f]{6}$/i.test(h.trim());
}

async function main() {
  const supabase = getSupabase();

  // PostgREST caps a single response at 1000 rows, so page explicitly —
  // otherwise the script silently reports on the first 1000 and looks complete.
  const PAGE = 1000;
  const rows: Array<{ id: number; shade_id: number; source_path: string; dominant_colors: unknown }> = [];
  for (let from = 0; ; from += PAGE) {
    if (LIMIT && rows.length >= LIMIT) break;
    const to = from + PAGE - 1;
    let q = supabase
      .from("image_signatures")
      .select("id, shade_id, source_path, dominant_colors")
      .order("id", { ascending: true })
      .range(from, to);
    q = FORCE
      ? q.or("discriminators.is.null,discriminators->>_reconstructedFrom.eq.dominant_colors_labels")
      : q.is("discriminators", null);
    if (SHADE) q = q.eq("shade_id", SHADE);

    const { data, error } = await q;
    if (error) throw new Error(`query failed: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as typeof rows));
    if (data.length < PAGE) break;
  }
  if (LIMIT) rows.length = Math.min(rows.length, LIMIT);

  if (!rows.length) {
    console.log("No rows need backfilling.");
    return;
  }

  const tally: Record<Bucket, number> = { base: 0, shimmer: 0, flake: 0, glitter: 0, shift: 0, thermalCold: 0, thermalWarm: 0, ignore: 0, unknown: 0 };
  let wouldWrite = 0;
  let noUsableColors = 0;
  const samples: string[] = [];
  const updates: Array<{
    id: number;
    discriminators: Record<string, unknown>;
    base_color_hex: string | null;
    base_color_lab: [number, number, number] | null;
    embedding: number[];
  }> = [];

  for (const row of rows) {
    const entries: ColorEntry[] = Array.isArray(row.dominant_colors)
      ? (row.dominant_colors as ColorEntry[])
      : [];

    const buckets: Record<Bucket, ColorEntry[]> = {
      base: [], shimmer: [], flake: [], glitter: [], shift: [],
      thermalCold: [], thermalWarm: [], ignore: [], unknown: [],
    };

    for (const e of entries) {
      if (!isHex(e.hex)) continue;
      const b = classify(e.label ?? "");
      buckets[b].push({ hex: e.hex, label: e.label });
      tally[b]++;
    }

    const usable = Object.entries(buckets)
      .filter(([k]) => k !== "unknown" && k !== "ignore")
      .some(([, v]) => v.length > 0);
    if (!usable) { noUsableColors++; continue; }

    // First entry is conventionally the base when nothing was labelled as one.
    // On a thermal there is often no "base" at all — both colours are states —
    // so fall back to the cold state, which is the canonical resting colour and
    // what dominantColors[0] already resolved to in practice.
    const baseEntry = buckets.base[0]
      ?? (buckets.unknown[0] && entries.length ? buckets.unknown[0] : undefined)
      ?? buckets.thermalCold[0];

    const discriminators = {
      baseColor: baseEntry ?? null,
      bottleEdgeColor: null,
      flakeColors: buckets.flake.length ? buckets.flake : null,
      glitterColors: buckets.glitter.length ? buckets.glitter : null,
      shimmerFlashColors: buckets.shimmer.length ? buckets.shimmer : null,
      shiftColors: buckets.shift.length ? buckets.shift : null,
      magneticLineColor: null,
      thermalCold: buckets.thermalCold[0] ?? null,
      thermalWarm: buckets.thermalWarm[0] ?? null,
      // Provenance, so a reconstruction is never mistaken for a measurement.
      _reconstructedFrom: "dominant_colors_labels",
    };

    // Re-derive the per-row features too. The aggregate averages stored
    // base_color_lab and embedding values computed at index time, so writing
    // discriminators alone changes nothing downstream — the row would keep the
    // base colour and particle dims produced by the old scrape.
    const features = extractAndEmbed({
      dominantColors: entries as never,
      observedEffects: [],
      discriminators: discriminators as never,
    });

    updates.push({
      id: row.id,
      discriminators,
      base_color_hex: features.baseColorHex ?? null,
      base_color_lab: features.baseColorLab,
      embedding: features.embedding,
    });
    wouldWrite++;

    if (samples.length < 5) {
      const summarise = (k: string, v: ColorEntry[] | null) =>
        v?.length ? `    ${k}: ${v.map((x) => x.hex).join(", ")}` : null;
      samples.push(
        [
          `  row ${row.id} (shade ${row.shade_id})`,
          `    from: ${entries.map((e) => `${e.hex} "${e.label ?? ""}"`).join(" | ")}`,
          summarise("baseColor", baseEntry ? [baseEntry] : null),
          summarise("flakeColors", discriminators.flakeColors as ColorEntry[] | null),
          summarise("glitterColors", discriminators.glitterColors as ColorEntry[] | null),
          summarise("shimmerFlashColors", discriminators.shimmerFlashColors as ColorEntry[] | null),
          summarise("shiftColors", discriminators.shiftColors as ColorEntry[] | null),
        ].filter(Boolean).join("\n"),
      );
    }
  }

  const totalClassified = Object.values(tally).reduce((a, b) => a + b, 0);
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} rows${FORCE ? " (incl. previously reconstructed)" : " without discriminators"}\n`);
  console.log(`Colour entries classified: ${totalClassified}`);
  for (const [k, v] of Object.entries(tally)) {
    const pct = totalClassified ? ((v / totalClassified) * 100).toFixed(1) : "0.0";
    console.log(`  ${k.padEnd(9)} ${String(v).padStart(6)}  ${pct.padStart(5)}%`);
  }
  console.log(`\nRows that would be written: ${wouldWrite}`);
  console.log(`Rows with no usable colours: ${noUsableColors}`);
  console.log(`\nSamples:\n${samples.join("\n\n")}\n`);

  if (!APPLY) {
    console.log("Dry run — nothing written. Re-run with --apply to write.\n");
    return;
  }

  let written = 0;
  for (let i = 0; i < updates.length; i += 200) {
    const chunk = updates.slice(i, i + 200);
    for (const u of chunk) {
      const { error: upErr } = await supabase
        .from("image_signatures")
        .update({
          discriminators: u.discriminators,
          base_color_hex: u.base_color_hex,
          base_color_lab: u.base_color_lab,
          embedding: u.embedding,
        })
        .eq("id", u.id);
      if (upErr) {
        console.error(`  row ${u.id} failed: ${upErr.message}`);
        continue;
      }
      written++;
    }
    console.log(`  ${Math.min(i + 200, updates.length)}/${updates.length}`);
  }
  console.log(`\nWrote ${written} rows.`);
  console.log("Aggregates are unchanged — run shade_index recompute_shade per affected shade.\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
