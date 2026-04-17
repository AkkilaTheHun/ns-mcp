import "dotenv/config";

export const config = {
  // Shopify
  shopifyApiKey: process.env.SHOPIFY_API_KEY ?? "",
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET ?? "",
  shopDomain: process.env.SHOP_DOMAIN ?? "",
  shopifyAccessToken: process.env.SHOPIFY_ACCESS_TOKEN ?? "",
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-07",

  // MCP Server
  mcpAuthToken: process.env.MCP_AUTH_TOKEN ?? "",
  port: parseInt(process.env.PORT ?? "3000", 10),

  // Derived
  get hostUrl(): string {
    return process.env.HOST_URL ?? `http://localhost:${this.port}`;
  },
} as const;
