#!/usr/bin/env tsx
/**
 * Rebuild the alt-pipeline gap report from existing image_signatures.
 * No vision spend — just reads observed_effects + dominant_colors from
 * Supabase and re-runs the (now-tightened) gap detection.
 *
 * Usage:
 *   tsx scripts/rebuild-gaps.ts             # all indexed vendors
 *   tsx scripts/rebuild-gaps.ts "Chamaeleon Nails" "Danglefoot Nail Polish"
 */
import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { shopifyGraphQL } from "../src/shopify/client.js";
import { getSupabase } from "../src/supabase/client.js";

// ---- Inline copy of gap detection from alt-text-pipeline.ts ---------------
// Kept in sync manually with that file. The two share the same shape so
// the persisted file stays compatible.

const KNOWN_FINISH_WORDS = new Set([
  "iridescent","ultrachrome","photochromic","thermal","magnetic","holographic","multichrome","duochrome","shimmer","glitter","metallic","matte","glossy","opaque","creme","jelly","crelly","flakies","flakes","shards","aurora","solar","uv-reactive","uv","gitd","topper","crackle","sheer","ucc","reflective","linear",
]);
const KNOWN_COLOR_WORDS = new Set([
  "red","orange","yellow","green","blue","purple","pink","brown","black","white","grey","gray","tan","beige","gold","silver","copper","bronze","rose","plum","lavender","lilac","periwinkle","navy","teal","turquoise","aqua","coral","peach","burgundy","magenta","fuchsia","mint","sage","olive","charcoal","ivory","cream","indigo","violet","golden","amber","champagne","maroon","rust","ochre",
]);

const MODIFIER_WORDS = new Set([
  "light","dark","deep","vivid","bright","soft","pale","pastel","rich","warm","cool","muted","neon","deeper","lighter","darker","subtle","intense","strong","weak","mid","near",
  "scattered","dense","sparse","fine","large","small","tiny","big","chunky","micro","macro","density","coverage","spread",
  "matte","glossy","milky","creamy","opaque","sheer","translucent","smooth","thick","thin","glassy","glossier","high-shine","high-gloss","topcoat","sheen","shine","high","low",
  "shifting","shift","reactive","activated","discrete","uniform","leaning","visible",
  "state","indoor","outdoor","medium","hot","baby","lime","ice","icy","sunlight","semi","across","change","changing","irregular","denser","tinge","tinged","verging","approaching","blue-activated","uv-activated",
  "highlight","highlights","flash","flashes","shadow","shadows","edges","edge","areas","area","undertone","undertones","bottle","bottles","nail","nails","hand","hands","skin","finger","fingers","label","labels","logo","background","ring","rings",
  "with","of","and","or","to","in","on","the","a","an","by","like","as","into","for","from","than",
  "base","finish","polish","particle","particles","shimmer","shimmery","look","effect","texture","tone","color","colour","colors","colours","shade","shades","swatch","swatches","swatched","sparkle","sparkly","scatter","pattern",
  "cat","eye",
]);

function classifyUnmatched(tok: string): "color" | "finish" | "noise" {
  const t = tok.toLowerCase();
  if (KNOWN_COLOR_WORDS.has(t)) return "color";
  if (KNOWN_FINISH_WORDS.has(t)) return "finish";
  return "noise";
}

const STRIP_PAREN_RX = /[()[\]{}]/g;

