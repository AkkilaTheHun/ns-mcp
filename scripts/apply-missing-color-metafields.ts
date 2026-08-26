#!/usr/bin/env tsx
/**
 * Apply color-pattern metafield refs to products that had vision detect
 * colors but no existing color-pattern metafield.
 *
 * Multi-source color extraction (weighted):
 *   1. Legacy Colour_X / Color_X tags         (weight 3.0 — manually assigned)
 *   2. Title words matching catalog metaobject (weight 2.5)
 *   3. Description matching catalog metaobject (weight 1.5)
 *   4. Named-color hints (gemstones, etc.)     (weight 2.0)
 *   5. Vision-detected colors from gap report  (weight 1.0 — fallback)
 *
 * Usage:
 *   tsx scripts/apply-missing-color-metafields.ts "Starrily"
 *   tsx scripts/apply-missing-color-metafields.ts "Starrily" --apply
 *   tsx scripts/apply-missing-color-metafields.ts "Starrily" --shop nailstuff-ca.myshopify.com
 *
 * Default is DRY RUN. Pass --apply to write to Shopify.
 *
 * After applying, run recompose-alts on the same brand to push alt text
 * (vision data already cached, no new spend).
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { shopifyGraphQL, throwIfUserErrors } from "../src/shopify/client.js";
import { getSupabase } from "../src/supabase/client.js";

interface Args {
  vendor: string;
  shop?: string;
  apply: boolean;
  capPerProduct: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  let vendor: string | undefined, shop: string | undefined;
  let apply = false, capPerProduct = 5, verbose = false;
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shop") shop = argv[++i];
    else if (a === "--apply") apply = true;
    else if (a === "--cap-per-product") capPerProduct = parseInt(argv[++i], 10);
    else if (a === "--verbose" || a === "-v") verbose = true;
    else pos.push(a);
  }
  vendor = pos[0];
  if (!vendor) {
    console.error("Usage: tsx scripts/apply-missing-color-metafields.ts <vendor> [--shop X] [--apply] [--cap-per-product 5] [-v]");
    process.exit(1);
  }
  return { vendor, shop, apply, capPerProduct, verbose };
}

const ACCESSORY_PATTERNS = [/sticker/i, /enamel pin/i, /\bpin\b/i, /decal/i, /cuticle oil/i, /\bbalm\b/i, /\bsoak\b/i];
const CLEAR_PATTERNS = [/top coat/i, /base coat/i, /primer/i, /\bgloss\b/i, /mattifying/i, /stain prevention/i, /all purpose/i];

function classify(title: string): "polish" | "accessory" | "clear-coat" {
  if (ACCESSORY_PATTERNS.some(rx => rx.test(title))) return "accessory";
  if (CLEAR_PATTERNS.some(rx => rx.test(title))) return "clear-coat";
  return "polish";
}

// Named-color hints: product names that imply a color
// (Used when title contains the word and we want to map it to catalog colors.)
const NAMED_COLOR_HINTS: Record<string, string[]> = {
  // gemstones
  "amethyst":    ["purple"],
  "aquamarine":  ["blue", "teal/turquoise"],
  "citrine":     ["yellow", "gold"],
  "ruby":        ["red"],
  "emerald":     ["green"],
  "sapphire":    ["blue"],
  "topaz":       ["yellow", "gold"],
  "garnet":      ["red"],
  "onyx":        ["black"],
  "pearl":       ["white"],
  "ivory":       ["white"],
  "jade":        ["green"],
  "lapis":       ["blue"],
  "lapis lazuli":["blue"],
  "quartz":      ["white", "grey"],
  "rose quartz": ["pink"],
  "peridot":     ["green"],
  "tanzanite":   ["blue", "purple"],
  "sphene":      ["yellow", "green"],
  "moonstone":   ["white", "blue"],
  "opal":        ["white"],
  "obsidian":    ["black"],
  // other color cues common in polish names
  "blueberry":   ["blue", "purple"],
  "cherry":      ["red"],
  "midnight":    ["black"],
  "ocean":       ["blue", "teal/turquoise"],
  "vanta":       ["black"],
  "vantablack":  ["black"],
  "rose":        ["pink"],
  "rosewood":    ["pink", "brown"],
  "blood":       ["red"],
  "magma":       ["red", "orange"],
  "lava":        ["red", "orange"],
  "neon":        ["multicolor"],
  "chrome":      ["silver"],
  "copper":      ["bronze"],
  "honey":       ["yellow", "gold"],
  "champagne":   ["gold", "white"],
  "merlot":      ["red"],
  "rust":        ["orange", "brown"],
};

const COLOR_PATTERN_TYPE = "shopify--color-pattern";

interface ColorMeta { id: string; displayName: string; }

const METAOBJECTS_QUERY = `query($t: String!) { metaobjects(type: $t, first: 250) { edges { node { id displayName } } } }`;

async function fetchColorMetaobjects(shop?: string): Promise<ColorMeta[]> {
  const res = await shopifyGraphQL<{ metaobjects: { edges: Array<{ node: ColorMeta }> } }>(
    METAOBJECTS_QUERY, { t: COLOR_PATTERN_TYPE }, shop
  );
  return res.data?.metaobjects.edges.map(e => e.node) ?? [];
}

const PRODUCTS_BATCH = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id title tags descriptionHtml
      }
    }
  }
`;

interface ProductContext {
  id: string; title: string; tags: string[]; descriptionHtml: string;
}

async function fetchProducts(ids: string[], shop?: string): Promise<ProductContext[]> {
  const out: ProductContext[] = [];
  const BATCH = 50;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const res = await shopifyGraphQL<{ nodes: Array<{ id: string; title: string; tags: string[]; descriptionHtml: string | null } | null> }>(
      PRODUCTS_BATCH, { ids: batch }, shop
    );
    for (const n of res.data?.nodes ?? []) {
      if (n?.id) out.push({ id: n.id, title: n.title, tags: n.tags ?? [], descriptionHtml: n.descriptionHtml ?? "" });
    }
  }
  return out;
}

function stripHtml(s: string): string {
  return (s ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// Build a flexible lookup: any word/phrase (with or without "/") → catalog metaobject GID
function buildColorIndex(metas: ColorMeta[]): {
  byCanonical: Map<string, ColorMeta>;       // lowercase displayName
  bySubword: Map<string, ColorMeta>;          // each word split by "/"
} {
  const byCanonical = new Map<string, ColorMeta>();
  const bySubword = new Map<string, ColorMeta>();
  for (const m of metas) {
    const canonical = m.displayName.toLowerCase().trim();
    byCanonical.set(canonical, m);
    for (const word of canonical.split(/[\/\s,]+/)) {
      const w = word.trim();
      if (w && !bySubword.has(w)) bySubword.set(w, m);
    }
  }
  return { byCanonical, bySubword };
}

function colorFromTagToken(tag: string): string | null {
  // "Colour_Red" → "red", "Color_Pink" → "pink", "Colour_Teal/Turquoise" → "teal/turquoise"
  const m = tag.match(/^(?:colour|color)_(.+)$/i);
  if (!m) return null;
  return m[1].trim().toLowerCase();
}

function extractColorsFromText(text: string, idx: ReturnType<typeof buildColorIndex>): Set<ColorMeta> {
  const t = text.toLowerCase();
  const hits = new Set<ColorMeta>();
  // Check canonical (multi-word) first to prefer longer matches
  for (const [canonical, meta] of idx.byCanonical) {
    // Word-boundary match for the canonical form (handles "teal/turquoise")
    const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i");
    if (rx.test(t)) hits.add(meta);
  }
  // Then subwords
  for (const [word, meta] of idx.bySubword) {
    if (hits.has(meta)) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`\\b${escaped}\\b`, "i");
    if (rx.test(t)) hits.add(meta);
  }
  return hits;
}

const METAFIELDS_SET = `
  mutation($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key ownerType }
      userErrors { field message }
    }
  }
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { vendor, shop, apply, capPerProduct, verbose } = args;

  console.log(`\n=== Apply missing color-pattern metafields: ${vendor} ===`);
  console.log(`Shop: ${shop ?? "(default)"} | Apply: ${apply ? "YES" : "no (dry-run)"} | Cap per product: ${capPerProduct}`);

  // Load gap report
  const gapPath = resolve(import.meta.dirname ?? ".", "../output/alt-pipeline-gaps.json");
  const gap = JSON.parse(await readFile(gapPath, "utf-8")) as {
    productsMissingColorRef: Record<string, {
      id: string; title: string; detected: string;
      recommendedRefs: Array<{ type: string; displayName: string; gid: string }>;
    }>;
  };

  // Cross-reference with shade_signatures to filter by brand
  const sb = getSupabase();
  const { data: shades, error } = await sb
    .from("shade_signatures").select("shopify_product_id").eq("brand", vendor);
  if (error) { console.error(error); process.exit(1); }
  const brandIds = new Set((shades ?? []).map((s: any) => s.shopify_product_id as string).filter(Boolean));

  const candidates = Object.values(gap.productsMissingColorRef).filter(p => brandIds.has(p.id));
  console.log(`Gap entries: ${Object.keys(gap.productsMissingColorRef).length} total, ${candidates.length} for ${vendor}\n`);
  if (!candidates.length) { console.log("Nothing to apply."); return; }

  // Build color index from Shopify metaobjects
  console.log("Loading color-pattern metaobjects from Shopify...");
  const colorMetas = await fetchColorMetaobjects(shop);
  const colorIdx = buildColorIndex(colorMetas);
  console.log(`  ${colorMetas.length} color metaobjects (${[...colorIdx.byCanonical.keys()].slice(0, 10).join(", ")}...)\n`);

  // Fetch all product context (tags + descriptions) for the candidates
  console.log(`Fetching tags + descriptions for ${candidates.length} products...`);
  const ctx = await fetchProducts(candidates.map(c => c.id), shop);
  const ctxById = new Map(ctx.map(c => [c.id, c]));

  // Build proposals with weighted multi-source extraction
  interface Source { source: string; weight: number; }
  interface Proposal {
    productId: string; title: string;
    classification: "polish" | "accessory" | "clear-coat";
    weighted: Map<string, { meta: ColorMeta; weight: number; sources: string[] }>;
    finalGids: string[];
    finalNames: string[];
  }

  const proposals: Proposal[] = [];
  let accessoryCount = 0, clearCoatCount = 0;

  for (const c of candidates) {
    const classification = classify(c.title);
    const proposal: Proposal = {
      productId: c.id, title: c.title, classification,
      weighted: new Map(), finalGids: [], finalNames: [],
    };
    if (classification === "accessory") { accessoryCount++; proposals.push(proposal); continue; }
    if (classification === "clear-coat") { clearCoatCount++; proposals.push(proposal); continue; }

    const product = ctxById.get(c.id);
    const tags = product?.tags ?? [];
    const titleText = c.title.toLowerCase();
    const descText = stripHtml(product?.descriptionHtml ?? "");

    const add = (meta: ColorMeta, weight: number, source: string) => {
      const entry = proposal.weighted.get(meta.id) ?? { meta, weight: 0, sources: [] };
      entry.weight += weight;
      if (!entry.sources.includes(source)) entry.sources.push(source);
      proposal.weighted.set(meta.id, entry);
    };

    // Source 1: legacy Colour_X / Color_X tags (weight 3.0)
    for (const tag of tags) {
      const word = colorFromTagToken(tag);
      if (!word) continue;
      const meta = colorIdx.byCanonical.get(word) ?? colorIdx.bySubword.get(word);
      if (meta) add(meta, 3.0, `tag:${tag}`);
    }

    // Source 2: title contains catalog color word (weight 2.5)
    for (const meta of extractColorsFromText(titleText, colorIdx)) {
      add(meta, 2.5, "title");
    }

    // Source 4: named-color hint (gemstone etc.) — checked via title
    for (const [hintWord, mappedColors] of Object.entries(NAMED_COLOR_HINTS)) {
      const rx = new RegExp(`\\b${hintWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (rx.test(titleText)) {
        for (const mapped of mappedColors) {
          const meta = colorIdx.byCanonical.get(mapped) ?? colorIdx.bySubword.get(mapped);
          if (meta) add(meta, 2.0, `name-hint:${hintWord}`);
        }
      }
    }

    // Source 3: description text contains catalog color word (weight 1.5)
    for (const meta of extractColorsFromText(descText, colorIdx)) {
      add(meta, 1.5, "description");
    }

    // Source 5: vision-detected from gap report (weight 1.0, fallback)
    for (const r of c.recommendedRefs) {
      // The gap report's gid points to the same metaobject id we'd look up
      const meta: ColorMeta = { id: r.gid, displayName: r.displayName };
      add(meta, 1.0, "vision");
    }

    // Rank and take top N
    const ranked = [...proposal.weighted.values()].sort((a, b) => b.weight - a.weight);
    const final = ranked.slice(0, capPerProduct);
    proposal.finalGids = final.map(r => r.meta.id);
    proposal.finalNames = final.map(r => r.meta.displayName);
    proposals.push(proposal);
  }

  // Print summary
  console.log("Proposals (sorted by source-weighted score, capped):");
  for (const p of proposals.slice(0, 30)) {
    if (p.classification === "polish") {
      const annotations = [...p.weighted.values()].slice(0, capPerProduct).map(w => `${w.meta.displayName}[${w.sources.join("+")}]`);
      console.log(`  ✓ ${p.title.slice(0, 40).padEnd(40)} → ${p.finalNames.join(", ")}`);
      if (verbose) console.log(`      sources: ${annotations.join(" | ")}`);
    } else if (p.classification === "clear-coat") {
      console.log(`  ⊘ clear-coat (skip)  ${p.title.slice(0, 40)}`);
    } else {
      console.log(`  ✗ accessory (skip)   ${p.title.slice(0, 40)}`);
    }
  }
  if (proposals.length > 30) console.log(`  ... and ${proposals.length - 30} more`);

  const polishProposals = proposals.filter(p => p.classification === "polish" && p.finalGids.length > 0);
  console.log(`\nSummary:`);
  console.log(`  Polish to update:        ${polishProposals.length}`);
  console.log(`  Clear coats skipped:     ${clearCoatCount}`);
  console.log(`  Accessories skipped:     ${accessoryCount}`);
  console.log(`  Polish with no refs:     ${proposals.filter(p => p.classification === "polish" && p.finalGids.length === 0).length}`);

  if (!apply) {
    console.log(`\nDry run. Pass --apply to write to Shopify.`);
    return;
  }

  console.log(`\nApplying...`);
  const BATCH_SIZE = 25;
  let updated = 0, errors = 0;
  for (let i = 0; i < polishProposals.length; i += BATCH_SIZE) {
    const batch = polishProposals.slice(i, i + BATCH_SIZE);
    const metafields = batch.map(p => ({
      ownerId: p.productId,
      namespace: "shopify",
      key: "color-pattern",
      type: "list.metaobject_reference",
      value: JSON.stringify(p.finalGids),
    }));
    try {
      const res = await shopifyGraphQL<any>(METAFIELDS_SET, { metafields }, shop);
      throwIfUserErrors(res.data?.metafieldsSet?.userErrors, "metafieldsSet");
      updated += batch.length;
      console.log(`  [${updated}/${polishProposals.length}] ✓`);
    } catch (err) {
      console.log(`  [${i+1}-${i+batch.length}] ✗ ${err}`);
      errors += batch.length;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Updated: ${updated} / ${polishProposals.length}`);
  console.log(`Errors:  ${errors}`);
  console.log(`\nNext: re-push alt text from cached vision:`);
  console.log(`  ./node_modules/.bin/tsx scripts/recompose-alts.ts "${vendor}" --shop ${shop ?? "<shop>"}`);
}

main().catch(err => { console.error(err); process.exit(1); });
