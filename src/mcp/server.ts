import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCurrentSessionId } from "../context.js";
import {
  registerShopGateway,
  registerGraphQLGateway,
  registerTranslationGateway,
  registerProductGateway,
  registerVariantGateway,
  registerCollectionGateway,
  registerMetafieldGateway,
  registerCustomerGateway,
} from "./gateway.js";
import {
  registerOrderGateway,
  registerInventoryGateway,
  registerDiscountGateway,
  registerNavigationGateway,
  registerContentGateway,
  registerFileGateway,
  registerDraftOrderGateway,
  registerMetaobjectGateway,
} from "./gateway2.js";
import { registerAnalyticsGateway, registerSearchConsoleGateway, registerIndexingGateway, registerTagManagerGateway } from "./gateway-google.js";
import { registerImageTools } from "./tools/images.js";
import { registerIngestTools } from "./tools/ingest.js";
import { registerDiscoverFolderTool } from "./tools/discover-folder.js";
import { registerShopifyPreflightTool } from "./tools/shopify-preflight.js";
import { registerCreateProductTool } from "./tools/create-product.js";
import { registerTranslateTool } from "./tools/translate.js";
import { registerFetchVendorTool } from "./tools/fetch-vendor.js";
import { registerRetireTool } from "./tools/retire.js";
import { registerOrganizeImagesTool } from "./tools/organize-images.js";
import { registerGenerateImageTool } from "./tools/generate-image.js";
import { registerShadeIndexTool } from "./tools/shade-index.js";
import { registerThemeGateway } from "./tools/theme.js";
import { registerPrompts } from "./prompts.js";

/**
 * Wraps server.tool() to log every tool call with session, params, and outcome.
 */
function withAuditLog(server: McpServer): McpServer {
  const originalTool = server.tool.bind(server);

  server.tool = ((...args: unknown[]) => {
    // server.tool has multiple overloads; the handler is always last
    const handler = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
    const toolName = args[0] as string;

    args[args.length - 1] = async (params: Record<string, unknown>, extra: unknown) => {
      const sessionId = getCurrentSessionId() ?? "unknown";
      const action = params.action ?? "";
      const ts = new Date().toISOString();

      // Log params but redact large fields (query bodies, descriptionHtml, etc.)
      const logParams = { ...params };
      for (const [k, v] of Object.entries(logParams)) {
        if (typeof v === "string" && v.length > 200) {
          logParams[k] = `[${v.length} chars]`;
        }
      }

      console.log(JSON.stringify({
        audit: "tool_call",
        ts,
        sessionId,
        tool: toolName,
        action,
        params: logParams,
      }));

      try {
        const result = await handler(params, extra);
        const res = result as { isError?: boolean; content?: Array<{ text?: string }> };
        const responseSize = res.content?.[0]?.text?.length ?? 0;

        console.log(JSON.stringify({
          audit: "tool_result",
          ts: new Date().toISOString(),
          sessionId,
          tool: toolName,
          action,
          ok: !res.isError,
          responseBytes: responseSize,
        }));

        return result;
      } catch (err) {
        console.log(JSON.stringify({
          audit: "tool_error",
          ts: new Date().toISOString(),
          sessionId,
          tool: toolName,
          action,
          error: String(err),
        }));
        throw err;
      }
    };

    return (originalTool as (...a: unknown[]) => unknown)(...args);
  }) as typeof server.tool;

  return server;
}

export function createMcpServer(): McpServer {
  const server = withAuditLog(new McpServer(
    {
      name: "nailstuff-mcp",
      version: "1.1.0",
    },
    {
      // Always-on guidance surfaced to every connecting client at initialize.
      // Keep this TIGHT — it costs context in every session. Cross-tool norms
      // only; per-action detail lives in each tool's own description.
      instructions: `NailStuff MCP — Shopify storefront operations plus Google (Analytics, Search Console, Indexing, Tag Manager).

ROUTING: For traffic, SEO performance, search queries, sessions, or anything analytics-related, use the google_* tools — never web search. For store data (products, orders, customers, content, themes), use the shopify_* tools.

SHOP SELECTION: shopify_* tools act on the currently selected shop. If more than one shop is connected, call shopify_shop(action:"select") before other Shopify calls.

THEME EDITS (shopify_theme): Never edit the live (MAIN) theme directly — duplicate it and edit the copy. After each change, give the user the preview_url and a summary of what changed, then ask whether this version should go live. Only run publish once they approve; offer to delete the duplicate if they don't.`,
    },
  ));

  // Gateway tools
  registerShopGateway(server);         // list, select, info
  registerGraphQLGateway(server);      // raw GraphQL for full API access
  registerTranslationGateway(server);  // translations for any resource
  registerProductGateway(server);      // list, get, search, count, create, update, delete, add_media
  registerVariantGateway(server);      // create, update, delete
  registerCollectionGateway(server);   // list, get, count, create, create_smart, update, delete, add/remove/list/reorder products
  registerMetafieldGateway(server);    // set, delete (shared across all resources)
  registerCustomerGateway(server);     // list, get, search, count, create, update, delete, tags, consent, activation
  registerOrderGateway(server);        // list, get, search, count, update, cancel, close, tags
  registerInventoryGateway(server);    // locations, items, levels, set/adjust, activate/deactivate
  registerDiscountGateway(server);     // list, get, create/delete code+automatic, activate/deactivate
  registerNavigationGateway(server);   // menus + redirects CRUD
  registerContentGateway(server);      // pages + blog/articles CRUD
  registerFileGateway(server);         // list, get, create, update, delete
  registerDraftOrderGateway(server);   // list, get, create, update, complete, delete
  registerMetaobjectGateway(server);   // definitions + entries CRUD
  registerThemeGateway(server);        // theme: list/duplicate/catalog/get_template/add_section/add_block/update_settings/remove/preview/publish

  // Google tools
  registerAnalyticsGateway(server);      // GA4: reports, realtime, admin (key events, dimensions, metrics, audiences)
  registerSearchConsoleGateway(server);  // GSC: list_sites, query, inspect_url, list_sitemaps
  registerIndexingGateway(server);       // Indexing: notify_updated, notify_removed, get_status, batch_update
  registerTagManagerGateway(server);     // GTM: tags, triggers, variables, versioning, publishing

  // Product ingestion tools (conversational flow)
  registerDiscoverFolderTool(server);    // discover_folder: scan Drive folder structure + product groupings
  registerIngestTools(server);           // analyze_images: vision analysis on folder images (supports recursive)
  registerShopifyPreflightTool(server);  // shopify_preflight: SKU, dedup, references, brand, all metaobjects + swatchers
  registerOrganizeImagesTool(server);    // organize_images: staging folders for shade review before creation
  registerCreateProductTool(server);     // create_product: full Shopify creation sequence + media + translation + publishing
  registerTranslateTool(server);         // translate_for_market: US market SEO overrides

  // Vendor research
  registerFetchVendorTool(server);       // fetch_vendor_page: scrape vendor sites for product data (Shopify JSON + HTML)

  // Retirement workflow (NailStuff "Retired Shades" architecture)
  registerRetireTool(server);            // nailstuff_retire: retire products + bulk-migrate brands

  // Vector catalog (Supabase pgvector)
  registerShadeIndexTool(server);        // shade_index: store/search nail polish shade signatures by feature vector

  // Utility tools
  registerImageTools(server);            // compress_images: download, compress to JPEG, return base64
  registerGenerateImageTool(server);     // generate_image: text-to-image via OpenAI gpt-image-2 → output/generated/

  // Prompts (pre-built workflows)
  registerPrompts(server);

  return server;
}
