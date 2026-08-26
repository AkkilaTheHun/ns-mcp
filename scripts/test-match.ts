#!/usr/bin/env tsx
/**
 * Primitive shade matcher with Stage 2 text augmentation.
 *
 * Pipeline:
 *   1. Vision (Sonnet 4.6 + Sharp closeup, same as catalog)
 *      → dominant_colors, observed_effects, embedding
 *   2. Label OCR (separate Sonnet call, label-focused prompt)
 *      → brand text, shade text from bottle label
 *   3. Vector match (cosine over shade_signatures.embedding)
 *   4. Text match (trigram similarity over shade_name + brand)
 *   5. Combined ranking with text-confirmation boost
 *
 * Usage:
 *   tsx scripts/test-match.ts <url-or-path> [--limit 10]
 *                             [--include-images] [--no-ocr]
 *                             [--hint 'optional vendor hint'] [-v]
 */
import "dotenv/config";
import sharp from "sharp";
import { readFile, stat } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { analyzeImage as analyzeImageClaude } from "../src/anthropic/vision.js";
import { extractAndEmbed } from "../src/util/feature-extract.js";
import { getSupabase } from "../src/supabase/client.js";

interface Args {
  input: string;
  limit: number;
  includeImages: boolean;
  vendorHint: string;
  verbose: boolean;
  skipOcr: boolean;
  visionRuns: number;
}

function parseArgs(argv: string[]): Args {
  let input: string | undefined;
  let limit = 10, includeImages = false, vendorHint = "", verbose = false, skipOcr = false;
  let visionRuns = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") limit = parseInt(argv[++i], 10);
    else if (a === "--include-images") includeImages = true;
    else if (a === "--hint") vendorHint = argv[++i];
    else if (a === "--verbose" || a === "-v") verbose = true;
    else if (a === "--no-ocr") skipOcr = true;
    else if (a === "--vision-runs") visionRuns = parseInt(argv[++i], 10);
    else input = a;
  }
  if (!input) {
    console.error("Usage: tsx scripts/test-match.ts <url-or-path> [--limit 10] [--include-images] [--no-ocr] [--vision-runs 3] [--hint '...'] [-v]");
    process.exit(1);
  }
  return { input, limit, includeImages, vendorHint, verbose, skipOcr, visionRuns };
}

async function loadImage(input: string): Promise<Buffer> {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    console.log(`Downloading ${input}...`);
    const res = await fetch(input);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }
  console.log(`Reading ${input}...`);
  const s = await stat(input).catch(() => null);
  if (!s) throw new Error(`File not found: ${input}`);
  return readFile(input);
}

// ---------------------------------------------------------------------------
// Label OCR — separate Sonnet call focused on visible bottle label text
// ---------------------------------------------------------------------------

interface LabelOcr {
  brand: string | null;
  shade: string | null;
  raw_text: string;
  confidence: number;
}

let _client: Anthropic | undefined;
function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

const OCR_SYSTEM = `You are reading text from a nail polish bottle label in a photo. Your job is to extract any visible printed text from the bottle or label, NOT to describe the polish color or contents.`;

const OCR_USER = `Look at the image. If there is a nail polish bottle with any visible label text:
- Extract the BRAND name if printed (often the largest text on the cap or label)
- Extract the SHADE name if printed (often below or above the brand)
- Capture all readable raw text

If no bottle is visible, or the label is unreadable, return all fields as null with confidence 0.

Return ONLY a JSON object, no prose:
{
  "brand": "string or null",
  "shade": "string or null",
  "raw_text": "concatenated readable text, or empty string",
  "confidence": 0.0-1.0
}

Do NOT guess. Only return text you can actually read in the image.`;

