/**
 * translate_for_market — US market translation override tool.
 *
 * Registered as an MCP tool (standalone for SEO backfill) and exported
 * as a callable function for create_product step 7.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors } from "../../shopify/client.js";
import { getCurrentSessionId } from "../../context.js";
import { getSessionShop } from "../../session.js";
import { config } from "../../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranslationResult {
  resourceId: string;
  registered: Array<{ key: string; value: string; verified: boolean }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Key mapping
// ---------------------------------------------------------------------------

const FIELD_KEY_MAP: Record<string, string> = {
  metaTitle: "meta_title",
  metaDescription: "meta_description",
  bodyHtml: "body_html",
};

// ---------------------------------------------------------------------------
// Core function (used by both MCP tool and create_product)
// ---------------------------------------------------------------------------

export async function registerTranslation(
  resourceId: string,
  marketId: string,
  translations: { metaTitle?: string; metaDescription?: string; bodyHtml?: string },
  shop?: string,
): Promise<TranslationResult> {
  const warnings: string[] = [];

  // Build the list of fields to translate
  const fields: Array<{ key: string; value: string }> = [];
  for (const [field, value] of Object.entries(translations)) {
    if (value === undefined) continue;
    const shopifyKey = FIELD_KEY_MAP[field];
    if (!shopifyKey) {
      warnings.push(`Unknown field "${field}" skipped`);
      continue;
    }
    fields.push({ key: shopifyKey, value });
  }

  if (fields.length === 0) {
    return { resourceId, registered: [], warnings: ["No translation fields provided"] };
  }

  // Step 1: Fetch digests
  const digestRes = await shopifyGraphQL<{
    translatableResource: {
      translatableContent: Array<{ key: string; digest: string }>;
    } | null;
  }>(
    `query($resourceId: ID!) {
      translatableResource(resourceId: $resourceId) {
        translatableContent { key digest }
      }
    }`,
    { resourceId },
    shop,
  );

  const content = digestRes.data?.translatableResource?.translatableContent;
  if (!content) {
    return {
      resourceId,
      registered: [],
      warnings: ["Resource not found or has no translatable content"],
    };
  }

  const digestMap = new Map(content.map((c) => [c.key, c.digest]));

  // Build translation inputs
  const translationInputs = fields.map((f) => {
    const digest = digestMap.get(f.key);
    if (!digest) {
      warnings.push(`Key "${f.key}" has no digest - may not be translatable on this resource`);
    }
    return {
      locale: "en",
      key: f.key,
      value: f.value,
      translatableContentDigest: digest ?? "",
      marketId,
    };
  }).filter((t) => t.translatableContentDigest !== "");

  if (translationInputs.length === 0) {
    return { resourceId, registered: [], warnings };
  }

  // Step 2: Register translations
  const registerRes = await shopifyGraphQL<{
    translationsRegister: {
      translations: Array<{ key: string; value: string; locale: string }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation($resourceId: ID!, $translations: [TranslationInput!]!) {
      translationsRegister(resourceId: $resourceId, translations: $translations) {
        translations { key value locale market { id } }
        userErrors { field message }
      }
    }`,
    { resourceId, translations: translationInputs },
    shop,
  );

  throwIfUserErrors(
    registerRes.data?.translationsRegister?.userErrors,
    "translationsRegister",
  );

  // Step 3: Verify by re-reading
  const verifyRes = await shopifyGraphQL<{
    translatableResource: {
      translations: Array<{ key: string; value: string; locale: string }>;
    } | null;
  }>(
    `query($resourceId: ID!, $locale: String!, $marketId: ID) {
      translatableResource(resourceId: $resourceId) {
        translations(locale: $locale, marketId: $marketId) { key value locale }
      }
    }`,
    { resourceId, locale: "en", marketId },
    shop,
  );

  const verified = verifyRes.data?.translatableResource?.translations ?? [];
  const verifiedKeys = new Set(verified.map((t) => t.key));

  const registered = fields.map((f) => ({
    key: f.key,
    value: f.value,
    verified: verifiedKeys.has(f.key),
  }));

  for (const r of registered) {
    if (!r.verified) {
      warnings.push(`Translation for "${r.key}" registered but could not verify`);
    }
  }

  return { resourceId, registered, warnings };
}

// ---------------------------------------------------------------------------
// MCP Tool Registration
// ---------------------------------------------------------------------------

export function registerTranslateTool(server: McpServer): void {
  server.tool(
    "translate_for_market",
    `Register market-scoped translation overrides for a Shopify resource (product, collection, etc.).
Fetches content digests automatically, registers translations, and verifies.

Primary use: US market SEO overrides (meta_title, meta_description, body_html).
Also useful for batch SEO backfill across existing products.

US Market GID: gid://shopify/Market/2190246041`,
    {
      resourceId: z.string().describe("Shopify resource GID (e.g. gid://shopify/Product/123)"),
      marketId: z.string().describe("Target market GID (e.g. gid://shopify/Market/2190246041 for US)"),
      translations: z.object({
        metaTitle: z.string().optional().describe("SEO title override"),
        metaDescription: z.string().optional().describe("SEO meta description override"),
        bodyHtml: z.string().optional().describe("Product/collection body HTML override"),
      }),
    },
    async ({ resourceId, marketId, translations }) => {
      try {
        // Resolve shop from session
        let shop: string | undefined;
        const sessionId = getCurrentSessionId();
        if (sessionId) shop = getSessionShop(sessionId);
        if (!shop) {
          const shopDomains = [...config.shops.keys()];
          if (shopDomains.length === 1) {
            shop = shopDomains[0];
          } else if (shopDomains.length > 1) {
            const prodShops = shopDomains.filter((d) => !d.includes("-dev"));
            if (prodShops.length === 1) shop = prodShops[0];
          }
        }
        const result = await registerTranslation(resourceId, marketId, translations, shop);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Translation failed: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
