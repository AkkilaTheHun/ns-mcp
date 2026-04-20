/**
 * Shopify preflight helpers for product ingestion.
 * These call shopifyGraphQL directly (bypassing the MCP tool layer)
 * so ingest_product can run them in parallel server-side.
 *
 * Every function accepts an optional `shop` parameter (shop domain string)
 * which is passed through to shopifyGraphQL. This is required when multiple
 * shops are configured — the caller (ingest_product) resolves the shop
 * from the MCP session once upfront and threads it through.
 */
import { shopifyGraphQL } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProductMatch {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  status: string;
  createdAt: string;
}

export interface DedupResult {
  exact: ProductMatch[];
  fuzzy: ProductMatch[];
  catalogWide: ProductMatch[];
}

export interface ConfigReference {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  status: string;
  templateSuffix: string | null;
  tags: string[];
  createdAt: string;
  metafields: Array<{ namespace: string; key: string; value: string; type: string }>;
  variants: Array<{
    id: string;
    sku: string;
    price: string;
    compareAtPrice: string | null;
    taxable: boolean;
    inventoryPolicy: string;
  }>;
  seo: { title: string | null; description: string | null };
}

export interface StyleReference {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  descriptionHtml: string;
  createdAt: string;
  seo: { title: string | null; description: string | null };
}

export interface MetaobjectEntry {
  id: string;
  handle: string;
  displayName: string;
  type: string;
  fields: Array<{ key: string; value: string; type: string }>;
}

// ---------------------------------------------------------------------------
// Internal helper — all queries go through this
// ---------------------------------------------------------------------------

async function gql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  shop?: string,
) {
  return shopifyGraphQL<T>(query, variables, shop);
}

// ---------------------------------------------------------------------------
// GraphQL fragments
// ---------------------------------------------------------------------------

const MATCH_FIELDS = `id title handle vendor status createdAt`;

const CONFIG_REF_FIELDS = `
  id title handle vendor productType status templateSuffix tags createdAt
  seo { title description }
  metafields(first: 50) { edges { node { namespace key value type } } }
  variants(first: 10) { edges { node {
    id sku price compareAtPrice taxable inventoryPolicy
  } } }
`;

const STYLE_REF_FIELDS = `
  id title handle vendor descriptionHtml createdAt
  seo { title description }
`;

const MO_FIELDS = `id handle displayName type fields { key value type }`;

// ---------------------------------------------------------------------------
// SKU Lookup
// ---------------------------------------------------------------------------

/** Brand name to SKU prefix mapping. Derives prefix from vendor name. */
function brandToSkuPrefix(vendor: string): string {
  // Known overrides — add here when a brand's natural abbreviation is ambiguous
  const overrides: Record<string, string> = {
    "dam nail polish": "DNP",
    "dam polish": "DNP",
    "prairie crocus lacquer": "PCL",
    "prairie crocus": "PCL",
    "prairie crocus polish": "PCP",
    "glam polish": "GP",
    "chamaeleon": "CHA",
    "chamaeleon nails polish": "CHA",
  };

  const lower = vendor.toLowerCase().trim();
  if (overrides[lower]) return overrides[lower];

  // Default: take first letter of each word, uppercase
  const words = vendor.trim().split(/\s+/);
  if (words.length === 1) {
    // Single-word brand: take first 3 chars
    return vendor.slice(0, 3).toUpperCase();
  }
  return words.map((w) => w[0]).join("").toUpperCase();
}

