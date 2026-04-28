#!/usr/bin/env tsx
/**
 * Bulk-index a brand's shade catalog into Supabase pgvector.
 *
 * Usage:
 *   pnpm index-brand "Cadillacquer"                    # all Cadillacquer products
 *   pnpm index-brand "Cadillacquer" "Take It Easy"     # only the Take It Easy collection
 *   pnpm index-brand "Cadillacquer" --shop nailstuff-ca.myshopify.com
 *
 * Reads env vars from .env (same as the MCP server):
 *   - SHOPS or SHOP_DOMAIN + SHOPIFY_ACCESS_TOKEN
 *   - ANTHROPIC_API_KEY
 *   - SUPABASE_URL + SUPABASE_SERVICE_KEY
 *
 * For each product:
 *   1. Fetches all media (images + alt text) via Shopify Admin GraphQL.
 *   2. Downloads each image, prepares full (1400px) + attention crop (800x800)
 *      via Sharp, and runs Sonnet 4.6 vision analysis with the dual-image
 *      hierarchy prompt.
 *   3. Inserts an image_signatures row per photo (with extracted features,
 *      embedding, swatcher handle parsed from alt text).
 *   4. Recomputes the shade_signatures aggregate ONCE per shade at the end
 *      (not per-image — saves 19 redundant DB updates per shade).
 *
 * Concurrency: vision API calls run 6-wide. DB writes are sequential
 * inside a shade (cheap) but shades run sequentially (so logs are readable).
 */
import "dotenv/config";
import sharp from "sharp";
import { shopifyGraphQL } from "../src/shopify/client.js";
import { analyzeImage as analyzeImageClaude } from "../src/anthropic/vision.js";
import { extractAndEmbed } from "../src/util/feature-extract.js";
import { getSupabase } from "../src/supabase/client.js";
import { recomputeShadeAggregate } from "../src/supabase/recompute.js";

interface ProductMedia {
  url: string;
  altText: string | null;
}

interface ProductSummary {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  collection?: string;
  media: ProductMedia[];
}

