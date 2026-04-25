/**
 * shopify_preflight — All Shopify lookups needed before product creation.
 *
 * Runs in parallel server-side: SKU, dedup, config reference, style reference,
 * brand metaobject, and ALL metaobject entry lists (colors, finishes, polish types,
 * swatchers). Returns raw data for Claude to work with conversationally.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCurrentSessionId } from "../../context.js";
import { getSessionShop } from "../../session.js";
import { config } from "../../config.js";
import {
  lookupNextSku,
  checkDuplicates,
  getConfigReference,
  getStyleReference,
  findBrandMetaobject,
  listMetaobjectEntries,
  TAXONOMY_MAP,
} from "../../shopify/preflight.js";

// ---------------------------------------------------------------------------
// Shop resolution (shared pattern)
// ---------------------------------------------------------------------------

function resolveShop(): string {
  const sessionId = getCurrentSessionId();
  if (sessionId) {
    const selected = getSessionShop(sessionId);
    if (selected) return selected;
  }
  const shopDomains = [...config.shops.keys()];
  if (shopDomains.length === 1) return shopDomains[0];
  if (shopDomains.length > 1) {
    const prodShops = shopDomains.filter((d) => !d.includes("-dev"));
    if (prodShops.length === 1) return prodShops[0];
    throw new Error(`Multiple shops available (${shopDomains.join(", ")}). Use shopify_shop(action: 'select') to choose one first.`);
  }
  throw new Error("No shop configured. Check SHOPS environment variable.");
}

// ---------------------------------------------------------------------------
// MCP Tool Registration
// ---------------------------------------------------------------------------

export function registerShopifyPreflightTool(server: McpServer): void {
  server.tool(
    "shopify_preflight",
    `Run all Shopify lookups needed before creating a product. Executes in parallel:
- Next available SKU for the brand
- Duplicate detection (exact + fuzzy + catalog-wide by title)
- Configuration reference (most recent same-brand same-stock-type product)
- Style reference (3-5 most recent products catalog-wide)
- Brand metaobject lookup (by display name, fuzzy matching)
- All metaobject entry lists: colors, finishes, polish types, swatchers

Returns raw data. Use this alongside discover_folder and analyze_images
to gather everything needed before writing descriptions and building previews.`,
    {
      vendor: z.string().describe("Brand/vendor name (e.g. 'Cadillacquer', 'Chamaeleon')"),
      title: z.string().describe("Product title for dedup check (e.g. 'Blazing Evening Sky')"),
      stockType: z.enum(["preorder", "in-stock"]).describe("Determines which config reference to pull"),
    },
    async ({ vendor, title, stockType }) => {
      const startTime = Date.now();
      const warnings: string[] = [];

      let shop: string;
      try {
        shop = resolveShop();
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: String(err) }],
          isError: true,
        };
      }

      console.log(`[preflight] Starting: "${title}" by ${vendor} (${stockType}) on ${shop}`);

      // Run ALL lookups in parallel
      const [
        skuResult,
        dedupResult,
        configRefResult,
        styleRefResult,
        brandResult,
        colorsResult,
        finishesResult,
        polishTypesResult,
        swatchersResult,
      ] = await Promise.allSettled([
        lookupNextSku(vendor, shop),
        checkDuplicates(title, vendor, shop),
        getConfigReference(vendor, stockType, shop),
        getStyleReference(5, shop),
        findBrandMetaobject(vendor, shop),
        listMetaobjectEntries("shopify--color-pattern", shop),
        listMetaobjectEntries("shopify--cosmetic-finish", shop),
        listMetaobjectEntries("nailstuff_polish_type", shop),
        listMetaobjectEntries("swatcher", shop),
      ]);

      // Unwrap results
      function unwrap<T>(result: PromiseSettledResult<T>, label: string, fallback: T): T {
        if (result.status === "fulfilled") return result.value;
        warnings.push(`${label} failed: ${result.reason}`);
        console.error(`[preflight] ${label} failed:`, result.reason);
        return fallback;
      }

      const sku = unwrap(skuResult, "SKU lookup", { prefix: "???", currentMax: null, next: "NP-???-001" });
      const duplicates = unwrap(dedupResult, "Dedup check", { exact: [], fuzzy: [], catalogWide: [] });
      const configReference = unwrap(configRefResult, "Config reference", null);
      const styleReference = unwrap(styleRefResult, "Style reference", []);
      const brand = unwrap(brandResult, "Brand metaobject", null);
      const colors = unwrap(colorsResult, "Color metaobjects", []);
      const finishes = unwrap(finishesResult, "Finish metaobjects", []);
      const polishTypes = unwrap(polishTypesResult, "Polish type metaobjects", []);
      const swatchers = unwrap(swatchersResult, "Swatcher metaobjects", []);

      // Derive pricing from config reference
      let pricing: { price: string; compareAtPrice: string | null } | null = null;
      if (configReference?.variants?.[0]) {
        const v = configReference.variants[0];
        pricing = { price: v.price, compareAtPrice: v.compareAtPrice };
      }

      if (!brand) {
        warnings.push(`Brand metaobject not found for "${vendor}". May need to create one.`);
      }

      const taxonomy = TAXONOMY_MAP["nail_polish"];

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[preflight] Complete in ${elapsed}s`);

      const result = {
        shop,
        vendor,
        title,
        stockType,

        sku,
        duplicates,
        configReference,
        styleReference,
        brand,

        // Trimmed to {id, handle, displayName} to save tokens
        availableMetaobjects: {
          colors: colors.map((c) => ({ id: c.id, handle: c.handle, displayName: c.displayName })),
          finishes: finishes.map((f) => ({ id: f.id, handle: f.handle, displayName: f.displayName })),
          polishTypes: polishTypes.map((p) => ({ id: p.id, handle: p.handle, displayName: p.displayName })),
          swatchers: swatchers.map((s) => ({ id: s.id, handle: s.handle, displayName: s.displayName })),
        },

        pricing,
        taxonomy,
        processingTimeSeconds: Number(elapsed),
        warnings,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
