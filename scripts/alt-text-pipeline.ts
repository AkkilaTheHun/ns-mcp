#!/usr/bin/env tsx
/**
 * Alt-text backfill pipeline for an entire brand (vendor).
 *
 * Pairs vision analysis (Sonnet 4.6 with Sharp closeup) with shade indexing
 * via the same modules `pnpm index-brand` uses, then composes a Glitch-pattern
 * alt text from CANONICAL metafield references (not vision interpretation),
 * and pushes it back to Shopify via fileUpdate.
 *
 *   Vision returns:  imageType, skinTone, nailCount, lighting,
 *                    dominantColors[], observedEffects[], altText, confidence
 *   Used for:        - image_signatures + shade_signatures (full)
 *                    - alt composer: imageType + skinTone only
 *   NOT used for:    - color or finish words in alt text — those come
 *                      from shopify.color-pattern / shopify.cosmetic-finish /
 *                      custom.nailstuff_polish_type metaobject references.
 *
 * Gap protocol: at end of run, lists vision-detected colors / effects
 * that do not match any existing color-pattern / cosmetic-finish /
 * polish-type metaobject handle. Reports only; does NOT auto-create.
 *
 * Usage:
 *   pnpm alt-text-pipeline "Chamaeleon Nails"                     # whole brand
 *   pnpm alt-text-pipeline "Cadillacquer" "Take It Easy"          # one collection
 *   pnpm alt-text-pipeline "Dam Nail Polish" --shop nailstuff-ca.myshopify.com
 *   pnpm alt-text-pipeline "Dam Nail Polish" --limit 3            # cap products
 *   pnpm alt-text-pipeline "Dam Nail Polish" --dry-run-push       # skip fileUpdate
 *
 * Env in .env (same as MCP):
 *   SHOPS or SHOP_DOMAIN + SHOPIFY_ACCESS_TOKEN
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL + SUPABASE_SERVICE_KEY
 */
import "dotenv/config";
import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { shopifyGraphQL, throwIfUserErrors } from "../src/shopify/client.js";
import { analyzeImage as analyzeImageClaude } from "../src/anthropic/vision.js";
import { extractAndEmbed, stripHtml } from "../src/util/feature-extract.js";
import { getSupabase } from "../src/supabase/client.js";
import { recomputeShadeAggregate } from "../src/supabase/recompute.js";
import { composeAltsForShade, type ImageInput } from "../src/util/alt-composer.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  vendor: string;
  collection?: string;
  shop?: string;
  limit?: number;
  concurrency: number;
  dryRunPush: boolean;
  applyGaps: boolean;
  verbose: boolean;
  productType?: string;
}

function parseArgs(argv: string[]): Args {
  let vendor: string | undefined;
  let collection: string | undefined;
  let shop: string | undefined;
  let limit: number | undefined;
  let concurrency = 6;
  let dryRunPush = false;
  let applyGaps = false;
  let verbose = false;
  let productType: string | undefined;

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shop") shop = argv[++i];
    else if (a === "--limit") limit = parseInt(argv[++i], 10);
    else if (a === "--concurrency") concurrency = parseInt(argv[++i], 10);
    else if (a === "--dry-run-push") dryRunPush = true;
    else if (a === "--apply-gaps") applyGaps = true;
    else if (a === "--verbose" || a === "-v") verbose = true;
    else if (a === "--product-type") productType = argv[++i];
    else positional.push(a);
  }
  vendor = positional[0];
  collection = positional[1];
  if (!vendor) {
    console.error("Usage: pnpm alt-text-pipeline <vendor> [<collection>] [--shop X] [--limit N] [--concurrency 6] [--dry-run-push] [--apply-gaps] [--product-type 'Nail Polish'] [-v]");
    process.exit(1);
  }
  return { vendor, collection, shop, limit, concurrency, dryRunPush, applyGaps, verbose, productType };
}

// ---------------------------------------------------------------------------
// Canonical color + finish composition
// ---------------------------------------------------------------------------

// Order for finish-phrase composition. Reads naturally as:
//   {optical adjectives} {particle} {formula base} {behavior modifier} {role}
// Example: "purple-white multichrome shimmer flakie crelly UV"
const FINISH_ORDER = [
  // 1. optical adjectives lead
  "Holographic", "Multichrome", "Duochrome", "Reflective", "Shimmer",
  "Glitter", "Metallic", "Matte", "Glossy", "Opaque", "Holo",
  // 2. particle types
  "Flakies", "Flakes",
  // 3. formula base (noun anchor)
  "Crelly", "Jelly", "Creme",
  // 4. behavior modifiers (suffix)
  "Magnetic", "Thermal", "UV", "Glow in the Dark", "GITD", "Crackle", "Sheer",
  // 5. role suffixes
  "Topper", "Top Coat",
];

