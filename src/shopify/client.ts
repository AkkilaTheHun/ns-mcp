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

  const json = (await res.json()) as GraphQLResponse<T>;

  // Throw on top-level GraphQL errors (schema errors, auth errors, etc.)
  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e) => e.message);
    throw new Error(`Shopify GraphQL error:\n${messages.join("\n")}`);
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
    throw new Error(`${operation} failed:\n${messages.join("\n")}`);
  }
}

/**
 * Safely serialize data for MCP text content — never returns undefined.
 */
export function toText(data: unknown): string {
  return JSON.stringify(data, null, 2) ?? "null";
}
