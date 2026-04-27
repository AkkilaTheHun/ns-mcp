/**
 * nailstuff_retire — retire products and migrate brands to the metafield-based collection pattern.
 *
 * Two operations on one tool:
 * - action="products": apply the retirement transformations to specific products.
 *   Targets either a list of product IDs, or all products matching {vendor + era}.
 *   Idempotent — safe to re-run.
 *
 * - action="bulk_brand": full brand migration in one call.
 *   1. Paginates ALL products for the vendor (active + archived).
 *   2. Sets `product.collection` metafield on every product with a known era (consolidating PPU variants
 *      and any other eras passed in `eraConsolidations`).
 *   3. Calls retireProducts on every archived product (status→ACTIVE, template, label, tag, publish).
 *   4. Creates per-era smart collections (active eras get NOT_EQUALS retired filter; pure-retired
 *      eras don't). Skips collections that already exist by handle.
 *   5. Creates `{Brand} - Retired Shades` brand-scoped retired collection.
 *   6. Patches Main Drop Down menu: replaces the brand's filter-URL submenu items with new collection
 *      links, adds a `Retired Shades` item under the brand.
 *   7. Adds the brand as a sibling under the root `Retired Shades` item in the
 *      `retired-shades-collections` menu.
 *   8. Creates 301 redirects for old filter URLs.
 *
 * Designed to be reusable when a future era retires (call action="products" with {vendor, era}).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL } from "../../shopify/client.js";

// ---------------------------------------------------------------------------
// Constants — NailStuff retirement convention
// ---------------------------------------------------------------------------

const LABEL_COLOR = "#9C7B7B"; // dusty rose
const TEMPLATE_SUFFIX = "retired-shade";
const RETIRED_TAG = "retired";
const PRODUCT_COLLECTION_METAFIELD_DEF_GID = "gid://shopify/MetafieldDefinition/50706776217";
const MAIN_DROP_DOWN_MENU_GID = "gid://shopify/Menu/252081540";
const RETIRED_SHADES_COLLECTIONS_MENU_GID = "gid://shopify/Menu/411159462041";
const GLOBAL_RETIRED_SHADES_COLLECTION_GID = "gid://shopify/Collection/352620707993";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

interface RetireReport {
  processed: number;
  errors: string[];
}

interface BulkBrandReport {
  vendor: string;
  totalProducts: number;
  activeProducts: number;
  archivedProducts: number;
  unknownEra: number;
  metafieldsSet: number;
  retired: RetireReport;
  collectionsCreated: Array<{ handle: string; era: string; mode: "active" | "retired" | "brand" }>;
  collectionsSkipped: Array<{ handle: string; reason: string }>;
  menuItemsUpdated: number;
  retiredShadesItemAdded: boolean;
  retiredShadesCollectionsMenuUpdated: boolean;
  redirectsCreated: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Extract era from a product's tags. Returns null if none found. */
function extractEra(tags: string[], consolidations: Record<string, string>): string | null {
  // Find Collection_X / collection_X tags (case-insensitive prefix). Skip generic vendor-level ones.
  const candidates: string[] = [];
  for (const tag of tags) {
    const m = /^collection_(.+)$/i.exec(tag);
    if (!m) continue;
    candidates.push(m[1].trim());
  }
  if (candidates.length === 0) return null;
  // Prefer non-generic. Without knowing the vendor here, just pick the longest specific name that's
  // not "Cadillacquer" / "'Ard As Nails" etc. Caller can pass eraConsolidations to merge.
  const sorted = candidates.sort((a, b) => b.length - a.length);
  const era = sorted[0];
  return consolidations[era] ?? era;
}

/** Get all sales-channel publication IDs for the current shop (cached). */
const publicationIdCache = new Map<string, string[]>();
async function getAllPublicationIds(shop?: string): Promise<string[]> {
  const key = shop ?? "__default__";
  const cached = publicationIdCache.get(key);
  if (cached) return cached;
  const res = await shopifyGraphQL<{ publications: { edges: Array<{ node: { id: string } }> } }>(
    `query { publications(first: 50) { edges { node { id } } } }`,
    undefined,
    shop,
  );
  const ids = (res.data?.publications.edges ?? []).map(e => e.node.id);
  publicationIdCache.set(key, ids);
  return ids;
}