interface ProductsQueryResult {
  products: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        title: string;
        handle: string;
        vendor: string;
        media: { edges: Array<{ node: { image: { url: string; altText: string | null } | null } }> };
        metafields: { edges: Array<{ node: { namespace: string; key: string; value: string } }> };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const PRODUCTS_QUERY = `
  query ProductsByVendor($query: String!, $first: Int!, $after: String) {
    products(query: $query, first: $first, after: $after, sortKey: TITLE) {
      edges {
        cursor
        node {
          id
          title
          handle
          vendor
          media(first: 50) {
            edges {
              node {
                ... on MediaImage {
                  image { url altText }
                }
              }
            }
          }
          metafields(namespace: "product", first: 10) {
            edges { node { namespace key value } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function listProductsForBrand(
  vendor: string,
  collectionFilter: string | undefined,
  shopDomain: string | undefined,
): Promise<ProductSummary[]> {
  const products: ProductSummary[] = [];
  let cursor: string | null = null;

  while (true) {
    const res = await shopifyGraphQL<ProductsQueryResult>(
      PRODUCTS_QUERY,
      { query: `vendor:"${vendor}"`, first: 50, after: cursor },
      shopDomain,
    );
    if (!res.data) throw new Error(`Shopify query returned no data`);

    for (const edge of res.data.products.edges) {
      const node = edge.node;
      const collectionMeta = node.metafields.edges.find(
        (m) => m.node.namespace === "product" && m.node.key === "collection",
      )?.node.value;

      if (collectionFilter && collectionMeta !== collectionFilter) continue;

      const media: ProductMedia[] = [];
      for (const m of node.media.edges) {
        if (m.node.image?.url) {
          media.push({ url: m.node.image.url, altText: m.node.image.altText ?? null });
        }
      }
      if (!media.length) continue;

      products.push({
        id: node.id,
        title: node.title,
        handle: node.handle,
        vendor: node.vendor,
        collection: collectionMeta,
        media,
      });
    }

    if (!res.data.products.pageInfo.hasNextPage) break;
    cursor = res.data.products.pageInfo.endCursor;
  }

  return products;
}

function extractSwatcherHandle(altText: string | null): string | undefined {
  if (!altText) return undefined;
  const m = altText.match(/swatched by @([\w_]+)/i);
  return m?.[1];
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

interface VisionResult {
  imageType: string;
  dominantColors: Array<{ hex?: string; label: string }>;
  observedEffects: string[];
  altText: string;
  confidence: number;
}

async function analyzeOne(
  url: string,
  productName: string,
  brand: string,
  vendorHint: string,
): Promise<VisionResult> {
  const raw = await downloadImage(url);
  const rotated = sharp(raw, { failOn: "none" }).rotate();
  const full = await rotated
    .clone()
    .resize({ width: 1400, withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
  const crop = await rotated
    .clone()
    .resize({ width: 800, height: 800, fit: "cover", position: sharp.strategy.attention })
    .jpeg({ quality: 92 })
    .toBuffer();

  const analysis = await analyzeImageClaude(
    full.toString("base64"),
    "image/jpeg",
    { productName, brand, vendorHint },
    "claude-sonnet-4-6",
    { base64: crop.toString("base64"), mimeType: "image/jpeg" },
  );

  return analysis as VisionResult;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
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

function parseArgs(argv: string[]): { vendor: string; collection?: string; shop?: string; vendorHint?: string } {
  let vendor: string | undefined;
  let collection: string | undefined;
  let shop: string | undefined;
  let vendorHint: string | undefined;

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shop") shop = argv[++i];
    else if (a === "--hint") vendorHint = argv[++i];
    else positional.push(a);
  }
  vendor = positional[0];
  collection = positional[1];

  if (!vendor) {
    console.error("Usage: pnpm index-brand <vendor> [<collection>] [--shop <domain>] [--hint <vendorHint>]");
    process.exit(1);
  }
  return { vendor, collection, shop, vendorHint };
}

async function main() {
  const { vendor, collection, shop, vendorHint } = parseArgs(process.argv.slice(2));
  const supabase = getSupabase();

  console.log(`\n=== Indexing brand: ${vendor}${collection ? ` / ${collection}` : ""} ===`);
  if (shop) console.log(`Shop: ${shop}`);
  console.log(`Loading products...`);

  const products = await listProductsForBrand(vendor, collection, shop);
  console.log(`Found ${products.length} product(s) with media.\n`);
  if (!products.length) {
    console.log("Nothing to index.");
    return;
  }

  const totalImages = products.reduce((sum, p) => sum + p.media.length, 0);
  console.log(`Total images to process: ${totalImages} (~$${(totalImages * 0.02).toFixed(2)} on Sonnet)\n`);

  let totalIndexed = 0;
  let totalErrors = 0;
  const errors: Array<{ product: string; url: string; error: string }> = [];

  for (let p = 0; p < products.length; p++) {
    const product = products[p];
    console.log(`[${p + 1}/${products.length}] ${product.title}  (${product.media.length} images)`);

    // Upsert shade row
    const { data: shadeRow, error: shadeErr } = await supabase
      .from("shade_signatures")
      .upsert(
        {
          brand: product.vendor,
          shade_name: product.title,
          collection: product.collection ?? null,
          shopify_product_id: product.id,
          shopify_handle: product.handle,
        },
        { onConflict: "brand,shade_name" },
      )
      .select("id")
      .single();

    if (shadeErr || !shadeRow) {
      console.log(`  ✗ Failed to upsert shade: ${shadeErr?.message ?? "unknown"}\n`);
      totalErrors++;
      continue;
    }

    const shadeId = shadeRow.id as number;
    const hint = vendorHint ?? "";

    // Concurrent analyze (6-wide), then sequential DB inserts per shade
    const analyses = await mapConcurrent(product.media, 6, async (media, i) => {
      try {
        const analysis = await analyzeOne(media.url, product.title, product.vendor, hint);
        return { ok: true as const, media, analysis };
      } catch (err) {
        return { ok: false as const, media, error: String(err) };
      }
    });

    let ok = 0;
    let bad = 0;
    for (const r of analyses) {
      if (!r.ok) {
        errors.push({ product: product.title, url: r.media.url, error: r.error });
        bad++;
        continue;
      }
      const features = extractAndEmbed({
        dominantColors: r.analysis.dominantColors,
        observedEffects: r.analysis.observedEffects,
        altText: r.analysis.altText,
      });
      const { error: insertErr } = await supabase.from("image_signatures").insert({
        shade_id: shadeId,
        source_path: r.media.url,
        swatcher_handle: extractSwatcherHandle(r.media.altText),
        image_type: r.analysis.imageType,
        dominant_colors: r.analysis.dominantColors,
        observed_effects: r.analysis.observedEffects,
        alt_text: r.analysis.altText,
        confidence: r.analysis.confidence,
        vision_provider: "claude",
        vision_model: "claude-sonnet-4-6",
        base_color_hex: features.baseColorHex ?? null,
        base_color_lab: features.baseColorLab,
        embedding: features.embedding,
      });
      if (insertErr) {
        errors.push({ product: product.title, url: r.media.url, error: insertErr.message });
        bad++;
      } else {
        ok++;
      }
    }

    // Single recompute at the end of this shade
    try {
      await recomputeShadeAggregate(shadeId);
    } catch (err) {
      console.log(`  ! recompute failed: ${err}`);
    }

    totalIndexed += ok;
    totalErrors += bad;
    console.log(`  ✓ indexed ${ok}/${product.media.length}${bad ? ` (${bad} errors)` : ""}\n`);
  }

  console.log(`\n=== Done ===`);
  console.log(`Shades processed: ${products.length}`);
  console.log(`Images indexed:   ${totalIndexed}`);
  console.log(`Errors:           ${totalErrors}`);
  if (errors.length) {
    console.log(`\nError details:`);
    for (const e of errors.slice(0, 10)) {
      console.log(`  [${e.product}] ${e.url}: ${e.error}`);
    }
    if (errors.length > 10) console.log(`  ... and ${errors.length - 10} more`);
  }
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});