export async function lookupNextSku(
  vendor: string,
  shop?: string,
): Promise<{ prefix: string; currentMax: string | null; next: string }> {
  const prefix = brandToSkuPrefix(vendor);
  const skuPattern = `NP-${prefix}-*`;

  const res = await gql<{
    productVariants: { edges: Array<{ node: { sku: string } }> };
  }>(
    `query($query: String!) {
      productVariants(first: 1, query: $query, sortKey: SKU, reverse: true) {
        edges { node { sku } }
      }
    }`,
    { query: `sku:${skuPattern}` },
    shop,
  );

  const currentMax = res.data?.productVariants?.edges?.[0]?.node?.sku ?? null;

  let nextNum = 1;
  if (currentMax) {
    const match = currentMax.match(/NP-\w+-(\d+)/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }

  const next = `NP-${prefix}-${String(nextNum).padStart(3, "0")}`;
  return { prefix, currentMax, next };
}

// ---------------------------------------------------------------------------
// Duplicate Detection
// ---------------------------------------------------------------------------

async function searchProducts(query: string, shop?: string, first = 10): Promise<ProductMatch[]> {
  const res = await gql<{
    products: { edges: Array<{ node: ProductMatch }> };
  }>(
    `query($query: String!, $first: Int!) {
      products(first: $first, query: $query) {
        edges { node { ${MATCH_FIELDS} } }
      }
    }`,
    { query, first },
    shop,
  );
  return res.data?.products?.edges?.map((e) => e.node) ?? [];
}

/** Strip parentheticals and trailing descriptors for fuzzy matching. */
function coreName(title: string): string {
  return title
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s*-\s*.*$/, "")
    .trim();
}

export async function checkDuplicates(
  title: string,
  vendor: string,
  shop?: string,
): Promise<DedupResult> {
  const core = coreName(title);

  // Run all three queries in parallel
  const [exact, fuzzy, catalogWide] = await Promise.all([
    searchProducts(`title:'${title}' vendor:'${vendor}'`, shop),
    searchProducts(`title:*${core}* vendor:'${vendor}'`, shop),
    searchProducts(`title:*${core}*`, shop),
  ]);

  return { exact, fuzzy, catalogWide };
}

// ---------------------------------------------------------------------------
// Configuration Reference
// ---------------------------------------------------------------------------

export async function getConfigReference(
  vendor: string,
  stockType: string,
  shop?: string,
): Promise<ConfigReference | null> {
  // Query most recent product from same vendor
  const templateFilter = stockType === "preorder" ? "tag:Preorder" : "-tag:Preorder";
  const query = `vendor:'${vendor}' ${templateFilter}`;

  const res = await gql<{
    products: { edges: Array<{ node: Record<string, unknown> }> };
  }>(
    `query($query: String!) {
      products(first: 1, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges { node { ${CONFIG_REF_FIELDS} } }
      }
    }`,
    { query },
    shop,
  );

  const node = res.data?.products?.edges?.[0]?.node;
  if (!node) return null;

  return {
    id: node.id as string,
    title: node.title as string,
    handle: node.handle as string,
    vendor: node.vendor as string,
    productType: (node.productType as string) ?? "",
    status: node.status as string,
    templateSuffix: (node.templateSuffix as string) ?? null,
    tags: (node.tags as string[]) ?? [],
    createdAt: node.createdAt as string,
    seo: node.seo as { title: string | null; description: string | null },
    metafields: ((node.metafields as { edges: Array<{ node: { namespace: string; key: string; value: string; type: string } }> })?.edges ?? []).map((e) => e.node),
    variants: ((node.variants as { edges: Array<{ node: Record<string, unknown> }> })?.edges ?? []).map((e) => ({
      id: e.node.id as string,
      sku: (e.node.sku as string) ?? "",
      price: (e.node.price as string) ?? "0.00",
      compareAtPrice: (e.node.compareAtPrice as string) ?? null,
      taxable: (e.node.taxable as boolean) ?? true,
      inventoryPolicy: (e.node.inventoryPolicy as string) ?? "DENY",
    })),
  };
}

// ---------------------------------------------------------------------------
// Style Reference
// ---------------------------------------------------------------------------

export async function getStyleReference(count = 5, shop?: string): Promise<StyleReference[]> {
  const res = await gql<{
    products: { edges: Array<{ node: Record<string, unknown> }> };
  }>(
    `query($first: Int!) {
      products(first: $first, sortKey: CREATED_AT, reverse: true) {
        edges { node { ${STYLE_REF_FIELDS} } }
      }
    }`,
    { first: count },
    shop,
  );

  return (res.data?.products?.edges ?? []).map((e) => ({
    id: e.node.id as string,
    title: e.node.title as string,
    handle: e.node.handle as string,
    vendor: e.node.vendor as string,
    descriptionHtml: (e.node.descriptionHtml as string) ?? "",
    createdAt: e.node.createdAt as string,
    seo: e.node.seo as { title: string | null; description: string | null },
  }));
}

