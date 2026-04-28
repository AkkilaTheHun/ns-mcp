#!/usr/bin/env tsx
/**
 * SEO refresh: write Sonnet-generated alt text from image_signatures back
 * to Shopify product images. ZERO new vision API spend — reads what was
 * already analyzed during pnpm index-brand.
 *
 * Usage:
 *   pnpm seo-refresh "Cadillacquer"                                   # dry-run by default
 *   pnpm seo-refresh "Cadillacquer" "Take It Easy" --shop nailstuff-ca.myshopify.com
 *   pnpm seo-refresh "Cadillacquer" --apply                           # actually write
 *   pnpm seo-refresh "Cadillacquer" --apply --force                   # overwrite even if alt text matches
 *
 * Default mode is DRY-RUN. Writes preview to stdout. Pass --apply to commit.
 *
 * For each product image:
 *   1. Look up image_signatures by source URL (query string stripped).
 *   2. Compose refreshed alt: <Sonnet alt> [+ ", swatched by @<handle>"]
 *   3. Compare to current Shopify alt text.
 *   4. If different (or --force): queue update.
 *   5. Per product: batch update via productUpdateMedia.
 *
 * Skips images that have no image_signatures row (i.e. not yet indexed).
 * Run pnpm index-brand first to populate the catalog, then this to write back.
 */
import "dotenv/config";
import { shopifyGraphQL } from "../src/shopify/client.js";
import { getSupabase } from "../src/supabase/client.js";
import { nearestNamedColor } from "../src/util/feature-extract.js";

// ---------------------------------------------------------------------------
// Deterministic alt-text composer
// ---------------------------------------------------------------------------

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function spell(n: number | null | undefined): string {
  if (!n || n < 0) return "";
  return NUMBER_WORDS[n] ?? String(n);
}

function imageTypeClause(type: string | null, nailCount: number | null | undefined): string {
  const n = spell(nailCount ?? undefined);
  const nClause = n ? `${n}-nail swatch` : "nail swatch";
  switch (type) {
    case "bottle_in_hand": return `bottle held with ${nClause}`;
    case "swatch_on_nails": return n ? `swatched on ${n} nails` : "swatched on nails";
    case "macro_detail": return "macro single-nail swatch";
    case "bottle_standalone": return "polish bottle";
    case "swatch_wheel": return "swatch wheel";
    case "swatch_stick": return "swatch stick";
    case "lifestyle": return "lifestyle shot";
    case "group_shot": return "group shot";
    case "layering_demo": return "layering demo";
    default: return "";
  }
}

function formatLighting(lc: string | null | undefined): string {
  if (!lc) return "";
  return lc.replace(/_/g, " ");
}

interface ShadeData {
  brand: string;
  shade_name: string;
  base_color_hex: string | null;
  finish_type: string | null;
  has_ultrachrome: boolean;
  has_iridescent: boolean;
  has_holographic: boolean;
  has_thermal: boolean;
  has_magnetic: boolean;
  flake_colors_hex: string[] | null;
}

interface ImageData {
  image_type: string | null;
  nail_count: number | null;
  skin_tone: string | null;
  lighting_condition: string | null;
  swatcher_handle: string | null;
}

const MAX_LENGTH = 140;

/**
 * Compose accessibility-leaning alt text from indexed shade + image data.
 * Pattern: "{Brand} {Shade} {color descriptors} {finish} nail polish, {what's shown}, {skin tone}, {lighting}"
 * Swatcher attribution is appended only if total length stays under MAX_LENGTH.
 */
export function composeAlt(shade: ShadeData, image: ImageData): string {
  const baseColor = shade.base_color_hex ? nearestNamedColor(shade.base_color_hex) : "";

  // Flake color hint: only when shade has ultrachrome (the standout effect
  // users search for). Try each flake color in order, skipping any that
  // overlap the base color (e.g., "purple" when base is "pastel purple").
  // For iridescent-only polishes, skip flake color entirely — saying "blue
  // iridescent" when base is "blue" is redundant.
  let flakeColorHint = "";
  if (shade.has_ultrachrome && shade.flake_colors_hex && shade.flake_colors_hex.length) {
    for (const fc of shade.flake_colors_hex) {
      const name = nearestNamedColor(fc);
      if (name === baseColor) continue;
      if (baseColor.includes(name) || name.includes(baseColor)) continue;
      flakeColorHint = name;
      break;
    }
  }

  const effects: string[] = [];
  if (shade.has_ultrachrome) effects.push("chameleon");
  if (shade.has_iridescent) effects.push("iridescent");
  if (shade.has_holographic) effects.push("holographic");
  if (shade.has_thermal) effects.push("thermal");
  if (shade.has_magnetic) effects.push("magnetic");

  const descriptors = [baseColor, flakeColorHint, ...effects, shade.finish_type]
    .filter((s): s is string => Boolean(s))
    .join(" ");

  let alt = `${shade.brand} ${shade.shade_name} ${descriptors} nail polish`.replace(/\s+/g, " ").trim();

  const imgClause = imageTypeClause(image.image_type, image.nail_count);
  if (imgClause) alt += `, ${imgClause}`;

  if (image.skin_tone) alt += `, ${image.skin_tone} skin`;
  if (image.lighting_condition) alt += `, ${formatLighting(image.lighting_condition)} lighting`;

  // Add swatcher attribution only if it fits within length budget
  if (image.swatcher_handle) {
    const swatcherSuffix = `, by @${image.swatcher_handle}`;
    if (alt.length + swatcherSuffix.length <= MAX_LENGTH) {
      alt += swatcherSuffix;
    }
  }

  return alt;
}