/** Fetch publications by name (for resolving Online Store + market catalog publication IDs). */
async function getMarketPublicationIds(shop?: string): Promise<{ onlineStore?: string; canada?: string; us?: string }> {
  const res = await shopifyGraphQL<{ publications: { edges: Array<{ node: { id: string; name: string } }> } }>(
    `query { publications(first: 50) { edges { node { id name } } } }`,
    undefined,
    shop,
  );
  const map: Record<string, string> = {};
  for (const e of res.data?.publications.edges ?? []) {
    map[e.node.name] = e.node.id;
  }
  return { onlineStore: map["Online Store"], canada: map["Canada"], us: map["United States"] };
}

// ---------------------------------------------------------------------------
// Core: retire a list of products (apply transformations + publish)
// ---------------------------------------------------------------------------

const RETIRE_BATCH = 15; // products per GraphQL mutation (productUpdate + tagsAdd aliases)
const PUBLISH_BATCH = 30;

async function retireProducts(productIds: string[], shop?: string): Promise<RetireReport> {
  if (productIds.length === 0) return { processed: 0, errors: [] };

  const errors: string[] = [];

  // Step 1: productUpdate (status, templateSuffix, label metafields) + tagsAdd, batched + parallelized.
  const retireBatches: string[][] = [];
  for (let i = 0; i < productIds.length; i += RETIRE_BATCH) {
    retireBatches.push(productIds.slice(i, i + RETIRE_BATCH));
  }
  const RETIRE_PARALLEL = 4;
  for (let i = 0; i < retireBatches.length; i += RETIRE_PARALLEL) {
    const chunk = retireBatches.slice(i, i + RETIRE_PARALLEL);
    await Promise.all(chunk.map(async batch => {
      const aliases = batch.map((id, idx) => {
        const safe = id.replace(/"/g, "\\\"");
        return `
          p${idx}: productUpdate(product: {
            id: "${safe}",
            status: ACTIVE,
            templateSuffix: "${TEMPLATE_SUFFIX}",
            metafields: [
              { namespace: "theme", key: "label", value: "[\\"Retired\\"]", type: "list.single_line_text_field" },
              { namespace: "theme", key: "label_color", value: "[\\"${LABEL_COLOR}\\"]", type: "list.color" }
            ]
          }) { userErrors { field message } }
          t${idx}: tagsAdd(id: "${safe}", tags: ["${RETIRED_TAG}"]) { userErrors { field message } }
        `;
      }).join("");
      try {
        const res = await shopifyGraphQL<Record<string, { userErrors?: Array<{ message: string }> }>>(`mutation { ${aliases} }`, undefined, shop);
        for (let j = 0; j < batch.length; j++) {
          const p = res.data?.[`p${j}`]?.userErrors ?? [];
          const t = res.data?.[`t${j}`]?.userErrors ?? [];
          for (const e of p) errors.push(`productUpdate ${batch[j]}: ${e.message}`);
          for (const e of t) errors.push(`tagsAdd ${batch[j]}: ${e.message}`);
        }
      } catch (e) {
        errors.push(`retire batch: ${(e as Error).message}`);
      }
    }));
  }

  // Step 2: publish to all sales channels.
  const pubIds = await getAllPublicationIds(shop);
  if (pubIds.length === 0) {
    errors.push("no sales-channel publications found — products won't be visible on storefront");
    return { processed: productIds.length, errors };
  }
  const pubInputs = pubIds.map(id => `{publicationId: "${id}"}`).join(", ");
  const publishBatches: string[][] = [];
  for (let i = 0; i < productIds.length; i += PUBLISH_BATCH) {
    publishBatches.push(productIds.slice(i, i + PUBLISH_BATCH));
  }
  for (let i = 0; i < publishBatches.length; i += RETIRE_PARALLEL) {
    const chunk = publishBatches.slice(i, i + RETIRE_PARALLEL);
    await Promise.all(chunk.map(async batch => {
      const aliases = batch.map((id, idx) => {
        const safe = id.replace(/"/g, "\\\"");
        return `pub${idx}: publishablePublish(id: "${safe}", input: [${pubInputs}]) { userErrors { field message } }`;
      }).join("\n");
      try {
        const res = await shopifyGraphQL<Record<string, { userErrors?: Array<{ message: string }> }>>(`mutation { ${aliases} }`, undefined, shop);
        for (let j = 0; j < batch.length; j++) {
          const errs = res.data?.[`pub${j}`]?.userErrors ?? [];
          for (const e of errs) errors.push(`publish ${batch[j]}: ${e.message}`);
        }
      } catch (e) {
        errors.push(`publish batch: ${(e as Error).message}`);
      }
    }));
  }

  return { processed: productIds.length, errors };
}

