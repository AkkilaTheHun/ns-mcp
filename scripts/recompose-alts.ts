#!/usr/bin/env tsx
/**
 * Recompose alt text from cached image_signatures (no new vision spend)
 * and push via Shopify fileUpdate. Drives the per-shade LLM composer.
 *
 * Usage:
 *   tsx scripts/recompose-alts.ts "Chamaeleon Nails"
 *   tsx scripts/recompose-alts.ts "Chamaeleon Nails" --shop nailstuff-ca.myshopify.com
 *   tsx scripts/recompose-alts.ts "Chamaeleon Nails" --limit 3 --dry-run-push -v
 */
import "dotenv/config";
import { shopifyGraphQL, throwIfUserErrors } from "../src/shopify/client.js";
import { getSupabase } from "../src/supabase/client.js";
import { composeAltsForShade, type ImageInput } from "../src/util/alt-composer.js";
import { stripHtml } from "../src/util/feature-extract.js";

interface Args {
  vendor: string;
  shop?: string;
  limit?: number;
  dryRunPush: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  let vendor: string | undefined, shop: string | undefined, limit: number | undefined;
  let dryRunPush = false, verbose = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shop") shop = argv[++i];
    else if (a === "--limit") limit = parseInt(argv[++i], 10);
    else if (a === "--dry-run-push") dryRunPush = true;
    else if (a === "--verbose" || a === "-v") verbose = true;
    else positional.push(a);
  }
  vendor = positional[0];
  if (!vendor) { console.error("Usage: tsx scripts/recompose-alts.ts <vendor> [--shop X] [--limit N] [--dry-run-push] [-v]"); process.exit(1); }
  return { vendor, shop, limit, dryRunPush, verbose };
}