interface ProductMedia {
  id: string;             // gid://shopify/MediaImage/...
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
        media: { edges: Array<{ node: { id: string; image: { url: string; altText: string | null } | null } }> };
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
                  id
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
    if (!res.data) throw new Error("Shopify query returned no data");

    for (const edge of res.data.products.edges) {
      const node = edge.node;
      const collectionMeta = node.metafields.edges.find(
        (m) => m.node.namespace === "product" && m.node.key === "collection",
      )?.node.value;

      if (collectionFilter && collectionMeta !== collectionFilter) continue;

      const media: ProductMedia[] = [];
      for (const m of node.media.edges) {
        if (m.node.id && m.node.image?.url) {
          media.push({ id: m.node.id, url: m.node.image.url, altText: m.node.image.altText ?? null });
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

function stripQueryString(url: string): string {
  return url.split("?")[0];
}

const PRODUCT_UPDATE_MEDIA = `
  mutation ProductUpdateMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
    productUpdateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id alt } }
      mediaUserErrors { code field message }
    }
  }
`;

interface UpdateBatch {
  productId: string;
  media: Array<{ id: string; alt: string }>;
}

async function applyBatch(batch: UpdateBatch, shopDomain: string | undefined): Promise<{ ok: number; errors: string[] }> {
  const errors: string[] = [];
  const res = await shopifyGraphQL<{
    productUpdateMedia: {
      media: Array<{ id: string; alt: string }>;
      mediaUserErrors: Array<{ code: string; field: string[]; message: string }>;
    };
  }>(
    PRODUCT_UPDATE_MEDIA,
    { productId: batch.productId, media: batch.media },
    shopDomain,
  );
  if (res.data?.productUpdateMedia.mediaUserErrors?.length) {
    for (const e of res.data.productUpdateMedia.mediaUserErrors) {
      errors.push(`${e.field?.join(".") ?? "?"}: ${e.message}`);
    }
  }
  const ok = res.data?.productUpdateMedia.media?.length ?? 0;
  return { ok, errors };
}

interface Args {
  vendor: string;
  collection?: string;
  shop?: string;
  apply: boolean;
  force: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  let vendor: string | undefined;
  let collection: string | undefined;
  let shop: string | undefined;
  let apply = false;
  let force = false;
  let verbose = false;

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shop") shop = argv[++i];
    else if (a === "--apply") apply = true;
    else if (a === "--force") force = true;
    else if (a === "--verbose" || a === "-v") verbose = true;
    else positional.push(a);
  }
  vendor = positional[0];
  collection = positional[1];

  if (!vendor) {
    console.error("Usage: pnpm seo-refresh <vendor> [<collection>] [--shop <domain>] [--apply] [--force] [--verbose]");
    process.exit(1);
  }
  return { vendor, collection, shop, apply, force, verbose };
}

async function main() {
  const { vendor, collection, shop, apply, force, verbose } = parseArgs(process.argv.slice(2));
  const supabase = getSupabase();

  console.log(`\n=== SEO refresh: ${vendor}${collection ? ` / ${collection}` : ""} ===`);
  if (shop) console.log(`Shop: ${shop}`);
  console.log(`Mode: ${apply ? "APPLY (writes to Shopify)" : "DRY-RUN (no writes)"}${force ? " + force" : ""}`);
  console.log(`Loading products...`);

  const products = await listProductsForBrand(vendor, collection, shop);
  console.log(`Found ${products.length} product(s) with media.\n`);
  if (!products.length) return;

  // Pre-load all shades for this brand
  const { data: shadeRows, error: shadeErr } = await supabase
    .from("shade_signatures")
    .select("id, brand, shade_name, base_color_hex, finish_type, has_ultrachrome, has_iridescent, has_holographic, has_thermal, has_magnetic, flake_colors_hex")
    .eq("brand", vendor);
  if (shadeErr) {
    console.error(`Supabase shade query failed: ${shadeErr.message}`);
    process.exit(1);
  }
  const shadeById = new Map<number, ShadeData>();
  for (const s of (shadeRows ?? []) as Array<ShadeData & { id: number }>) {
    shadeById.set(s.id, s);
  }

  // Pre-load all image_signatures rows for this brand
  const { data: sigs, error: sigErr } = await supabase
    .from("image_signatures")
    .select("shade_id, source_path, swatcher_handle, image_type, nail_count, skin_tone, lighting_condition, shade_signatures!inner(brand)")
    .eq("shade_signatures.brand", vendor);
  if (sigErr) {
    console.error(`Supabase image query failed: ${sigErr.message}`);
    process.exit(1);
  }

  // Index by stripped-query URL for fast lookup
  type SigRow = ImageData & { shade_id: number; source_path: string };
  const sigByUrl = new Map<string, SigRow>();
  for (const s of (sigs ?? []) as SigRow[]) {
    if (s.source_path && s.shade_id != null) {
      sigByUrl.set(stripQueryString(s.source_path), s);
    }
  }
  console.log(`Loaded ${shadeById.size} shade(s) and ${sigByUrl.size} image signature(s) for ${vendor}.\n`);

  let totalImages = 0;
  let totalChanged = 0;
  let totalUnchanged = 0;
  let totalNotIndexed = 0;
  let totalApplied = 0;
  const allErrors: Array<{ product: string; error: string }> = [];

  for (let p = 0; p < products.length; p++) {
    const product = products[p];
    const updates: Array<{ id: string; alt: string; was: string | null; url: string }> = [];
    let notIndexed = 0;

    for (const m of product.media) {
      totalImages++;
      const sig = sigByUrl.get(stripQueryString(m.url));
      if (!sig) {
        notIndexed++;
        totalNotIndexed++;
        continue;
      }
      const shade = shadeById.get(sig.shade_id);
      if (!shade) {
        notIndexed++;
        totalNotIndexed++;
        continue;
      }
      const newAlt = composeAlt(shade, sig);
      const currentAlt = m.altText ?? "";
      if (!force && currentAlt.trim() === newAlt.trim()) {
        totalUnchanged++;
        continue;
      }
      updates.push({ id: m.id, alt: newAlt, was: currentAlt, url: m.url });
    }

    const willChange = updates.length;
    totalChanged += willChange;

    console.log(`[${p + 1}/${products.length}] ${product.title}  (${product.media.length} images)`);
    console.log(`  ${willChange} to update, ${product.media.length - willChange - notIndexed} unchanged${notIndexed ? `, ${notIndexed} not indexed` : ""}`);

    if (verbose && willChange > 0) {
      for (const u of updates.slice(0, 3)) {
        const filename = u.url.split("/").pop()?.split("?")[0];
        console.log(`    ${filename}`);
        console.log(`      was: ${(u.was ?? "<none>").slice(0, 100)}${(u.was?.length ?? 0) > 100 ? "..." : ""}`);
        console.log(`      new: ${u.alt.slice(0, 100)}${u.alt.length > 100 ? "..." : ""}`);
      }
      if (updates.length > 3) console.log(`    ... and ${updates.length - 3} more`);
    }

    if (apply && willChange > 0) {
      const result = await applyBatch(
        { productId: product.id, media: updates.map((u) => ({ id: u.id, alt: u.alt })) },
        shop,
      );
      totalApplied += result.ok;
      for (const e of result.errors) {
        allErrors.push({ product: product.title, error: e });
        console.log(`  ✗ ${e}`);
      }
      if (result.ok > 0) console.log(`  ✓ wrote ${result.ok} updates to Shopify`);
    }

    console.log("");
  }

  console.log(`=== Summary ===`);
  console.log(`Products:      ${products.length}`);
  console.log(`Images total:  ${totalImages}`);
  console.log(`To update:     ${totalChanged}${force ? " (--force)" : ""}`);
  console.log(`Unchanged:     ${totalUnchanged}`);
  console.log(`Not indexed:   ${totalNotIndexed}`);
  if (apply) {
    console.log(`Applied:       ${totalApplied}`);
    console.log(`Errors:        ${allErrors.length}`);
    if (allErrors.length) {
      for (const e of allErrors.slice(0, 10)) console.log(`  [${e.product}] ${e.error}`);
      if (allErrors.length > 10) console.log(`  ... and ${allErrors.length - 10} more`);
    }
  } else {
    console.log(`\nThis was a DRY-RUN. Re-run with --apply to actually write.`);
  }
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});