async function extractLabelText(fullBase64: string): Promise<LabelOcr | null> {
  try {
    const resp = await client().messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: OCR_SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: fullBase64 } },
          { type: "text", text: OCR_USER },
        ],
      }],
    });
    const text = resp.content.find((b: any) => b.type === "text") as any;
    if (!text?.text) return null;
    const cleaned = text.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    return JSON.parse(cleaned) as LabelOcr;
  } catch (err) {
    console.log(`  ! OCR parse error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Combined ranking
// ---------------------------------------------------------------------------

interface VectorMatch {
  id: number; brand: string; shade_name: string; collection: string | null;
  shopify_product_id: string | null;
  similarity: number;
  // Attribute fields for the filter step
  finish_type?: string | null;
  has_holographic?: boolean | null;
  has_thermal?: boolean | null;
  has_magnetic?: boolean | null;
}

interface QueryAttrs {
  finish_type: string | null;
  has_holographic: boolean;
  has_thermal: boolean;
  has_magnetic: boolean;
  has_ultrachrome: boolean;
  has_iridescent: boolean;
}

interface TextMatch {
  id: number; brand: string; shade_name: string; collection: string | null;
  shopify_product_id: string | null;
  brand_similarity: number; shade_similarity: number; combined_score: number;
}

interface FusedMatch {
  id: number; brand: string; shade_name: string; collection: string | null;
  shopify_product_id: string | null;
  vector_score: number | null;
  text_score: number | null;
  final_score: number;
  signals: string[];
}

interface ImageMatch {
  image_id: number; shade_id: number;
  brand: string; shade_name: string;
  source_path: string; image_type: string | null;
  similarity: number;
}

interface PerImageVote { totalScore: number; count: number; topScore: number; }

function aggregateImageVotes(imageMatches: ImageMatch[]): Map<number, PerImageVote> {
  const votes = new Map<number, PerImageVote>();
  for (const m of imageMatches) {
    const v = votes.get(m.shade_id) ?? { totalScore: 0, count: 0, topScore: 0 };
    v.totalScore += m.similarity;
    v.count += 1;
    v.topScore = Math.max(v.topScore, m.similarity);
    votes.set(m.shade_id, v);
  }
  return votes;
}

// Per-attribute mismatch penalty. Small penalties so they break ties
// but don't override strong vector matches outright.
function attributePenalty(
  query: QueryAttrs,
  cand: { finish_type?: string | null; has_holographic?: boolean | null; has_thermal?: boolean | null; has_magnetic?: boolean | null; },
): { penalty: number; reasons: string[] } {
  let penalty = 0;
  const reasons: string[] = [];

  // Hard boolean attrs: thermal and magnetic are mutually exclusive most of the time
  // — if query says thermal and candidate isn't (or vice versa), they're unlikely to be the same polish.
  if (query.has_thermal && cand.has_thermal === false) { penalty += 0.05; reasons.push("not-thermal"); }
  if (!query.has_thermal && cand.has_thermal === true) { penalty += 0.03; reasons.push("is-thermal"); }
  if (query.has_magnetic && cand.has_magnetic === false) { penalty += 0.05; reasons.push("not-magnetic"); }
  if (!query.has_magnetic && cand.has_magnetic === true) { penalty += 0.03; reasons.push("is-magnetic"); }

  // Holographic is a softer signal (visible in some photos but not others)
  if (query.has_holographic && cand.has_holographic === false) { penalty += 0.025; reasons.push("not-holo"); }

  // Finish type — small penalty for mismatch, except creme/jelly which can be ambiguous
  if (query.finish_type && cand.finish_type && query.finish_type !== cand.finish_type) {
    // Don't penalize jelly/crelly confusion — they're often interchangeable in vision
    const sw = `${query.finish_type}/${cand.finish_type}`;
    const softPairs = new Set(["jelly/crelly", "crelly/jelly", "jelly/creme", "creme/jelly"]);
    if (softPairs.has(sw)) {
      penalty += 0.01; reasons.push(`finish~${cand.finish_type}`);
    } else {
      penalty += 0.04; reasons.push(`finish=${cand.finish_type}`);
    }
  }

  return { penalty, reasons };
}

function fuseMatches(
  vectorMatches: VectorMatch[],
  textMatches: TextMatch[],
  imageMatches: ImageMatch[],
  hasOcr: boolean,
  queryAttrs: QueryAttrs,
): FusedMatch[] {
  // Index text matches by shade id for boost lookup
  const textById = new Map<number, TextMatch>(textMatches.map(t => [t.id, t]));
  const byId = new Map<number, FusedMatch>();

  // Per-image votes: aggregate top-K per-image matches by shade_id.
  // A shade that appears multiple times near the top of per-image
  // results is the strongest signal we have that the query photo
  // matches a specific catalog photo of that shade.
  const imageVotes = aggregateImageVotes(imageMatches);

  // Universe of candidates is the union of vector top-K + image-vote
  // shades + strong text matches. We start by recording every vector
  // candidate, then add shades that only image votes surfaced.
  const allShades = new Map<number, { brand: string; shade_name: string; collection: string | null; shopify_product_id: string | null }>();
  for (const v of vectorMatches) allShades.set(v.id, { brand: v.brand, shade_name: v.shade_name, collection: v.collection, shopify_product_id: v.shopify_product_id });
  for (const m of imageMatches) {
    if (!allShades.has(m.shade_id)) allShades.set(m.shade_id, { brand: m.brand, shade_name: m.shade_name, collection: null, shopify_product_id: null });
  }

  for (const [shadeId, info] of allShades) {
    const v = vectorMatches.find(x => x.id === shadeId);
    const tm = textById.get(shadeId);
    const iv = imageVotes.get(shadeId);

    // Base score floor: take the BETTER of aggregate-vector or
    // per-image-top. If a shade's aggregate didn't make top-K but its
    // specific photos match the query strongly, per-image top score
    // becomes the floor. This is the key insight: aggregates blur
    // visually-similar shades; per-image preserves photo-specific
    // signature.
    let baseScore = Math.max(v?.similarity ?? 0, iv?.topScore ?? 0);
    const signals: string[] = [];
    if (v) signals.push("vector");

    // Per-image vote count boost: many top-K matches of the same
    // shade is the strongest "this IS that polish" signal we have.
    // Cap at 0.10 so it tightens ranking without exploding scores.
    let imageBoost = 0;
    if (iv) {
      // Diminishing returns: first vote contributes 0, each subsequent +0.025
      imageBoost = Math.min(0.10, (iv.count - 1) * 0.025);
      signals.push(`per-image×${iv.count}(${iv.topScore.toFixed(2)})`);
    }
    baseScore += imageBoost;

    // Text-OCR boost (shade > brand).
    let textBoost = 0;
    if (tm) {
      if (tm.shade_similarity > 0.3) {
        textBoost = 0.15 * tm.shade_similarity;
        signals.push(`text-shade(${tm.shade_similarity.toFixed(2)})`);
      } else if (tm.brand_similarity > 0.5) {
        textBoost = 0.015 * tm.brand_similarity;
        signals.push(`text-brand(${tm.brand_similarity.toFixed(2)})`);
      }
    }
    baseScore += textBoost;

    // Per-attribute mismatch penalty
    if (v) {
      const { penalty, reasons } = attributePenalty(queryAttrs, {
        finish_type: v.finish_type,
        has_holographic: v.has_holographic,
        has_thermal: v.has_thermal,
        has_magnetic: v.has_magnetic,
      });
      if (penalty > 0) {
        baseScore -= penalty;
        signals.push(`attr-penalty(${reasons.join(",")})`);
      }
    }

    byId.set(shadeId, {
      id: shadeId, brand: info.brand, shade_name: info.shade_name,
      collection: info.collection, shopify_product_id: info.shopify_product_id,
      vector_score: v?.similarity ?? null,
      text_score: tm?.combined_score ?? null,
      final_score: baseScore,
      signals,
    });
  }

  // Text-only candidates: only surfaced if the shade name match is very strong.
  // Brand-only text matches without vector support are not added (would be
  // any product from the brand, useless without vector to narrow visually).
  if (hasOcr) {
    for (const t of textMatches) {
      if (byId.has(t.id)) continue;
      if (t.shade_similarity < 0.6) continue; // require strong shade-name match
      byId.set(t.id, {
        id: t.id, brand: t.brand, shade_name: t.shade_name,
        collection: t.collection, shopify_product_id: t.shopify_product_id,
        vector_score: null,
        text_score: t.combined_score,
        final_score: 0.5 + 0.4 * t.shade_similarity, // anchor below typical vector matches
        signals: [`text-only-shade(${t.shade_similarity.toFixed(2)})`],
      });
    }
  }

  return [...byId.values()].sort((a, b) => b.final_score - a.final_score);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { input, limit, includeImages, vendorHint, verbose, skipOcr, visionRuns } = args;

  console.log("\n=== test-match (vector + label OCR) ===\n");

  const raw = await loadImage(input);
  console.log(`Image size: ${Math.round(raw.length / 1024)} KB`);

  const rotated = sharp(raw, { failOn: "none" }).rotate();
  const full = await rotated.clone()
    .resize({ width: 1400, withoutEnlargement: true })
    .jpeg({ quality: 92 }).toBuffer();
  const crop = await rotated.clone()
    .resize({ width: 800, height: 800, fit: "cover", position: sharp.strategy.attention })
    .jpeg({ quality: 92 }).toBuffer();
  console.log(`Processed: full ${Math.round(full.length / 1024)} KB, crop ${Math.round(crop.length / 1024)} KB\n`);

  // Vision — run N times in parallel and average embeddings to reduce
  // per-call non-determinism. Sonnet's dominantColors[] / observedEffects[]
  // vary slightly between calls; averaging the resulting embeddings gives
  // a more stable query that's comparable to the catalog AGGREGATES
  // (which are averages over many photos each).
  console.log(`Running vision ${visionRuns}x in parallel (Sonnet 4.6)...`);
  const fullB64 = full.toString("base64");
  const cropB64 = crop.toString("base64");
  const runs = await Promise.all(
    Array.from({ length: visionRuns }, () =>
      analyzeImageClaude(
        fullB64, "image/jpeg",
        { productName: "Unknown", brand: "Unknown", vendorHint },
        "claude-sonnet-4-6",
        { base64: cropB64, mimeType: "image/jpeg" },
      ),
    ),
  );
  // First run is the "primary" for display; embeddings get averaged across all runs
  const analysis = runs[0];

  console.log("\nVision detected (run 1):");
  console.log(`  imageType:    ${(analysis as any).imageType}`);
  console.log(`  confidence:   ${(analysis as any).confidence}`);
  console.log(`  dominantColors:`);
  for (const dc of (analysis as any).dominantColors ?? []) {
    console.log(`    ${dc.hex ?? "—"}  ${dc.label}`);
  }
  console.log(`  observedEffects: ${((analysis as any).observedEffects ?? []).join(", ")}`);
  if (visionRuns > 1 && verbose) {
    console.log(`\n  Run-to-run variance (across ${visionRuns} runs):`);
    for (let r = 0; r < runs.length; r++) {
      const top = (runs[r] as any).dominantColors?.[0]?.label ?? "?";
      console.log(`    run ${r + 1}: ${(runs[r] as any).imageType} / conf=${(runs[r] as any).confidence} / top color: ${top}`);
    }
  }

  // Label OCR (Stage 2) — one call, OCR is more deterministic than color/effect detection
  let ocr: LabelOcr | null = null;
  if (!skipOcr) {
    console.log("\nRunning label OCR...");
    ocr = await extractLabelText(fullB64);
    if (ocr) {
      console.log(`  brand:        ${ocr.brand ?? "(none)"}`);
      console.log(`  shade:        ${ocr.shade ?? "(none)"}`);
      console.log(`  confidence:   ${ocr.confidence}`);
      if (verbose) console.log(`  raw:          ${ocr.raw_text}`);
    } else {
      console.log(`  (OCR failed)`);
    }
  }

  // Feature extraction — compute per-run features, then average the
  // 50-dim embedding vectors element-wise.
  const allFeatures = runs.map(r => extractAndEmbed({
    dominantColors: (r as any).dominantColors ?? [],
    observedEffects: (r as any).observedEffects ?? [],
    altText: (r as any).altText,
  }));

  // Average embedding across all runs
  const avgEmbedding = new Array<number>(50).fill(0);
  for (const f of allFeatures) {
    for (let k = 0; k < 50; k++) avgEmbedding[k] += f.embedding[k];
  }
  for (let k = 0; k < 50; k++) avgEmbedding[k] /= allFeatures.length;

  // Compute pairwise cosine similarity between runs as a stability metric
  let stabilityScore = 1.0;
  if (allFeatures.length > 1) {
    function cosine(a: number[], b: number[]): number {
      let dot = 0, na = 0, nb = 0;
      for (let k = 0; k < a.length; k++) { dot += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }
    const sims: number[] = [];
    for (let i = 0; i < allFeatures.length; i++) {
      for (let j = i + 1; j < allFeatures.length; j++) {
        sims.push(cosine(allFeatures[i].embedding, allFeatures[j].embedding));
      }
    }
    stabilityScore = sims.reduce((a, b) => a + b, 0) / sims.length;
  }

  const features = { ...allFeatures[0], embedding: avgEmbedding };

  if (visionRuns > 1) {
    const stability = stabilityScore.toFixed(4);
    const tag = stabilityScore > 0.98 ? "HIGH" : stabilityScore > 0.93 ? "MED" : "LOW";
    console.log(`\nQuery embedding stability across ${visionRuns} runs: ${stability} (${tag})`);
    if (stabilityScore < 0.93) {
      console.log("  ⚠ Low stability — vision is uncertain about this image. Match results may vary.");
    }
  }

  // Vector match (shade aggregate)
  console.log(`\nVector search (shade aggregate, top ${limit * 2})...`);
  const sb = getSupabase();
  const { data: vectorRaw } = await sb.rpc("match_shades", {
    query_embedding: features.embedding as any,
    match_limit: limit * 2,
  });
  const vectorMatches: VectorMatch[] = vectorRaw ?? [];

  // Per-image vector match (always run — strong production signal)
  console.log(`Vector search (per-image, top ${limit * 2})...`);
  const { data: imgRaw } = await sb.rpc("match_images", {
    query_embedding: features.embedding as any,
    match_limit: limit * 2,
  });
  const imageMatches: ImageMatch[] = imgRaw ?? [];

  // Text match (only if OCR returned something useful)
  let textMatches: TextMatch[] = [];
  const hasOcr = !!(ocr && ocr.confidence > 0.3 && (ocr.brand || ocr.shade));
  if (hasOcr) {
    console.log("Text trigram search...");
    const { data: textRaw } = await sb.rpc("match_shades_by_text", {
      brand_query: ocr!.brand,
      shade_query: ocr!.shade,
      match_limit: limit * 2,
    });
    textMatches = textRaw ?? [];
    if (verbose) {
      console.log(`  Top text matches:`);
      for (const t of textMatches.slice(0, 5)) {
        console.log(`    ${t.combined_score.toFixed(3)}  ${t.brand} ${t.shade_name}`);
      }
    }
  }

  // Query attribute vector for the filter step
  const queryAttrs: QueryAttrs = {
    finish_type: features.flake.finishType ?? null,
    has_holographic: features.flake.hasHolographic,
    has_thermal: features.flake.hasThermal,
    has_magnetic: features.flake.hasMagnetic,
    has_ultrachrome: features.flake.hasUltrachrome,
    has_iridescent: features.flake.hasIridescent,
  };

  // Fuse: shade-aggregate vector + per-image vector votes + OCR text + attribute filter
  const fused = fuseMatches(vectorMatches, textMatches, imageMatches, hasOcr, queryAttrs).slice(0, limit);

  console.log(`\n--- Combined match ranking (vector + OCR text) ---`);
  console.log("  Score  Brand                    Shade                              Signals");
  console.log("  " + "-".repeat(95));
  for (const m of fused) {
    const score = m.final_score.toFixed(3);
    const sig = m.signals.join("+");
    console.log(`  ${score}  ${(m.brand ?? "").slice(0, 22).padEnd(22)}  ${(m.shade_name ?? "").slice(0, 32).padEnd(32)}  ${sig}`);
  }

  if (verbose) {
    console.log("\n  detail:");
    console.log("  vec_s  txt_s   brand                 shade");
    for (const m of fused) {
      const v = m.vector_score != null ? m.vector_score.toFixed(3) : "  -  ";
      const t = m.text_score != null ? m.text_score.toFixed(3) : "  -  ";
      console.log(`  ${v}  ${t}   ${(m.brand ?? "").slice(0, 20).padEnd(20)}  ${m.shade_name}`);
    }
  }

  if (includeImages) {
    console.log("\n--- Raw per-image matches (already factored into fusion above) ---");
    console.log("  Score  Brand                    Shade                              Image type");
    console.log("  " + "-".repeat(95));
    for (const m of imageMatches.slice(0, limit)) {
      const score = m.similarity.toFixed(3);
      console.log(`  ${score}  ${(m.brand ?? "").slice(0, 22).padEnd(22)}  ${(m.shade_name ?? "").slice(0, 32).padEnd(32)}  ${m.image_type ?? ""}`);
    }
  }

  console.log("");
}

main().catch(err => { console.error("\nFatal:", err); process.exit(1); });
