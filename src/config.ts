import "dotenv/config";

export interface ShopCredentials {
  domain: string;
  accessToken: string;
}

/**
 * Parse SHOPS env var. Supports two formats:
 * - JSON object: {"store.myshopify.com": "shpat_xxx", "store2.myshopify.com": "shpat_yyy"}
 * - Legacy single-shop: SHOP_DOMAIN + SHOPIFY_ACCESS_TOKEN env vars
 */
function parseShops(): Map<string, string> {
  const shops = new Map<string, string>();

  // JSON format
  const shopsJson = process.env.SHOPS;
  if (shopsJson) {
    try {
      const parsed = JSON.parse(shopsJson) as Record<string, string>;
      for (const [domain, token] of Object.entries(parsed)) {
        shops.set(domain, token);
      }
    } catch {
      console.error("Failed to parse SHOPS env var as JSON");
    }
  }

  // Legacy single-shop fallback
  const legacyDomain = process.env.SHOP_DOMAIN;
  const legacyToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (legacyDomain && legacyToken && !shops.has(legacyDomain)) {
    shops.set(legacyDomain, legacyToken);
  }

  return shops;
}

const shops = parseShops();

export const config = {
  // Shopify
  shopifyApiKey: process.env.SHOPIFY_API_KEY ?? "",
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET ?? "",
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-07",

  // Multi-shop
  shops,
  get defaultShop(): string | undefined {
    return shops.keys().next().value;
  },

  // MCP Server
  mcpAuthToken: process.env.MCP_AUTH_TOKEN ?? "",
  port: parseInt(process.env.PORT ?? "3000", 10),

  // OAuth 2.0 for MCP clients (ChatGPT, etc.)
  oauthClientId: process.env.OAUTH_CLIENT_ID ?? "",
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET ?? "",

  // Derived
  get hostUrl(): string {
    return process.env.HOST_URL ?? `http://localhost:${this.port}`;
  },
} as const;

/**
 * Get credentials for a shop. Throws if shop not found.
 * When multiple shops are configured, requires explicit selection — no silent fallback.
 */
export function getShopCredentials(shopDomain?: string): ShopCredentials {
  // Explicit shop requested
  if (shopDomain) {
    const token = config.shops.get(shopDomain);
    if (!token) {
      const available = [...config.shops.keys()].join(", ");
      throw new Error(`Shop "${shopDomain}" not found. Available shops: ${available || "none"}`);
    }
    return { domain: shopDomain, accessToken: token };
  }

  // No shop specified — only allow implicit default if there's exactly one shop
  if (config.shops.size === 0) {
    throw new Error("No shops configured. Set SHOPS env var.");
  }

  if (config.shops.size === 1) {
    const [domain, token] = [...config.shops.entries()][0]!;
    return { domain, accessToken: token };
  }

  // Multiple shops — refuse to guess
  const available = [...config.shops.keys()].join(", ");
  throw new Error(`Multiple shops available (${available}). Use shopify_shop(action: "select") to choose one first.`);
}