function normColor(label: string): string {
  const c = label.toLowerCase().trim();
  return c.includes("/") ? c.split("/")[0] : c;
}

function composeColor(labels: string[]): string {
  if (!labels.length) return "";
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const l of labels) {
    const c = normColor(l);
    if (c && !seen.has(c)) { seen.add(c); ordered.push(c); }
  }
  if (ordered.length === 1) return ordered[0];
  return ordered.slice(0, 2).join("-");
}

function composeFinish(finishLabels: string[], typeLabels: string[]): string {
  const have = new Set<string>([...finishLabels, ...typeLabels].map(l => l.trim()));
  const lowerHave = new Set([...have].map(l => l.toLowerCase()));
  const out: string[] = [];
  for (const canon of FINISH_ORDER) {
    if (have.has(canon) || lowerHave.has(canon.toLowerCase())) {
      let w = canon.toLowerCase();
      if (w === "flakies") w = "flakie";
      else if (w === "flakes") w = "flake";
      else if (w === "uv" || w === "gitd") w = w.toUpperCase();
      else if (w === "glow in the dark") w = "glow-in-the-dark";
      out.push(w);
    }
  }
  return out.length ? out.join(" ") : "polish";
}

// ---------------------------------------------------------------------------
// Alt composer (Glitch pattern)
// ---------------------------------------------------------------------------

function composeAlt(opts: {
  shade: string; brand: string; color: string; finish: string;
  imageType?: string; skinTone?: string | null;
}): string {
  const { shade, brand, color, finish, imageType, skinTone } = opts;
  const base = `${shade} by ${brand}, ${color} ${finish}`.replace(/\s+/g, " ").trim().replace(/,\s+$/, "");
  const t = imageType ?? "unknown";
  switch (t) {
    case "swatch_on_nails":
      return skinTone ? `${base} on a ${skinTone} skin tone hand` : `${base} swatched on nails`;
    case "bottle_in_hand":
      return skinTone ? `${base} bottle held in a ${skinTone} hand` : `${base} bottle in hand`;
    case "bottle_standalone":
      return `${base} bottle standalone product shot`;
    case "macro_detail":
      return `${shade} by ${brand}, macro close-up of ${color} ${finish}`.trim();
    case "swatch_wheel": return `${base} swatch wheel`;
    case "swatch_stick": return `${base} swatch stick`;
    case "group_shot": return `${base} collection group shot`;
    case "layering_demo": return `${base} layering demo`;
    case "lifestyle": return `${base} in lifestyle setting`;
    default: return base;
  }
}

// ---------------------------------------------------------------------------
// Shopify queries
// ---------------------------------------------------------------------------

const PRODUCTS_QUERY = `
  query ProductsByVendor($q: String!, $first: Int!, $after: String) {
    products(query: $q, first: $first, after: $after, sortKey: TITLE) {
      edges {
        cursor
        node {
          id
          title
          handle
          vendor
          descriptionHtml
          media(first: 50) {
            edges {
              node {
                ... on MediaImage {
                  id
                  image { url altText }
                }
              }
            }
          }
          collectionMf: metafield(namespace: "product", key: "collection") { value }
          colorMf: metafield(namespace: "shopify", key: "color-pattern") {
            references(first: 8) { nodes { ... on Metaobject { handle displayName } } }
          }
          finishMf: metafield(namespace: "shopify", key: "cosmetic-finish") {
            references(first: 8) { nodes { ... on Metaobject { handle displayName } } }
          }
          typeMf: metafield(namespace: "custom", key: "nailstuff_polish_type") {
            references(first: 8) { nodes { ... on Metaobject { handle displayName } } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const METAOBJECTS_QUERY = `
  query Metaobjects($type: String!) {
    metaobjects(type: $type, first: 250) {
      edges { node { id handle displayName } }
    }
  }
`;

const FILE_UPDATE = `
  mutation($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files { ... on MediaImage { id alt } }
      userErrors { field message }
    }
  }