/** Find product IDs by vendor + product.collection metafield value (era). */
async function findProductIdsByVendorAndEra(vendor: string, era: string, shop?: string): Promise<string[]> {
  // Use the search query syntax: vendor:X metafield:product.collection:Y is not directly supported,
  // so we paginate vendor:X and filter client-side by the metafield value.
  const ids: string[] = [];
  let after: string | null = null;
  while (true) {
    const res: { data?: { products?: { edges?: Array<{ cursor: string; node: { id: string; metafield?: { value?: string } } }>; pageInfo?: { hasNextPage: boolean; endCursor: string } } } } = await shopifyGraphQL(
      `query($q: String, $after: String) {
        products(first: 100, query: $q, after: $after) {
          edges {
            cursor
            node {
              id
              metafield(namespace: "product", key: "collection") { value }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { q: `vendor:"${vendor.replace(/"/g, '\\"')}"`, after },
      shop,
    );
    const edges = res.data?.products?.edges ?? [];
    for (const e of edges) {
      if (e.node.metafield?.value === era) ids.push(e.node.id);
    }
    if (!res.data?.products?.pageInfo?.hasNextPage) break;
    after = res.data?.products?.pageInfo?.endCursor ?? null;
    if (!after) break;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Bulk brand migration
// ---------------------------------------------------------------------------

interface VendorProduct {
  id: string;
  status: string; // ACTIVE | ARCHIVED | DRAFT
  tags: string[];
}

async function fetchAllBrandProducts(vendor: string, shop?: string): Promise<VendorProduct[]> {
  const out: VendorProduct[] = [];
  let after: string | null = null;
  while (true) {
    const res: { data?: { products?: { edges?: Array<{ cursor: string; node: VendorProduct }>; pageInfo?: { hasNextPage: boolean; endCursor: string } } } } = await shopifyGraphQL(
      `query($q: String, $after: String) {
        products(first: 250, query: $q, after: $after) {
          edges {
            cursor
            node { id status tags }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { q: `vendor:"${vendor.replace(/"/g, '\\"')}"`, after },
      shop,
    );
    const edges = res.data?.products?.edges ?? [];
    for (const e of edges) out.push(e.node);
    if (!res.data?.products?.pageInfo?.hasNextPage) break;
    after = res.data?.products?.pageInfo?.endCursor ?? null;
    if (!after) break;
  }
  return out;
}

const METAFIELD_BATCH = 15; // shopify_metafields limit is 25, productUpdate aliases lower for query size

