import { config, getShopCredentials } from "../config.js";
import { getCurrentSessionId } from "../context.js";
import { getSessionShop } from "../session.js";

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; locations?: Array<{ line: number; column: number }> }>;
  extensions?: Record<string, unknown>;
}

/**
 * Lightweight Shopify Admin GraphQL client.
 * Supports multi-shop: pass a shopDomain to target a specific store,
 * or omit to use the default shop.
 */
export async function shopifyGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  shopDomain?: string,
): Promise<GraphQLResponse<T>> {
  // Resolve shop: explicit param > session selection > default
  let resolvedDomain = shopDomain;
  if (!resolvedDomain) {
    const sessionId = getCurrentSessionId();
    if (sessionId) {
      resolvedDomain = getSessionShop(sessionId);
    }
  }
  const shop = getShopCredentials(resolvedDomain);
  const url = `https://${shop.domain}/admin/api/${config.shopifyApiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shop.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[shopify] ${shop.domain} HTTP ${res.status}: ${body.slice(0, 500)}`);
    throw new Error(`Shopify API error (${shop.domain}): ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;

  // Throw on top-level GraphQL errors (schema errors, auth errors, etc.)
  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e) => e.message);
    console.error(`[shopify] ${shop.domain} GraphQL errors:`, messages);
    throw new Error(`Shopify GraphQL error (${shop.domain}):\n${messages.join("\n")}`);
  }

  return json;
}

/**
 * Helper that throws on GraphQL userErrors.
 */
export function throwIfUserErrors(
  userErrors: Array<{ field?: string[]; message: string }> | undefined | null,
  operation: string,
): void {
  if (userErrors && userErrors.length > 0) {
    const messages = userErrors.map(
      (e) => `${e.field?.join(".") ?? "unknown"}: ${e.message}`,
    );
    console.error(`[shopify] ${operation} userErrors:`, messages);
    throw new Error(`${operation} failed:\n${messages.join("\n")}`);
  }
}

/**
 * Safely serialize data for MCP text content — never returns undefined.
 */
export function toText(data: unknown): string {
  return JSON.stringify(data, null, 2) ?? "null";
}