`;

interface Metaobject { id: string; handle: string; displayName: string; }

interface ProductMedia { mediaGid: string; url: string; altText: string | null; }

interface Product {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  descriptionHtml?: string;
  collection?: string;
  colorLabels: string[];
  finishLabels: string[];
  typeLabels: string[];
  media: ProductMedia[];
}

async function listMetaobjects(type: string, shop?: string): Promise<Metaobject[]> {
  const res = await shopifyGraphQL<{ metaobjects: { edges: Array<{ node: Metaobject }> } }>(
    METAOBJECTS_QUERY, { type }, shop
  );
  return res.data?.metaobjects.edges.map(e => e.node) ?? [];
}

async function listProducts(vendor: string, collection: string | undefined, shop?: string, productType?: string): Promise<Product[]> {
  const products: Product[] = [];
  let cursor: string | null = null;
  // Exclude retired products to match smart-collection convention
  let q = `vendor:"${vendor}" status:active -tag:retired`;
  if (productType) q += ` product_type:"${productType}"`;

  while (true) {
    const res = await shopifyGraphQL<any>(PRODUCTS_QUERY, { q, first: 50, after: cursor }, shop);
    if (!res.data) throw new Error(`Shopify query returned no data`);

    for (const edge of res.data.products.edges) {
      const n = edge.node;
      const collMf = n.collectionMf?.value ?? undefined;
      if (collection && collMf !== collection) continue;

      const media: ProductMedia[] = [];
      for (const m of n.media.edges) {
        const node = m.node;
        if (node?.id && node?.image?.url) {
          media.push({ mediaGid: node.id, url: node.image.url, altText: node.image.altText ?? null });
        }
      }
      if (!media.length) continue;

      const labels = (mf: any): string[] =>
        (mf?.references?.nodes ?? []).map((x: any) => x?.displayName).filter(Boolean);

      products.push({
        id: n.id, title: n.title, handle: n.handle, vendor: n.vendor,
        descriptionHtml: n.descriptionHtml ?? undefined,
        collection: collMf,
        colorLabels: labels(n.colorMf),
        finishLabels: labels(n.finishMf),
        typeLabels: labels(n.typeMf),
        media,
      });
    }
    if (!res.data.products.pageInfo.hasNextPage) break;
    cursor = res.data.products.pageInfo.endCursor;
  }
  return products;
}

// ---------------------------------------------------------------------------
// Vision (Sharp + closeup, exact same path as index-brand.ts)
// ---------------------------------------------------------------------------

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function analyzeOne(url: string, productName: string, brand: string, vendorHint: string) {
  const raw = await downloadImage(url);
  const rotated = sharp(raw, { failOn: "none" }).rotate();
  const full = await rotated.clone().resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  const crop = await rotated.clone().resize({ width: 800, height: 800, fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 92 }).toBuffer();
  return analyzeImageClaude(
    full.toString("base64"), "image/jpeg",
    { productName, brand, vendorHint },
    "claude-sonnet-4-6",
    { base64: crop.toString("base64"), mimeType: "image/jpeg" },
  );
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function extractSwatcherHandle(altText: string | null): string | undefined {
  if (!altText) return undefined;
  const m = altText.match(/swatched by @([\w_]+)/i);
  return m?.[1];
}

// ---------------------------------------------------------------------------
// Gap detection (token decomposition + persistent accumulation)
// ---------------------------------------------------------------------------

function normHandle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Known taxonomy words — used as a priority classifier so a token always
// lands in the right bucket regardless of which vision phrase mentioned it.
const KNOWN_FINISH_WORDS = new Set([
  "iridescent", "ultrachrome", "photochromic", "thermal", "magnetic",
  "holographic", "multichrome", "duochrome", "shimmer", "glitter", "metallic",
  "matte", "glossy", "opaque", "creme", "jelly", "crelly", "flakies", "flakes",
  "shards", "aurora", "solar", "uv-reactive", "uv", "gitd", "topper", "crackle",
  "sheer", "ucc",  // ucc = ultrachrome
  "reflective", "linear",
]);
const KNOWN_COLOR_WORDS = new Set([
  "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "black",
  "white", "grey", "gray", "tan", "beige", "gold", "silver", "copper", "bronze",
  "rose", "plum", "lavender", "lilac", "periwinkle", "navy", "teal", "turquoise",
  "aqua", "coral", "peach", "burgundy", "magenta", "fuchsia", "mint", "sage",
  "olive", "charcoal", "ivory", "cream", "indigo", "violet", "golden", "amber",
  "champagne", "maroon", "rust", "ochre",
]);

// Pure adjectives / modifiers — strip out before token matching
const MODIFIER_WORDS = new Set([
  // brightness / saturation
  "light", "dark", "deep", "vivid", "bright", "soft", "pale", "pastel",
  "rich", "warm", "cool", "muted", "neon", "deeper", "lighter", "darker",
  "subtle", "intense", "strong", "weak", "mid", "near",
  // size / density
  "scattered", "dense", "sparse", "fine", "large", "small", "tiny", "big",
  "chunky", "micro", "macro", "density", "coverage", "sparse", "spread",
  // texture / surface
  "matte", "glossy", "milky", "creamy", "opaque", "sheer", "translucent",
  "smooth", "thick", "thin", "glassy", "glossier", "high-shine", "high-gloss",
  "topcoat", "sheen", "shine", "high", "low",
  // behavior / motion
  "shifting", "shift", "reactive", "activated", "discrete", "uniform",
  "leaning", "visible",
  // unit / context modifiers vision likes
  "state", "indoor", "outdoor", "medium", "hot", "baby", "lime", "ice",
  "icy", "sunlight", "semi", "across", "change", "changing", "irregular",
  "denser", "tinge", "tinged", "leaning", "verging", "approaching",
  "blue-activated", "uv-activated",
  // anatomy / framing / non-content nouns vision uses descriptively
  "highlight", "highlights", "flash", "flashes", "shadow", "shadows",
  "edges", "edge", "areas", "area", "undertone", "undertones", "bottle",
  "bottles", "nail", "nails", "hand", "hands", "skin", "finger", "fingers",
  "label", "labels", "logo", "background", "ring", "rings",
  // connector words
  "with", "of", "and", "or", "to", "in", "on", "the", "a", "an", "by",
  "like", "as", "into", "for", "from", "than",
  // generic polish terms (already implicit)
  "base", "finish", "polish", "particle", "particles", "shimmer", "shimmery",
  "look", "effect", "texture", "tone", "color", "colour", "colors", "colours",
  "shade", "shades", "swatch", "swatches", "swatched", "sparkle", "sparkly",
  "scatter", "pattern",
  // "cat eye" tokenizes to noise individually (effect is magnetic)
  "cat", "eye",
]);
const STRIP_PAREN_RX = /[()[\]{}]/g;

// Singular/plural + spelling fuzzy match
function tokenAlternates(t: string): string[] {
  const base = t.toLowerCase().replace(STRIP_PAREN_RX, "").trim();
  if (!base) return [];
  const alts = new Set<string>([base]);
  if (base.endsWith("ies")) alts.add(base.slice(0, -3) + "y");        // flakies → flaky? we want "flakies" mapped to "flakies"
  if (base.endsWith("ies")) alts.add(base.slice(0, -3) + "ie");       // flakies → flakie
  if (base.endsWith("ie")) alts.add(base + "s");                       // flakie → flakies
  if (base.endsWith("e")) alts.add(base + "s");                        // flake → flakes
  if (base.endsWith("s")) alts.add(base.slice(0, -1));                 // flakes → flake
  if (base === "flakes") alts.add("flakies");
  if (base === "flake") alts.add("flakie");
  if (base === "colour") alts.add("color");
  if (base === "colour-shifting" || base === "color-shifting") alts.add("multichrome");
  return [...alts];
}

function tokenize(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(STRIP_PAREN_RX, " ")
    .split(/[\s/,_-]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !MODIFIER_WORDS.has(t));
}

interface MetaobjectIndex {
  byHandle: Map<string, { gid: string; displayName: string; type: "color" | "finish" | "polishType" }>;
}

function buildMetaobjectIndex(catalog: { colors: Metaobject[]; finishes: Metaobject[]; polishTypes: Metaobject[] }): MetaobjectIndex {
  const byHandle = new Map<string, { gid: string; displayName: string; type: "color" | "finish" | "polishType" }>();
  const add = (list: Metaobject[], type: "color" | "finish" | "polishType") => {
    for (const m of list) {
      const handles = new Set<string>([normHandle(m.handle), normHandle(m.displayName)]);
      for (const h of handles) {
        if (h) byHandle.set(h, { gid: m.id, displayName: m.displayName, type });
      }
      // Also index simple alternates of the displayName
      for (const alt of tokenAlternates(m.displayName)) byHandle.set(normHandle(alt), { gid: m.id, displayName: m.displayName, type });
    }
  };
  add(catalog.colors, "color");
  add(catalog.finishes, "finish");
  add(catalog.polishTypes, "polishType");
  return { byHandle };
}

interface GapRecord { count: number; products: Array<{ id: string; title: string }>; }
interface ProductMissingRef {
  id: string; title: string; detected: string;
  recommendedRefs: Array<{ type: "finish" | "polishType" | "color"; displayName: string; gid: string }>;
}

interface GapReport {
  // Tokens we couldn't map to any existing metaobject
  candidateNewColors: Record<string, GapRecord>;
  candidateNewFinishes: Record<string, GapRecord>;   // covers both cosmetic-finish + polish-type space
  // Products that should have a metafield ref but don't
  productsMissingColorRef: Record<string, ProductMissingRef>;     // keyed by product id
  productsMissingFinishRef: Record<string, ProductMissingRef>;
  lastUpdated: string;
  vendorsProcessed: string[];
}

function emptyGapReport(): GapReport {
  return {
    candidateNewColors: {}, candidateNewFinishes: {},
    productsMissingColorRef: {}, productsMissingFinishRef: {},
    lastUpdated: "", vendorsProcessed: [],
  };
}

const GAP_FILE = resolve(import.meta.dirname ?? ".", "../output/alt-pipeline-gaps.json");

async function loadGapReport(): Promise<GapReport> {
  if (!existsSync(GAP_FILE)) return emptyGapReport();
  try {
    const raw = await readFile(GAP_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GapReport>;
    return { ...emptyGapReport(), ...parsed };
  } catch {
    return emptyGapReport();
  }
}

async function saveGapReport(g: GapReport): Promise<void> {
  await mkdir(dirname(GAP_FILE), { recursive: true });
  await writeFile(GAP_FILE, JSON.stringify(g, null, 2));
}

function bumpRecord(rec: Record<string, GapRecord>, key: string, product: Product) {
  const r = rec[key] ?? { count: 0, products: [] };
  r.count += 1;
  if (!r.products.some(p => p.id === product.id)) {
    r.products.push({ id: product.id, title: product.title });
  }
  rec[key] = r;
}

function checkGaps(
  product: Product,
  vision: Array<{ dominantColors: Array<{ hex?: string; label: string }>; observedEffects: string[] }>,
  catalog: { colors: Metaobject[]; finishes: Metaobject[]; polishTypes: Metaobject[] },
  metaIdx: MetaobjectIndex,
  report: GapReport,
): void {
  // Aggregate this product's vision votes
  const colorPhrases = new Map<string, number>();
  const effectPhrases = new Map<string, number>();
  for (const v of vision) {
    for (const dc of v.dominantColors ?? []) {
      const label = dc.label?.toLowerCase().trim();
      if (label) colorPhrases.set(label, (colorPhrases.get(label) ?? 0) + 1);
    }
    for (const eff of v.observedEffects ?? []) {
      const e = eff.toLowerCase().trim();
      if (e) effectPhrases.set(e, (effectPhrases.get(e) ?? 0) + 1);
    }
  }

  // Helper: lookup any type, prefer exact handle hit
  const lookupAny = (tok: string) => {
    for (const alt of tokenAlternates(tok)) {
      const h = metaIdx.byHandle.get(normHandle(alt));
      if (h) return h;
    }
    return null;
  };
  // Classify an unmatched token by known-word priors so it lands in the
  // right bucket regardless of source phrase.
  const classifyUnmatched = (tok: string): "color" | "finish" | "noise" => {
    const t = tok.toLowerCase();
    if (KNOWN_COLOR_WORDS.has(t)) return "color";
    if (KNOWN_FINISH_WORDS.has(t)) return "finish";
    return "noise";
  };

  // ---- Colors ----
  const productHasColor = product.colorLabels.length > 0;
  const matchedColorRefs = new Map<string, { gid: string; displayName: string }>();
  const newColorTokens = new Set<string>();
  const newFinishTokensFromColorPhrases = new Set<string>();
  for (const phrase of colorPhrases.keys()) {
    for (const tok of tokenize(phrase)) {
      const hit = lookupAny(tok);
      if (hit) {
        if (hit.type === "color") matchedColorRefs.set(hit.gid, { gid: hit.gid, displayName: hit.displayName });
        continue;
      }
      const cls = classifyUnmatched(tok);
      if (cls === "color") newColorTokens.add(tok);
      else if (cls === "finish") newFinishTokensFromColorPhrases.add(tok);
      // noise: silently dropped
    }
  }
  // Persisting candidate-new colors
  for (const t of newColorTokens) bumpRecord(report.candidateNewColors, t, product);
  // Product missing color metafield but vision saw colors that exist in catalog
  if (!productHasColor && matchedColorRefs.size > 0) {
    const detected = [...new Set([...colorPhrases.keys()])].slice(0, 3).join(", ");
    report.productsMissingColorRef[product.id] = {
      id: product.id, title: product.title, detected,
      recommendedRefs: [...matchedColorRefs.values()].map(r => ({ type: "color" as const, displayName: r.displayName, gid: r.gid })),
    };
  }

  // ---- Finishes / polish-types ----
  const productHasFinish = product.finishLabels.length > 0 || product.typeLabels.length > 0;
  const matchedFinishRefs = new Map<string, { gid: string; displayName: string; type: "finish" | "polishType" }>();
  const newFinishTokens = new Set<string>([...newFinishTokensFromColorPhrases]);
  const newColorTokensFromEffectPhrases = new Set<string>();
  for (const phrase of effectPhrases.keys()) {
    for (const tok of tokenize(phrase)) {
      const hit = lookupAny(tok);
      if (hit) {
        if (hit.type === "finish" || hit.type === "polishType") {
          matchedFinishRefs.set(hit.gid, { gid: hit.gid, displayName: hit.displayName, type: hit.type });
        }
        continue;
      }
      const cls = classifyUnmatched(tok);
      if (cls === "finish") newFinishTokens.add(tok);
      else if (cls === "color") newColorTokensFromEffectPhrases.add(tok);
      // noise: silently dropped
    }
  }
  for (const t of newFinishTokens) bumpRecord(report.candidateNewFinishes, t, product);
  for (const t of newColorTokensFromEffectPhrases) bumpRecord(report.candidateNewColors, t, product);
  if (!productHasFinish && matchedFinishRefs.size > 0) {
    const detected = [...new Set([...effectPhrases.keys()])].slice(0, 3).join(", ");
    report.productsMissingFinishRef[product.id] = {
      id: product.id, title: product.title, detected,
      recommendedRefs: [...matchedFinishRefs.values()].map(r => ({ type: r.type, displayName: r.displayName, gid: r.gid })),
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { vendor, collection, shop, limit, concurrency, dryRunPush, verbose } = args;

  console.log(`\n=== Alt-text pipeline: ${vendor}${collection ? ` / ${collection}` : ""} ===`);
  if (shop) console.log(`Shop: ${shop}`);
  console.log(`Concurrency: ${concurrency} | dry-run push: ${dryRunPush}`);

  const supabase = getSupabase();

  // Preflight: existing metaobjects
  console.log(`Loading metaobject catalogs...`);
  const [colors, finishes, polishTypes] = await Promise.all([
    listMetaobjects("shopify--color-pattern", shop),
    listMetaobjects("shopify--cosmetic-finish", shop),
    listMetaobjects("nailstuff_polish_type", shop),
  ]);
  console.log(`  colors=${colors.length} finishes=${finishes.length} polishTypes=${polishTypes.length}`);

  // Products
  console.log(`Loading products...`);
  let products = await listProducts(vendor, collection, shop, args.productType);
  console.log(`Found ${products.length} product(s) with media.`);
  if (limit) products = products.slice(0, limit);
  if (!products.length) { console.log("Nothing to process."); return; }

  const totalImages = products.reduce((s, p) => s + p.media.length, 0);
  console.log(`Total images: ${totalImages} (~$${(totalImages * 0.02).toFixed(2)} on Sonnet)\n`);

  const gapReport = await loadGapReport();
  const metaIdx = buildMetaobjectIndex({ colors, finishes, polishTypes });
  let totalIndexed = 0, totalPushed = 0, totalErrors = 0;
  const visionVendorHint = (p: Product) => p.descriptionHtml ? stripHtml(p.descriptionHtml).slice(0, 500) : "";

  // Preflight: which shades are already fully indexed?
  // Skip vision entirely for any shade where image_signatures count
  // matches the product's current media count (resume + idempotent re-runs).
  console.log(`Checking resume state...`);
  const { data: existingShades } = await supabase
    .from("shade_signatures")
    .select("id, shade_name, photo_count")
    .eq("brand", vendor);
  const indexedByName = new Map<string, { id: number; photoCount: number }>();
  for (const s of existingShades ?? []) {
    indexedByName.set((s as any).shade_name as string, {
      id: (s as any).id as number,
      photoCount: ((s as any).photo_count as number) ?? 0,
    });
  }
  let resumedCount = 0;

  for (let pi = 0; pi < products.length; pi++) {
    const p = products[pi];
    const prior = indexedByName.get(p.title);
    const fullyIndexed = prior && prior.photoCount === p.media.length;
    console.log(`[${pi + 1}/${products.length}] ${p.title}  (${p.media.length} images)${fullyIndexed ? "  ⤴ already indexed, skipping vision" : ""}`);

    const color = composeColor(p.colorLabels);
    const finish = composeFinish(p.finishLabels, p.typeLabels);
    if (verbose) console.log(`  canonical: color="${color}" finish="${finish}"`);

    if (!color) {
      console.log(`  ⚠ missing color-pattern metafield — flagged in gap report`);
    }

    // 1. Upsert shade row
    const { data: shadeRow, error: shadeErr } = await supabase
      .from("shade_signatures")
      .upsert({
        brand: p.vendor, shade_name: p.title,
        collection: p.collection ?? null,
        shopify_product_id: p.id, shopify_handle: p.handle,
      }, { onConflict: "brand,shade_name" })
      .select("id").single();
    if (shadeErr || !shadeRow) {
      console.log(`  ✗ shade upsert: ${shadeErr?.message ?? "unknown"}`);
      totalErrors++; continue;
    }
    const shadeId = shadeRow.id as number;

    // RESUME PATH: shade already fully indexed. Compose + push only.
    if (fullyIndexed) {
      resumedCount++;
      const { data: cachedImgs } = await supabase
        .from("image_signatures")
        .select("source_path, image_type, lighting_condition, skin_tone, nail_count, dominant_colors, observed_effects, alt_text")
        .eq("shade_id", shadeId);
      // Map media to cached vision by url-without-query
      const mediaByUrl = new Map<string, ProductMedia>();
      for (const m of p.media) mediaByUrl.set(m.url.split("?")[0], m);
      const matched: Array<{ media: ProductMedia; analysis: any }> = [];
      for (const row of cachedImgs ?? []) {
        const key = ((row as any).source_path as string).split("?")[0];
        const m = mediaByUrl.get(key);
        if (!m) continue;
        matched.push({
          media: m,
          analysis: {
            imageType: (row as any).image_type ?? null,
            skinTone: (row as any).skin_tone ?? null,
            nailCount: (row as any).nail_count ?? null,
            lightingCondition: (row as any).lighting_condition ?? null,
            dominantColors: (row as any).dominant_colors ?? [],
            observedEffects: (row as any).observed_effects ?? [],
            altText: (row as any).alt_text ?? undefined,
          },
        });
      }
      let fileUpdates: Array<{ id: string; alt: string }> = [];
      try {
        const composerInput = {
          shade: p.title, brand: p.vendor,
          canonicalColor: color, canonicalFinish: finish,
          polishTypes: p.typeLabels,
          descriptionExcerpt: p.descriptionHtml ? stripHtml(p.descriptionHtml).slice(0, 800) : undefined,
          images: matched.map(({ analysis }, idx): ImageInput => ({
            idx,
            imageType: analysis.imageType,
            skinTone: analysis.skinTone,
            nailCount: analysis.nailCount,
            lightingCondition: analysis.lightingCondition,
            dominantColors: analysis.dominantColors,
            observedEffects: analysis.observedEffects,
            visionAltText: analysis.altText,
          })),
        };
        const composed = await composeAltsForShade(composerInput);
        const altByIdx = new Map(composed.map(c => [c.idx, c.alt]));
        fileUpdates = matched.map(({ media }, idx) => ({
          id: media.mediaGid,
          alt: altByIdx.get(idx) ?? "",
        })).filter(f => f.alt);
      } catch (err) {
        console.log(`  ! compose failed: ${err}`);
      }
      if (color && fileUpdates.length && !dryRunPush) {
        const res = await shopifyGraphQL<any>(FILE_UPDATE, { files: fileUpdates }, shop);
        throwIfUserErrors(res.data?.fileUpdate?.userErrors, "fileUpdate");
        totalPushed += fileUpdates.length;
      } else if (dryRunPush && verbose) {
        for (const f of fileUpdates) console.log(`    [dry] ${f.alt}`);
      }
      console.log(`  ✓ skipped vision, pushed ${color ? fileUpdates.length : 0}`);
      continue;
    }

    // 2. Vision concurrently (Sharp+closeup, exact MCP algo)
    const visionResults = await mapConcurrent(p.media, concurrency, async (m) => {
      try {
        const a = await analyzeOne(m.url, p.title, p.vendor, visionVendorHint(p));
        return { ok: true as const, media: m, analysis: a };
      } catch (err) {
        return { ok: false as const, media: m, error: String(err) };
      }
    });

    const okAnalyses: Array<{ media: ProductMedia; analysis: any }> = [];
    for (const r of visionResults) {
      if (!r.ok) { totalErrors++; console.log(`  ✗ vision ${r.media.url.split("/").pop()?.split("?")[0]}: ${r.error.slice(0, 80)}`); continue; }
      okAnalyses.push({ media: r.media, analysis: r.analysis });
    }

    // 3. Indexing: insert image_signatures (exact same fields as index-brand.ts)
    for (const { media, analysis } of okAnalyses) {
      const features = extractAndEmbed({
        dominantColors: analysis.dominantColors,
        observedEffects: analysis.observedEffects,
        altText: analysis.altText,
      });
      const swatcher = extractSwatcherHandle(media.altText);
      const { error: insErr } = await supabase.from("image_signatures").insert({
        shade_id: shadeId,
        source_path: media.url,
        swatcher_handle: swatcher,
        image_type: analysis.imageType,
        lighting_condition: analysis.lightingCondition ?? null,
        skin_tone: analysis.skinTone ?? null,
        nail_count: analysis.nailCount ?? null,
        dominant_colors: analysis.dominantColors,
        observed_effects: analysis.observedEffects,
        alt_text: analysis.altText,
        confidence: analysis.confidence,
        vision_provider: "claude",
        vision_model: "claude-sonnet-4-6",
        base_color_hex: features.baseColorHex ?? null,
        base_color_lab: features.baseColorLab,
        embedding: features.embedding,
      });
      if (insErr) { totalErrors++; console.log(`  ✗ db insert: ${insErr.message.slice(0, 80)}`); continue; }
      totalIndexed++;
    }

    // 4. Gap detection (vision vs catalog) — accumulates into gapReport
    checkGaps(p, okAnalyses.map(x => x.analysis), { colors, finishes, polishTypes }, metaIdx, gapReport);

    // 5. Compose alts via LLM (per-shade Sonnet call, vendor-canonical spine
    //    plus per-image specifics drawn from vision). Cached per shade.
    let fileUpdates: Array<{ id: string; alt: string }> = [];
    try {
      const composerInput = {
        shade: p.title, brand: p.vendor,
        canonicalColor: color, canonicalFinish: finish,
        polishTypes: p.typeLabels,
        descriptionExcerpt: p.descriptionHtml ? stripHtml(p.descriptionHtml).slice(0, 800) : undefined,
        images: okAnalyses.map(({ media, analysis }, idx): ImageInput => ({
          idx,
          imageType: analysis.imageType ?? null,
          skinTone: analysis.skinTone ?? null,
          nailCount: analysis.nailCount ?? null,
          lightingCondition: analysis.lightingCondition ?? null,
          dominantColors: analysis.dominantColors ?? [],
          observedEffects: analysis.observedEffects ?? [],
          visionAltText: analysis.altText,
        })),
      };
      const composed = await composeAltsForShade(composerInput);
      const altByIdx = new Map(composed.map(c => [c.idx, c.alt]));
      fileUpdates = okAnalyses.map(({ media }, idx) => ({
        id: media.mediaGid,
        alt: altByIdx.get(idx) ?? "",
      })).filter(f => f.alt);
    } catch (err) {
      console.log(`  ! compose failed: ${err}`);
    }

    if (dryRunPush) {
      if (verbose) for (const f of fileUpdates) console.log(`    [dry] ${f.alt}`);
    } else if (fileUpdates.length) {
      const res = await shopifyGraphQL<any>(FILE_UPDATE, { files: fileUpdates }, shop);
      throwIfUserErrors(res.data?.fileUpdate?.userErrors, "fileUpdate");
      totalPushed += fileUpdates.length;
    }

    // 6. Recompute shade aggregate
    try {
      await recomputeShadeAggregate(shadeId);
    } catch (err) {
      console.log(`  ! recompute failed: ${err}`);
    }

    console.log(`  ✓ indexed ${okAnalyses.length}/${p.media.length}, pushed ${color ? okAnalyses.length : 0}`);
  }

  console.log(`\n=== Done ===`);
  console.log(`Shades:    ${products.length}`);
  console.log(`Resumed:   ${resumedCount}  (skipped vision, already indexed)`);
  console.log(`Indexed:   ${totalIndexed}`);
  console.log(`Pushed:    ${totalPushed}${dryRunPush ? " (dry-run)" : ""}`);
  console.log(`Errors:    ${totalErrors}`);

  // Persist + print gap report
  gapReport.lastUpdated = new Date().toISOString();
  if (!gapReport.vendorsProcessed.includes(vendor)) gapReport.vendorsProcessed.push(vendor);
  await saveGapReport(gapReport);

  const newColors = Object.entries(gapReport.candidateNewColors).sort((a, b) => b[1].count - a[1].count);
  const newFinishes = Object.entries(gapReport.candidateNewFinishes).sort((a, b) => b[1].count - a[1].count);
  const missingColorRefs = Object.values(gapReport.productsMissingColorRef);
  const missingFinishRefs = Object.values(gapReport.productsMissingFinishRef);

  console.log(`\n=== Gap report (accumulated across all runs in ${GAP_FILE}) ===`);
  if (newColors.length) {
    console.log(`\nCandidate NEW color metaobjects (not decomposable into existing):`);
    for (const [tok, r] of newColors.slice(0, 25)) {
      const ex = r.products.slice(0, 3).map(p => p.title).join(", ");
      console.log(`  ${String(r.count).padStart(3)}x  ${tok.padEnd(20)}  e.g. ${ex}`);
    }
  }
  if (newFinishes.length) {
    console.log(`\nCandidate NEW finish/polish-type metaobjects (not decomposable):`);
    for (const [tok, r] of newFinishes.slice(0, 25)) {
      const ex = r.products.slice(0, 3).map(p => p.title).join(", ");
      console.log(`  ${String(r.count).padStart(3)}x  ${tok.padEnd(20)}  e.g. ${ex}`);
    }
  }
  if (missingColorRefs.length) {
    console.log(`\nProducts with no color-pattern ref (recommend assigning existing metaobjects):`);
    for (const m of missingColorRefs.slice(0, 20)) {
      const refs = m.recommendedRefs.map(r => r.displayName).join(", ");
      console.log(`  ${m.title.padEnd(40)}  → ${refs}`);
    }
    if (missingColorRefs.length > 20) console.log(`  ... and ${missingColorRefs.length - 20} more`);
  }
  if (missingFinishRefs.length) {
    console.log(`\nProducts with no cosmetic-finish or polish-type ref (recommend assigning):`);
    for (const m of missingFinishRefs.slice(0, 20)) {
      const refs = m.recommendedRefs.map(r => `${r.displayName}[${r.type}]`).join(", ");
      console.log(`  ${m.title.padEnd(40)}  → ${refs}`);
    }
    if (missingFinishRefs.length > 20) console.log(`  ... and ${missingFinishRefs.length - 20} more`);
  }
  if (!newColors.length && !newFinishes.length && !missingColorRefs.length && !missingFinishRefs.length) {
    console.log(`\nNo gaps detected.`);
  }
  console.log(`\n(report only — never auto-creates metaobjects or assigns refs.)`);
}

main().catch(err => { console.error("\nFatal:", err); process.exit(1); });
