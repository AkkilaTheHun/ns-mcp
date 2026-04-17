import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, getShopCredentials } from "../../config.js";
import { shopifyGraphQL, toText } from "../../shopify/client.js";
import { getCurrentSessionId } from "../../context.js";
import { getSessionShop, setSessionShop } from "../../session.js";

export function registerShopTools(server: McpServer): void {
  // --- List Available Shops ---
  server.tool(
    "list_shops",
    "List all connected Shopify stores available to this MCP server. Shows which shop is currently selected for this session.",
    {},
    async () => {
      const sessionId = getCurrentSessionId();
      const selectedShop = sessionId ? getSessionShop(sessionId) : undefined;

      const shops = [...config.shops.keys()].map((domain) => ({
        domain,
        isDefault: domain === config.defaultShop,
        isSelected: domain === selectedShop,
      }));

      if (shops.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No shops configured. Set the SHOPS env var or install the app via /auth?shop=YOUR-STORE.myshopify.com" }],
          isError: true,
        };
      }

      return { content: [{ type: "text" as const, text: toText(shops) }] };
    },
  );

  // --- Select Shop ---
  server.tool(
    "select_shop",
    "Select which Shopify store to use for all subsequent tool calls in this session. Use list_shops to see available stores.",
    {
      shop: z.string().describe("Shop domain to select (e.g. nailstuff-dev.myshopify.com)"),
    },
    async ({ shop }) => {
      // Validate the shop exists
      try {
        getShopCredentials(shop);
      } catch (err) {
        return { content: [{ type: "text" as const, text: String(err) }], isError: true };
      }

      const sessionId = getCurrentSessionId();
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: No active session" }], isError: true };
      }

      setSessionShop(sessionId, shop);
      return { content: [{ type: "text" as const, text: `Selected shop: ${shop}. All subsequent tool calls will target this store.` }] };
    },
  );

  // --- Get Shop Info ---
  server.tool(
    "get_shop_info",
    "Get details about the currently selected Shopify store (name, domain, plan, currency, etc.).",
    {
      shop: z.string().optional().describe("Shop domain override. Omit to use selected/default shop."),
    },
    async ({ shop }) => {
      const res = await shopifyGraphQL<{ shop: unknown }>(`
        query ShopInfo {
          shop {
            id
            name
            myshopifyDomain
            primaryDomain { host url }
            plan { displayName partnerDevelopment shopifyPlus }
            currencyCode
            weightUnit
            timezoneAbbreviation
            ianaTimezone
            contactEmail
            createdAt
          }
        }
      `, undefined, shop);

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );
}
