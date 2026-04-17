import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, getShopCredentials } from "../../config.js";
import { shopifyGraphQL, toText } from "../../shopify/client.js";

export function registerShopTools(server: McpServer): void {
  // --- List Available Shops ---
  server.tool(
    "list_shops",
    "List all connected Shopify stores available to this MCP server.",
    {},
    async () => {
      const shops = [...config.shops.keys()].map((domain) => ({
        domain,
        isDefault: domain === config.defaultShop,
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

  // --- Get Shop Info ---
  server.tool(
    "get_shop_info",
    "Get details about a connected Shopify store (name, domain, plan, currency, etc.).",
    {
      shop: z.string().optional().describe("Shop domain (e.g. my-store.myshopify.com). Omit for default shop."),
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
