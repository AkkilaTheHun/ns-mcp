import { config } from "../config.js";

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; locations?: Array<{ line: number; column: number }> }>;
  extensions?: Record<string, unknown>;
}

/**
 * Lightweight Shopify Admin GraphQL client.
 * Uses the REST-based GraphQL endpoint with the offline access token.
 */
export async function shopifyGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const url = `https://${config.shopDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.shopifyAccessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<GraphQLResponse<T>>;
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
    throw new Error(`${operation} failed:\n${messages.join("\n")}`);
  }
}