function normHandle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function tokenAlternates(t: string): string[] {
  const base = t.toLowerCase().replace(STRIP_PAREN_RX, "").trim();
  if (!base) return [];
  const alts = new Set<string>([base]);
  if (base.endsWith("ies")) alts.add(base.slice(0, -3) + "y");
  if (base.endsWith("ies")) alts.add(base.slice(0, -3) + "ie");
  if (base.endsWith("ie")) alts.add(base + "s");
  if (base.endsWith("e")) alts.add(base + "s");
  if (base.endsWith("s")) alts.add(base.slice(0, -1));
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

interface Metaobject { id: string; handle: string; displayName: string; }
interface MetaobjectIndex { byHandle: Map<string, { gid: string; displayName: string; type: "color" | "finish" | "polishType" }>; }

function buildIdx(catalog: { colors: Metaobject[]; finishes: Metaobject[]; polishTypes: Metaobject[] }): MetaobjectIndex {
  const byHandle = new Map<string, { gid: string; displayName: string; type: "color" | "finish" | "polishType" }>();
  const add = (list: Metaobject[], type: "color" | "finish" | "polishType") => {
    for (const m of list) {
      const handles = new Set<string>([normHandle(m.handle), normHandle(m.displayName)]);
      for (const h of handles) if (h) byHandle.set(h, { gid: m.id, displayName: m.displayName, type });
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
  candidateNewColors: Record<string, GapRecord>;
  candidateNewFinishes: Record<string, GapRecord>;
  productsMissingColorRef: Record<string, ProductMissingRef>;
  productsMissingFinishRef: Record<string, ProductMissingRef>;
  lastUpdated: string;
  vendorsProcessed: string[];
}

function emptyGapReport(): GapReport {
  return { candidateNewColors:{}, candidateNewFinishes:{}, productsMissingColorRef:{}, productsMissingFinishRef:{}, lastUpdated:"", vendorsProcessed:[] };
}

function bumpRecord(rec: Record<string, GapRecord>, key: string, product: { id: string; title: string }) {
  const r = rec[key] ?? { count: 0, products: [] };
  r.count += 1;
  if (!r.products.some(p => p.id === product.id)) r.products.push({ id: product.id, title: product.title });
  rec[key] = r;
}

const METAOBJECTS_QUERY = `query Metaobjects($type: String!){ metaobjects(type:$type, first:250){ edges{ node{ id handle displayName } } } }`;
async function listMetaobjects(type: string, shop?: string): Promise<Metaobject[]> {
  const res = await shopifyGraphQL<{ metaobjects: { edges: Array<{ node: Metaobject }> } }>(METAOBJECTS_QUERY, { type }, shop);
  return res.data?.metaobjects.edges.map(e => e.node) ?? [];
}

// Fetch product metafield refs for productsMissing* discrimination
const PRODUCT_REFS_QUERY = `
  query($id: ID!) {
    product(id: $id) {
      colorMf: metafield(namespace:"shopify", key:"color-pattern") { references(first:8){ nodes{ ... on Metaobject { displayName } } } }
      finishMf: metafield(namespace:"shopify", key:"cosmetic-finish") { references(first:8){ nodes{ ... on Metaobject { displayName } } } }
      typeMf: metafield(namespace:"custom", key:"nailstuff_polish_type") { references(first:8){ nodes{ ... on Metaobject { displayName } } } }
    }
  }
`;

interface ProductRefs { colors: string[]; finishes: string[]; types: string[]; }
async function fetchProductRefs(productGid: string, shop?: string): Promise<ProductRefs> {
  const res = await shopifyGraphQL<any>(PRODUCT_REFS_QUERY, { id: productGid }, shop);
  const p = res.data?.product ?? {};
  const labels = (mf: any) => (mf?.references?.nodes ?? []).map((n: any) => n?.displayName).filter(Boolean);
  return { colors: labels(p.colorMf), finishes: labels(p.finishMf), types: labels(p.typeMf) };
}

// ---------------------------------------------------------------------------

async function main() {
  const argVendors = process.argv.slice(2);
  const shop = process.env.SHOP_DOMAIN ?? undefined;
  const sb = getSupabase();

  // Build metaobject index from Shopify
  console.log("Loading metaobject catalogs...");
  const [colors, finishes, polishTypes] = await Promise.all([
    listMetaobjects("shopify--color-pattern", shop),
    listMetaobjects("shopify--cosmetic-finish", shop),
    listMetaobjects("nailstuff_polish_type", shop),
  ]);
  console.log(`  colors=${colors.length} finishes=${finishes.length} polishTypes=${polishTypes.length}`);
  const idx = buildIdx({ colors, finishes, polishTypes });

  // Fetch shades scoped to vendors (or all)
  let q = sb.from("shade_signatures").select("id, brand, shade_name, shopify_product_id");
  if (argVendors.length) q = q.in("brand", argVendors);
  const { data: shades, error: shErr } = await q;
  if (shErr) { console.error(shErr); process.exit(1); }
  if (!shades?.length) { console.log("No shades found."); return; }
  console.log(`Rebuilding gaps from ${shades.length} shades...`);

  const report = emptyGapReport();
  const vendorsSet = new Set<string>();
  const productRefCache = new Map<string, ProductRefs>();

  for (const s of shades) {
    vendorsSet.add(s.brand);
    const { data: imgs } = await sb.from("image_signatures").select("dominant_colors, observed_effects").eq("shade_id", s.id);
    if (!imgs?.length) continue;

    const product = { id: s.shopify_product_id ?? `supabase:${s.id}`, title: s.shade_name };

    // Resolve product's existing refs once
    let refs: ProductRefs = { colors: [], finishes: [], types: [] };
    if (s.shopify_product_id) {
      if (productRefCache.has(s.shopify_product_id)) {
        refs = productRefCache.get(s.shopify_product_id)!;
      } else {
        try {
          refs = await fetchProductRefs(s.shopify_product_id, shop);
        } catch { /* ignore */ }
        productRefCache.set(s.shopify_product_id, refs);
      }
    }

    // Aggregate vision votes for this product
    const colorPhrases = new Set<string>();
    const effectPhrases = new Set<string>();
    for (const img of imgs) {
      for (const dc of (img.dominant_colors ?? []) as Array<{ label?: string }>) {
        const label = dc?.label?.toLowerCase().trim();
        if (label) colorPhrases.add(label);
      }
      for (const eff of (img.observed_effects ?? []) as string[]) {
        const e = (eff ?? "").toLowerCase().trim();
        if (e) effectPhrases.add(e);
      }
    }

    const lookupAny = (tok: string) => {
      for (const alt of tokenAlternates(tok)) {
        const h = idx.byHandle.get(normHandle(alt));
        if (h) return h;
      }
      return null;
    };

    // Colors
    const matchedColorRefs = new Map<string, { gid: string; displayName: string }>();
    for (const phrase of colorPhrases) {
      for (const tok of tokenize(phrase)) {
        const hit = lookupAny(tok);
        if (hit) {
          if (hit.type === "color") matchedColorRefs.set(hit.gid, { gid: hit.gid, displayName: hit.displayName });
          continue;
        }
        const cls = classifyUnmatched(tok);
        if (cls === "color") bumpRecord(report.candidateNewColors, tok, product);
        else if (cls === "finish") bumpRecord(report.candidateNewFinishes, tok, product);
      }
    }
    if (refs.colors.length === 0 && matchedColorRefs.size > 0) {
      const detected = [...colorPhrases].slice(0, 3).join(", ");
      report.productsMissingColorRef[product.id] = {
        id: product.id, title: product.title, detected,
        recommendedRefs: [...matchedColorRefs.values()].map(r => ({ type: "color" as const, displayName: r.displayName, gid: r.gid })),
      };
    }

    // Finishes
    const matchedFinishRefs = new Map<string, { gid: string; displayName: string; type: "finish" | "polishType" }>();
    for (const phrase of effectPhrases) {
      for (const tok of tokenize(phrase)) {
        const hit = lookupAny(tok);
        if (hit) {
          if (hit.type === "finish" || hit.type === "polishType") {
            matchedFinishRefs.set(hit.gid, { gid: hit.gid, displayName: hit.displayName, type: hit.type });
          }
          continue;
        }
        const cls = classifyUnmatched(tok);
        if (cls === "finish") bumpRecord(report.candidateNewFinishes, tok, product);
        else if (cls === "color") bumpRecord(report.candidateNewColors, tok, product);
      }
    }
    if (refs.finishes.length === 0 && refs.types.length === 0 && matchedFinishRefs.size > 0) {
      const detected = [...effectPhrases].slice(0, 3).join(", ");
      report.productsMissingFinishRef[product.id] = {
        id: product.id, title: product.title, detected,
        recommendedRefs: [...matchedFinishRefs.values()].map(r => ({ type: r.type, displayName: r.displayName, gid: r.gid })),
      };
    }
  }

  report.vendorsProcessed = [...vendorsSet].sort();
  report.lastUpdated = new Date().toISOString();

  const file = resolve(import.meta.dirname ?? ".", "../output/alt-pipeline-gaps.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${file}`);

  // Print top of each section
  const newColors = Object.entries(report.candidateNewColors).sort((a, b) => b[1].count - a[1].count);
  const newFinishes = Object.entries(report.candidateNewFinishes).sort((a, b) => b[1].count - a[1].count);
  console.log(`\nCandidate new colors: ${newColors.length} unique`);
  for (const [tok, r] of newColors.slice(0, 20)) console.log(`  ${String(r.count).padStart(3)}x  ${tok}`);
  console.log(`\nCandidate new finishes/types: ${newFinishes.length} unique`);
  for (const [tok, r] of newFinishes.slice(0, 20)) console.log(`  ${String(r.count).padStart(3)}x  ${tok}`);
  console.log(`\nProducts missing color ref: ${Object.keys(report.productsMissingColorRef).length}`);
  console.log(`Products missing finish ref: ${Object.keys(report.productsMissingFinishRef).length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