// ---------------------------------------------------------------------------
// Metaobject Lookups
// ---------------------------------------------------------------------------

/**
 * Find a metaobject by displayName (case-insensitive).
 * Falls back to partial match if exact match fails.
 */
export async function findBrandMetaobject(
  vendor: string,
  shop?: string,
): Promise<{ id: string; displayName: string; handle: string } | null> {
  // List all brand metaobjects (typically < 20) and match by displayName
  const entries = await listMetaobjectEntries("brand", shop);
  const vendorLower = vendor.toLowerCase().trim();

  // Try exact displayName match first
  const exact = entries.find((e) => e.displayName.toLowerCase().trim() === vendorLower);
  if (exact) return { id: exact.id, displayName: exact.displayName, handle: exact.handle };

  // Try partial/contains match
  const partial = entries.find(
    (e) =>
      e.displayName.toLowerCase().includes(vendorLower) ||
      vendorLower.includes(e.displayName.toLowerCase()),
  );
  if (partial) return { id: partial.id, displayName: partial.displayName, handle: partial.handle };

  return null;
}

export async function listMetaobjectEntries(type: string, shop?: string): Promise<MetaobjectEntry[]> {
  const entries: MetaobjectEntry[] = [];
  let after: string | undefined;

  // Paginate to get all entries (most types have < 50)
  do {
    const res = await gql<{
      metaobjects: {
        edges: Array<{ cursor: string; node: MetaobjectEntry }>;
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    }>(
      `query($type: String!, $first: Int!, $after: String) {
        metaobjects(type: $type, first: $first, after: $after) {
          edges { cursor node { ${MO_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { type, first: 50, after },
      shop,
    );

    const data = res.data?.metaobjects;
    if (!data) break;

    entries.push(...data.edges.map((e) => e.node));
    after = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : undefined;
  } while (after);

  return entries;
}

// ---------------------------------------------------------------------------
// Taxonomy (pinned list - no query needed)
// ---------------------------------------------------------------------------

export const TAXONOMY_MAP: Record<string, { gid: string; path: string }> = {
  "nail_polish": {
    gid: "gid://shopify/TaxonomyCategory/hb-3-2-7-11",
    path: "Health & Beauty > Personal Care > Cosmetics > Nail Care > Nail Polishes",
  },
  "nail_stickers": {
    gid: "gid://shopify/TaxonomyCategory/hb-3-2-7-4-2",
    path: "Nail Art Kits & Accessories > Nail Stickers & Decals",
  },
  "cuticle_oil": {
    gid: "gid://shopify/TaxonomyCategory/hb-3-2-7-1-2",
    path: "Cuticle Creams & Oil > Cuticle Oil",
  },
  "nail_art_brushes": {
    gid: "gid://shopify/TaxonomyCategory/hb-3-2-7-4-1",
    path: "Nail Art Kits & Accessories > Nail Art Brushes & Dotting Tools",
  },
  "nail_art_magnets": {
    gid: "gid://shopify/TaxonomyCategory/hb-3-2-7-4",
    path: "Nail Art Kits & Accessories",
  },
  "nail_files": {
    gid: "gid://shopify/TaxonomyCategory/hb-3-2-5-2-10",
    path: "Cosmetic Tools > Nail Tools > Nail Files & Emery Boards",
  },
  "nail_treatments": {
    gid: "gid://shopify/TaxonomyCategory/hb-3-2-7-13",
    path: "Nail Care > Nail Treatments",
  },
  "stamping_plates": {
    gid: "gid://shopify/TaxonomyCategory/hb-3-2-7-4",
    path: "Nail Art Kits & Accessories",
  },
};