const PRODUCT_QUERY = `
  query($id: ID!) {
    product(id: $id) {
      id title vendor descriptionHtml
      colorMf: metafield(namespace: "shopify", key: "color-pattern") {
        references(first: 8) { nodes { ... on Metaobject { displayName } } }
      }
      finishMf: metafield(namespace: "shopify", key: "cosmetic-finish") {
        references(first: 8) { nodes { ... on Metaobject { displayName } } }
      }
      typeMf: metafield(namespace: "custom", key: "nailstuff_polish_type") {
        references(first: 8) { nodes { ... on Metaobject { displayName } } }
      }
      media(first: 50) {
        edges { node { ... on MediaImage { id image { url altText } } } }
      }
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

// Canonical color/finish composers — same shapes used by alt-text-pipeline.ts
const FINISH_ORDER = [
  "Holographic", "Multichrome", "Duochrome", "Reflective", "Shimmer", "Glitter", "Metallic", "Matte", "Glossy", "Opaque", "Holo",
  "Flakies", "Flakes", "Crelly", "Jelly", "Creme",
  "Magnetic", "Thermal", "UV", "Glow in the Dark", "GITD", "Crackle", "Sheer", "Topper", "Top Coat",
];

function composeColor(labels: string[]): string {
  if (!labels.length) return "";
  const seen = new Set<string>(); const ordered: string[] = [];
  for (const l of labels) {
    const c = l.toLowerCase().includes("/") ? l.toLowerCase().split("/")[0].trim() : l.toLowerCase().trim();
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { vendor, shop, limit, dryRunPush, verbose } = args;
  const sb = getSupabase();

  console.log(`\n=== Recompose alts (LLM) for ${vendor} ===`);
  if (shop) console.log(`Shop: ${shop}`);

  const shadesQuery = sb.from("shade_signatures")
    .select("id, shade_name, shopify_product_id")
    .eq("brand", vendor)
    .order("shade_name");
  const { data: shades, error } = await shadesQuery;
  if (error) { console.error(error); process.exit(1); }
  let scoped = shades ?? [];
  if (limit) scoped = scoped.slice(0, limit);
  console.log(`Shades to recompose: ${scoped.length}`);

  let totalPushed = 0, totalSkipped = 0, totalErrors = 0;

  for (let i = 0; i < scoped.length; i++) {
    const s = scoped[i];
    if (!s.shopify_product_id) { totalSkipped++; continue; }

    // Pull product + media + metafields
    const prodRes = await shopifyGraphQL<any>(PRODUCT_QUERY, { id: s.shopify_product_id }, shop);
    const p = prodRes.data?.product;
    if (!p) { console.log(`[${i+1}/${scoped.length}] ${s.shade_name}: product not found`); totalErrors++; continue; }

    const colorLabels = (p.colorMf?.references?.nodes ?? []).map((x: any) => x?.displayName).filter(Boolean);
    const finishLabels = (p.finishMf?.references?.nodes ?? []).map((x: any) => x?.displayName).filter(Boolean);
    const typeLabels = (p.typeMf?.references?.nodes ?? []).map((x: any) => x?.displayName).filter(Boolean);

    const canonicalColor = composeColor(colorLabels);
    const canonicalFinish = composeFinish(finishLabels, typeLabels);

    // Index media by URL (stripped of query string) so we can match image_signatures
    const mediaByUrl = new Map<string, { mediaGid: string }>();
    for (const e of p.media?.edges ?? []) {
      const n = e.node;
      if (n?.id && n?.image?.url) mediaByUrl.set(n.image.url.split("?")[0], { mediaGid: n.id });
    }

    // Pull image_signatures rows
    const { data: imgs } = await sb.from("image_signatures").select("source_path, image_type, lighting_condition, skin_tone, nail_count, dominant_colors, observed_effects, alt_text").eq("shade_id", s.id);
    if (!imgs?.length) { console.log(`[${i+1}/${scoped.length}] ${s.shade_name}: no cached images`); totalSkipped++; continue; }

    // Build composer input — only include images that we can match back to a MediaImage GID
    const matched: Array<{ mediaGid: string; image: ImageInput }> = [];
    imgs.forEach((row: any, idx: number) => {
      const meta = mediaByUrl.get((row.source_path ?? "").split("?")[0]);
      if (!meta) return;
      matched.push({
        mediaGid: meta.mediaGid,
        image: {
          idx,
          imageType: row.image_type ?? null,
          skinTone: row.skin_tone ?? null,
          nailCount: row.nail_count ?? null,
          lightingCondition: row.lighting_condition ?? null,
          dominantColors: (row.dominant_colors ?? []) as any,
          observedEffects: (row.observed_effects ?? []) as string[],
          visionAltText: row.alt_text ?? undefined,
        },
      });
    });
    if (!matched.length) { console.log(`[${i+1}/${scoped.length}] ${s.shade_name}: no media matched`); totalSkipped++; continue; }

    let outs;
    try {
      outs = await composeAltsForShade({
        shade: p.title, brand: p.vendor,
        canonicalColor, canonicalFinish,
        polishTypes: typeLabels,
        descriptionExcerpt: p.descriptionHtml ? stripHtml(p.descriptionHtml) : undefined,
        images: matched.map(m => m.image),
      });
    } catch (err) {
      console.log(`[${i+1}/${scoped.length}] ${s.shade_name}: compose error: ${err}`);
      totalErrors++; continue;
    }
    const altByIdx = new Map(outs.map(o => [o.idx, o.alt]));

    // Print sample for first 3 shades
    if (verbose || i < 3) {
      console.log(`\n[${i+1}/${scoped.length}] ${s.shade_name}  canonical: ${canonicalColor || "(none)"} / ${canonicalFinish}`);
      for (const m of matched.slice(0, 3)) {
        const a = altByIdx.get(m.image.idx);
        console.log(`  img ${m.image.idx} [${m.image.imageType}/${m.image.skinTone ?? "—"}]:`);
        console.log(`    ${a ?? "(missing alt)"}`);
      }
      if (matched.length > 3) console.log(`  ... ${matched.length - 3} more`);
    }

    // Push
    if (dryRunPush) { totalSkipped += matched.length; continue; }
    const files = matched
      .map(m => ({ id: m.mediaGid, alt: altByIdx.get(m.image.idx) }))
      .filter(f => f.alt) as Array<{ id: string; alt: string }>;
    if (!files.length) continue;
    try {
      const res = await shopifyGraphQL<any>(FILE_UPDATE, { files }, shop);
      throwIfUserErrors(res.data?.fileUpdate?.userErrors, "fileUpdate");
      totalPushed += files.length;
    } catch (err) {
      console.log(`  ✗ push error: ${err}`);
      totalErrors++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Pushed:  ${totalPushed}${dryRunPush ? " (dry-run, nothing actually pushed)" : ""}`);
  console.log(`Skipped: ${totalSkipped}`);
  console.log(`Errors:  ${totalErrors}`);
}

main().catch(err => { console.error("\nFatal:", err); process.exit(1); });