async function setProductCollectionMetafields(
  pairs: Array<{ id: string; era: string }>,
  shop?: string,
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = [];
  let count = 0;
  for (let i = 0; i < pairs.length; i += METAFIELD_BATCH) {
    const batch = pairs.slice(i, i + METAFIELD_BATCH);
    const aliases = batch.map((p, idx) => {
      const safeId = p.id.replace(/"/g, '\\"');
      const safeEra = p.era.replace(/"/g, '\\"');
      return `m${idx}: productUpdate(product: {
        id: "${safeId}",
        metafields: [{ namespace: "product", key: "collection", value: "${safeEra}", type: "single_line_text_field" }]
      }) { userErrors { field message } }`;
    }).join("\n");
    try {
      const res = await shopifyGraphQL<Record<string, { userErrors?: Array<{ message: string }> }>>(`mutation { ${aliases} }`, undefined, shop);
      for (let j = 0; j < batch.length; j++) {
        const errs = res.data?.[`m${j}`]?.userErrors ?? [];
        for (const e of errs) errors.push(`metafield ${batch[j].id}: ${e.message}`);
      }
      count += batch.length;
    } catch (e) {
      errors.push(`metafield batch ${i}–${i + batch.length}: ${(e as Error).message}`);
    }
  }
  return { count, errors };
}

interface MenuItem {
  id?: string;
  title: string;
  type: string;
  url?: string;
  resourceId?: string | null;
  tags?: string[];
  items?: MenuItem[];
}

/** Recursively strip falsy `id` and `url` fields so menuUpdate accepts new items. */
function sanitizeMenuItems(items: MenuItem[]): MenuItem[] {
  return items.map(it => {
    const out: MenuItem = { title: it.title, type: it.type };
    if (it.id) out.id = it.id;
    if (it.url) out.url = it.url;
    if (it.resourceId) out.resourceId = it.resourceId;
    if (it.tags) out.tags = it.tags;
    if (it.items?.length) out.items = sanitizeMenuItems(it.items);
    return out;
  });
}

interface MenuFull {
  id: string;
  title: string;
  handle: string;
  items: MenuItem[];
}

async function getMenu(menuId: string, shop?: string): Promise<MenuFull | null> {
  const res = await shopifyGraphQL<{ menu?: MenuFull }>(
    `query($id: ID!) {
      menu(id: $id) {
        id title handle
        items {
          id title type url resourceId tags
          items {
            id title type url resourceId tags
            items { id title type url resourceId tags }
          }
        }
      }
    }`,
    { id: menuId },
    shop,
  );
  return res.data?.menu ?? null;
}

function findMenuItem(items: MenuItem[] | undefined, predicate: (item: MenuItem) => boolean): MenuItem | null {
  if (!items) return null;
  for (const it of items) {
    if (predicate(it)) return it;
    const sub = findMenuItem(it.items, predicate);
    if (sub) return sub;
  }
  return null;
}

// Minimal patch helpers (mirrors gateway2.ts applyPatches but inlined).
type PatchOp =
  | { op: "add"; parentId?: string; parentTitle?: string; position?: number; items: MenuItem[] }
  | { op: "update"; id?: string; title?: string; fields: Record<string, unknown> };

function findItemInTree(items: MenuItem[], title?: string, id?: string): { parent: MenuItem[]; index: number } | null {
  for (let i = 0; i < items.length; i++) {
    if ((id && items[i].id === id) || (title && items[i].title === title)) return { parent: items, index: i };
    if (items[i].items?.length) {
      const found = findItemInTree(items[i].items!, title, id);
      if (found) return found;
    }
  }
  return null;
}

function findParentItems(items: MenuItem[], title?: string, id?: string): MenuItem[] | null {
  if (!title && !id) return items;
  for (const item of items) {
    if ((id && item.id === id) || (title && item.title === title)) {
      if (!item.items) item.items = [];
      return item.items;
    }
    if (item.items?.length) {
      const found = findParentItems(item.items, title, id);
      if (found) return found;
    }
  }
  return null;
}

function applyMenuPatches(items: MenuItem[], ops: PatchOp[]): MenuItem[] {
  const tree = JSON.parse(JSON.stringify(items)) as MenuItem[];
  for (const op of ops) {
    if (op.op === "add") {
      const target = findParentItems(tree, op.parentTitle, op.parentId);
      if (!target) throw new Error(`patch parent not found: ${op.parentTitle ?? op.parentId}`);
      target.splice(op.position ?? target.length, 0, ...op.items);
    } else if (op.op === "update") {
      const found = findItemInTree(tree, op.title, op.id);
      if (!found) throw new Error(`patch item not found: ${op.title ?? op.id}`);
      Object.assign(found.parent[found.index], op.fields);
    }
  }
  return tree;
}

async function applyMenuOps(menuId: string, ops: PatchOp[], shop?: string): Promise<{ ok: boolean; error?: string }> {
  const menu = await getMenu(menuId, shop);
  if (!menu) return { ok: false, error: `menu ${menuId} not found` };
  let patched: MenuItem[];
  try {
    patched = applyMenuPatches(menu.items, ops);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const res = await shopifyGraphQL<{ menuUpdate?: { userErrors?: Array<{ message: string }> } }>(
    `mutation($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
        userErrors { message }
      }
    }`,
    { id: menu.id, title: menu.title, handle: menu.handle, items: sanitizeMenuItems(patched) },
    shop,
  );
  const errs = res.data?.menuUpdate?.userErrors ?? [];
  if (errs.length) return { ok: false, error: errs.map(e => e.message).join("; ") };
  return { ok: true };
}

/** Look up existing collection IDs by handle prefix. */
async function findCollectionsByHandlePrefix(prefix: string, shop?: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let after: string | null = null;
  while (true) {
    const res: { data?: { collections?: { edges?: Array<{ cursor: string; node: { id: string; handle: string } }>; pageInfo?: { hasNextPage: boolean; endCursor: string } } } } = await shopifyGraphQL(
      `query($q: String, $after: String) {
        collections(first: 100, query: $q, after: $after) {
          edges { cursor node { id handle } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { q: `handle:${prefix}*`, after },
      shop,
    );
    const edges = res.data?.collections?.edges ?? [];
    for (const e of edges) {
      if (e.node.handle.startsWith(prefix)) map.set(e.node.handle, e.node.id);
    }
    if (!res.data?.collections?.pageInfo?.hasNextPage) break;
    after = res.data?.collections?.pageInfo?.endCursor ?? null;
    if (!after) break;
  }
  return map;
}

async function createSmartCollection(
  title: string,
  handle: string,
  rules: Array<{ column: string; relation: string; condition: string; conditionObjectId?: string }>,
  shop?: string,
): Promise<{ id?: string; error?: string }> {
  const ruleStrs = rules.map(r =>
    `{ column: ${r.column}, relation: ${r.relation}, condition: ${JSON.stringify(r.condition)}${r.conditionObjectId ? `, conditionObjectId: "${r.conditionObjectId}"` : ""} }`
  );
  const res = await shopifyGraphQL<{ collectionCreate?: { collection?: { id: string }; userErrors?: Array<{ message: string }> } }>(
    `mutation {
      collectionCreate(input: {
        title: ${JSON.stringify(title)},
        handle: ${JSON.stringify(handle)},
        sortOrder: CREATED_DESC,
        ruleSet: { appliedDisjunctively: false, rules: [${ruleStrs.join(", ")}] }
      }) {
        collection { id }
        userErrors { message }
      }
    }`,
    undefined,
    shop,
  );
  const errs = res.data?.collectionCreate?.userErrors ?? [];
  if (errs.length) return { error: errs.map(e => e.message).join("; ") };
  return { id: res.data?.collectionCreate?.collection?.id };
}

/** Publish many resources to all sales channels in one batched mutation. */
async function bulkPublishResources(resourceIds: string[], shop?: string): Promise<{ errors: string[] }> {
  if (resourceIds.length === 0) return { errors: [] };
  const pubIds = await getAllPublicationIds(shop);
  if (pubIds.length === 0) return { errors: ["no publications found"] };
  const pubInputs = pubIds.map(p => `{publicationId: "${p}"}`).join(", ");
  const errors: string[] = [];
  // Batch ~30 resources per mutation.
  for (let i = 0; i < resourceIds.length; i += 30) {
    const batch = resourceIds.slice(i, i + 30);
    const aliases = batch.map((id, idx) => {
      const safe = id.replace(/"/g, '\\"');
      return `pub${idx}: publishablePublish(id: "${safe}", input: [${pubInputs}]) { userErrors { message } }`;
    }).join("\n");
    try {
      const res = await shopifyGraphQL<Record<string, { userErrors?: Array<{ message: string }> }>>(`mutation { ${aliases} }`, undefined, shop);
      for (let j = 0; j < batch.length; j++) {
        const e = res.data?.[`pub${j}`]?.userErrors ?? [];
        for (const err of e) errors.push(`publish ${batch[j]}: ${err.message}`);
      }
    } catch (e) {
      errors.push(`publish batch: ${(e as Error).message}`);
    }
  }
  return { errors };
}

async function createRedirect(path: string, target: string, shop?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await shopifyGraphQL<{ urlRedirectCreate?: { userErrors?: Array<{ message: string }> } }>(
    `mutation { urlRedirectCreate(urlRedirect: { path: ${JSON.stringify(path)}, target: ${JSON.stringify(target)} }) { userErrors { message } } }`,
    undefined,
    shop,
  );
  const errs = res.data?.urlRedirectCreate?.userErrors ?? [];
  if (errs.length) {
    const msg = errs.map(e => e.message).join("; ");
    if (/already exists|taken/i.test(msg)) return { ok: true }; // idempotent
    return { ok: false, error: msg };
  }
  return { ok: true };
}

async function bulkRetireBrand(args: { vendor: string; eraConsolidations?: Record<string, string>; dryRun?: boolean; phase?: "all" | "products" | "collections" | "menus" }, shop?: string): Promise<BulkBrandReport> {
  const { vendor, eraConsolidations = {}, dryRun = false, phase = "all" } = args;
  const runProducts = phase === "all" || phase === "products";
  const runCollections = phase === "all" || phase === "collections";
  const runMenus = phase === "all" || phase === "menus";
  const report: BulkBrandReport = {
    vendor,
    totalProducts: 0,
    activeProducts: 0,
    archivedProducts: 0,
    unknownEra: 0,
    metafieldsSet: 0,
    retired: { processed: 0, errors: [] },
    collectionsCreated: [],
    collectionsSkipped: [],
    menuItemsUpdated: 0,
    retiredShadesItemAdded: false,
    retiredShadesCollectionsMenuUpdated: false,
    redirectsCreated: 0,
    warnings: [],
  };

  // 1. Fetch all products.
  const products = await fetchAllBrandProducts(vendor, shop);
  report.totalProducts = products.length;
  report.activeProducts = products.filter(p => p.status === "ACTIVE").length;
  report.archivedProducts = products.filter(p => p.status === "ARCHIVED").length;

  // 2. Group by era.
  const byEra = new Map<string, { active: string[]; archived: string[] }>();
  const productEra = new Map<string, string>();
  for (const p of products) {
    const era = extractEra(p.tags, eraConsolidations);
    if (!era) {
      report.unknownEra++;
      continue;
    }
    productEra.set(p.id, era);
    if (!byEra.has(era)) byEra.set(era, { active: [], archived: [] });
    const bucket = byEra.get(era)!;
    if (p.status === "ACTIVE") bucket.active.push(p.id);
    else if (p.status === "ARCHIVED") bucket.archived.push(p.id);
  }

  if (dryRun) {
    report.warnings.push("dryRun: no writes performed");
    report.warnings.push(`would set product.collection metafield on ${productEra.size} products`);
    report.warnings.push(`would retire ${products.filter(p => p.status === "ARCHIVED").length} archived products`);
    report.warnings.push(`would create up to ${byEra.size + 1} collections (${byEra.size} eras + 1 brand retired)`);
    return report;
  }

  // 3. Set product.collection metafield on all products with known era.
  if (runProducts) {
    const metafieldPairs = Array.from(productEra.entries()).map(([id, era]) => ({ id, era }));
    const metafieldRes = await setProductCollectionMetafields(metafieldPairs, shop);
    report.metafieldsSet = metafieldRes.count;
    report.warnings.push(...metafieldRes.errors.slice(0, 5));

    // 4. Retire archived products.
    const archivedIds = products.filter(p => p.status === "ARCHIVED").map(p => p.id);
    report.retired = await retireProducts(archivedIds, shop);
  }

  if (!runCollections && !runMenus) return report;

  // 5. Create per-era smart collections + brand retired collection.
  // Parallelized in chunks of 5 to stay within Shopify rate limits + timeout budget.
  const brandHandle = slugify(vendor);
  const existing = await findCollectionsByHandlePrefix(brandHandle, shop);
  const eraToCollectionId = new Map<string, string>();
  const newlyCreatedIds: string[] = [];

  const erasToCreate: Array<{ era: string; handle: string; isActive: boolean }> = [];
  for (const [era, bucket] of byEra) {
    const handle = `${brandHandle}-${slugify(era)}`;
    const existingId = existing.get(handle);
    if (existingId) {
      report.collectionsSkipped.push({ handle, reason: "already exists" });
      eraToCollectionId.set(era, existingId);
      continue;
    }
    erasToCreate.push({ era, handle, isActive: bucket.active.length > 0 });
  }


  const brandRetiredHandle = `${brandHandle}-retired-shades`;
  let brandRetiredId = existing.get(brandRetiredHandle);

  if (runCollections) {
    const PARALLEL = 5;
    for (let i = 0; i < erasToCreate.length; i += PARALLEL) {
      const chunk = erasToCreate.slice(i, i + PARALLEL);
      const results = await Promise.all(chunk.map(c => {
        const rules: Array<{ column: string; relation: string; condition: string; conditionObjectId?: string }> = [
          { column: "VENDOR", relation: "EQUALS", condition: vendor },
          { column: "PRODUCT_METAFIELD_DEFINITION", relation: "EQUALS", condition: c.era, conditionObjectId: PRODUCT_COLLECTION_METAFIELD_DEF_GID },
        ];
        if (c.isActive) rules.push({ column: "TAG", relation: "NOT_EQUALS", condition: RETIRED_TAG });
        return createSmartCollection(`${vendor} - ${c.era}`, c.handle, rules, shop)
          .then(r => ({ ...c, ...r }));
      }));
      for (const r of results) {
        if (r.error) {
          report.warnings.push(`create ${r.handle}: ${r.error}`);
          continue;
        }
        if (r.id) {
          eraToCollectionId.set(r.era, r.id);
          newlyCreatedIds.push(r.id);
          report.collectionsCreated.push({ handle: r.handle, era: r.era, mode: r.isActive ? "active" : "retired" });
        }
      }
    }

    if (!brandRetiredId) {
      const created = await createSmartCollection(
        `${vendor} - Retired Shades`,
        brandRetiredHandle,
        [
          { column: "VENDOR", relation: "EQUALS", condition: vendor },
          { column: "TAG", relation: "EQUALS", condition: RETIRED_TAG },
        ],
        shop,
      );
      if (created.id) {
        brandRetiredId = created.id;
        newlyCreatedIds.push(created.id);
        report.collectionsCreated.push({ handle: brandRetiredHandle, era: "(retired)", mode: "brand" });
      } else if (created.error) {
        report.warnings.push(`create ${brandRetiredHandle}: ${created.error}`);
      }
    } else {
      report.collectionsSkipped.push({ handle: brandRetiredHandle, reason: "already exists" });
    }

    if (newlyCreatedIds.length) {
      const pubRes = await bulkPublishResources(newlyCreatedIds, shop);
      report.warnings.push(...pubRes.errors.slice(0, 5));
    }
  }

  if (!runMenus) return report;

  // 6. Patch Main Drop Down: find brand parent menu item, update each filter-URL child.
  const menu = await getMenu(MAIN_DROP_DOWN_MENU_GID, shop);
  if (!menu) {
    report.warnings.push("Main Drop Down menu not found");
    return report;
  }
  const brandParent = findMenuItem(menu.items, it => it.url === `/collections/${brandHandle}`);
  if (!brandParent) {
    report.warnings.push(`brand parent menu item /collections/${brandHandle} not found in Main Drop Down`);
  } else {
    const ops: Array<Record<string, unknown>> = [];
    const redirectsToCreate: Array<{ path: string; target: string }> = [];
    for (const child of brandParent.items ?? []) {
      const childTags = child.tags ?? [];
      if (childTags.length === 0) continue;
      const tagMatch = childTags[0].match(/^Collection_(.+)$/i) ?? childTags[0].match(/^collection_(.+)$/i);
      if (!tagMatch) continue;
      const era = eraConsolidations[tagMatch[1].trim()] ?? tagMatch[1].trim();
      // Try direct era match first, then fall back to handle-based lookup (handles casing variations
      // between menu tag and product tag, e.g., "Abandon the Ordinary" vs "Abandon The Ordinary").
      const handleByEra = `${brandHandle}-${slugify(era)}`;
      const newCollectionId = eraToCollectionId.get(era) ?? existing.get(handleByEra);
      if (!newCollectionId) {
        report.warnings.push(`menu item "${child.title}": no new collection found for era "${era}" (tried handle ${handleByEra})`);
        continue;
      }
      ops.push({
        op: "update",
        id: child.id,
        fields: { type: "COLLECTION", resourceId: newCollectionId, tags: [] },
      });
      const newHandle = `${brandHandle}-${slugify(era)}`;
      if (child.url) redirectsToCreate.push({ path: child.url, target: `/collections/${newHandle}` });
    }
    // Add Retired Shades item if not already present.
    const hasRetiredItem = (brandParent.items ?? []).some(it => it.title === "Retired Shades");
    if (!hasRetiredItem && brandRetiredId) {
      ops.push({
        op: "add",
        parentTitle: brandParent.title,
        items: [{ title: "Retired Shades", type: "COLLECTION", resourceId: brandRetiredId }],
      });
      report.retiredShadesItemAdded = true;
    }
    if (ops.length) {
      const patchRes = await applyMenuOps(MAIN_DROP_DOWN_MENU_GID, ops as PatchOp[], shop);
      if (patchRes.ok) {
        report.menuItemsUpdated = ops.length;
      } else {
        report.warnings.push(`Main Drop Down menu patch failed: ${patchRes.error}`);
      }
      for (const r of redirectsToCreate) {
        const rr = await createRedirect(r.path, r.target, shop);
        if (rr.ok) report.redirectsCreated++;
        else report.warnings.push(`redirect ${r.path}: ${rr.error}`);
      }
    }
  }

  // 7. retired-shades-collections menu — append brand under root if not already present.
  const rsMenu = await getMenu(RETIRED_SHADES_COLLECTIONS_MENU_GID, shop);
  if (!rsMenu) {
    report.warnings.push("retired-shades-collections menu not found");
  } else {
    const root = rsMenu.items.find(it => it.title === "Retired Shades");
    const alreadyHas = (root?.items ?? []).some(it => it.title === vendor || it.resourceId === brandRetiredId);
    if (!alreadyHas && brandRetiredId) {
      const patchRes = await applyMenuOps(
        RETIRED_SHADES_COLLECTIONS_MENU_GID,
        [{ op: "add", parentTitle: "Retired Shades", items: [{ id: "", title: vendor, type: "COLLECTION", url: "", resourceId: brandRetiredId, tags: [] }] }],
        shop,
      );
      if (patchRes.ok) report.retiredShadesCollectionsMenuUpdated = true;
      else report.warnings.push(`retired-shades-collections menu patch failed: ${patchRes.error}`);
    } else {
      report.retiredShadesCollectionsMenuUpdated = true;
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

export function registerRetireTool(server: McpServer): void {
  server.tool(
    "nailstuff_retire",
    `Retire products and migrate brands to the metafield-based collection pattern.

Actions:
- products: retire specific products (apply theme.label badge, retired tag, retired-shade template, status ACTIVE, publish to all sales channels). Targets either {productIds[]} or {vendor + era}. Idempotent.
- bulk_brand: full brand migration. Paginates all products, sets product.collection metafield, retires archived products, creates per-era smart collections + {Brand} - Retired Shades, identifies menu patches needed (returns ops for the caller to apply via shopify_navigation.patch_menu since menu structure varies). Use eraConsolidations to merge variants like {"PPU Rewind": "Polish Pickup Rewind"}. dryRun:true returns plan without writes.

Returns a structured report.`,
    {
      action: z.enum(["products", "bulk_brand"]),
      productIds: z.array(z.string()).optional(),
      vendor: z.string().optional(),
      era: z.string().optional(),
      eraConsolidations: z.record(z.string(), z.string()).optional(),
      dryRun: z.boolean().optional(),
      phase: z.enum(["all", "products", "collections", "menus"]).optional().describe("bulk_brand: split work into phases if 'all' times out. products=metafields+retire, collections=create+publish, menus=patch nav + redirects. Each phase is idempotent."),
    },
    async ({ action, productIds, vendor, era, eraConsolidations, dryRun, phase }) => {
      try {
        if (action === "products") {
          let ids = productIds ?? [];
          if (ids.length === 0) {
            if (!vendor || !era) return fail("provide either productIds[] or {vendor, era}");
            ids = await findProductIdsByVendorAndEra(vendor, era);
          }
          const report = await retireProducts(ids);
          return text(report);
        }
        if (action === "bulk_brand") {
          if (!vendor) return fail("vendor required for bulk_brand");
          const report = await bulkRetireBrand({ vendor, eraConsolidations, dryRun, phase });
          return text(report);
        }
        return fail(`unknown action: ${action}`);
      } catch (e) {
        return fail(`nailstuff_retire failed: ${(e as Error).message}`);
      }
    },
  );
}
