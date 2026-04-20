/**
 * create_product — full Shopify product creation in one call.
 *
 * Executes the complete section 20a creation sequence:
 * 1. productCreate (non-constrained metafields, SEO, tags, template)
 * 2. productUpdate (set category taxonomy GID)
 * 3. metafieldsSet (category-constrained metafields)
 * 4. productVariantsBulkUpdate (SKU, price, weight, HS code, etc.)
 * 5. productCreateMedia (Drive -> staged upload -> attach with alt text)
 * 6. Verification re-read
 * 7. US market translation (via translate_for_market)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { shopifyGraphQL, throwIfUserErrors } from "../../shopify/client.js";
import { downloadFile } from "../../google/drive.js";
import { registerTranslation } from "./translate.js";
import { getCurrentSessionId } from "../../context.js";
import { getSessionShop } from "../../session.js";
import { config } from "../../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const US_MARKET_GID = "gid://shopify/Market/2190246041";
const DEFAULT_HS_CODE = "330430";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gql<T = unknown>(query: string, variables?: Record<string, unknown>, shop?: string) {
  return shopifyGraphQL<T>(query, variables, shop);
}

function resolveShop(): string {
  const sessionId = getCurrentSessionId();
  if (sessionId) {
    const selected = getSessionShop(sessionId);
    if (selected) return selected;
  }
  const shopDomains = [...config.shops.keys()];
  if (shopDomains.length === 1) return shopDomains[0];
  if (config.defaultShop) return config.defaultShop;
  throw new Error("No shop selected. Use shopify_shop(action: 'select') to choose a shop first.");
}

function extractId(gid: string): string {
  // "gid://shopify/Product/123" -> "123"
  return gid.split("/").pop() ?? gid;
}

// ---------------------------------------------------------------------------
// Media pipeline: Drive -> Sharp -> Staged Upload -> Shopify
// ---------------------------------------------------------------------------

interface MediaItem {
  driveFileId: string;
  alt: string;
  position: number;
  filename: string;
}

async function uploadMediaToShopify(
  productId: string,
  media: MediaItem[],
  shop?: string,
): Promise<{ uploaded: number; errors: string[] }> {
  const errors: string[] = [];
  let uploaded = 0;

  for (const item of media) {
    try {
      // 1. Download from Drive
      const raw = await downloadFile(item.driveFileId);
      console.log(`[create] Downloaded ${item.filename} (${Math.round(raw.length / 1024)} KB)`);

      // 2. Compress via Sharp (production quality — preserve dimensions)
      const compressed = await sharp(raw, { failOn: "none" })
        .rotate()
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      console.log(`[create] Compressed ${item.filename}: ${Math.round(raw.length / 1024)} KB -> ${Math.round(compressed.length / 1024)} KB`);

      // 3. Create staged upload
      const stageRes = await gql<{
        stagedUploadsCreate: {
          stagedTargets: Array<{
            url: string;
            resourceUrl: string;
            parameters: Array<{ name: string; value: string }>;
          }>;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(
        `mutation($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters { name value }
            }
            userErrors { field message }
          }
        }`,
        {
          input: [{
            filename: item.filename,
            mimeType: "image/jpeg",
            httpMethod: "PUT",
            resource: "IMAGE",
            fileSize: String(compressed.length),
          }],
        },
        shop,
      );

      throwIfUserErrors(stageRes.data?.stagedUploadsCreate?.userErrors, "stagedUploadsCreate");
      const target = stageRes.data?.stagedUploadsCreate?.stagedTargets?.[0];
      if (!target) {
        errors.push(`${item.filename}: No staged upload target returned`);
        continue;
      }

      // 4. Upload to staged URL
      const uploadRes = await fetch(target.url, {
        method: "PUT",
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(compressed.length),
        },
        body: new Blob([new Uint8Array(compressed)], { type: "image/jpeg" }),
      });

      if (!uploadRes.ok) {
        errors.push(`${item.filename}: Staged upload HTTP ${uploadRes.status}`);
        continue;
      }

      // 5. Attach to product
      const attachRes = await gql<{
        productCreateMedia: {
          media: Array<{ id: string; status: string }>;
          mediaUserErrors: Array<{ field: string[]; message: string }>;
        };
      }>(
        `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { id status }
            mediaUserErrors { field message }
          }
        }`,
        {
          productId,
          media: [{
            originalSource: target.resourceUrl,
            alt: item.alt,
            mediaContentType: "IMAGE",
          }],
        },
        shop,
      );

      const mediaErrors = attachRes.data?.productCreateMedia?.mediaUserErrors;
      if (mediaErrors && mediaErrors.length > 0) {
        errors.push(`${item.filename}: ${mediaErrors.map((e) => e.message).join(", ")}`);
        continue;
      }

      uploaded++;
      console.log(`[create] Attached ${item.filename} to product (${uploaded}/${media.length})`);
    } catch (err) {
      errors.push(`${item.filename}: ${err}`);
    }
  }

  return { uploaded, errors };
}

// ---------------------------------------------------------------------------
// MCP Tool Registration
// ---------------------------------------------------------------------------

export function registerCreateProductTool(server: McpServer): void {
  server.tool(
    "create_product",
    `Execute the full Shopify product creation sequence in one call.

Takes the finalized product payload (after Claude writes descriptions and user approves)
and executes all 7 steps: productCreate, set category, constrained metafields,
variant update, media upload from Drive, verification, and US market translation.

Media is downloaded from Google Drive, compressed to production quality JPEG,
uploaded via Shopify staged uploads, and attached with alt text.

Products are created as DRAFT. Idempotent by handle — returns error if handle exists.`,
    {
      // Core product
      title: z.string(),
      descriptionHtml: z.string(),
      handle: z.string(),
      vendor: z.string(),
      productType: z.string().optional().default(""),
      tags: z.array(z.string()),
      templateSuffix: z.string().optional(),

      // SEO
      seo: z.object({
        title: z.string(),
        description: z.string(),
      }),

      // Category
      taxonomyGid: z.string().describe("Taxonomy category GID (e.g. gid://shopify/TaxonomyCategory/hb-3-2-7-11)"),

      // Metafields split by constraint
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).describe("Non-constrained metafields (brand, application, google_product_category, preorder dates)"),

      constrainedMetafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).describe("Category-constrained metafields (volume, color-pattern, cosmetic-finish, nailstuff_polish_type). Set AFTER category."),

      // Variant
      variant: z.object({
        sku: z.string(),
        price: z.string(),
        compareAtPrice: z.string().optional(),
        weight: z.number().describe("Weight in grams (e.g. 70 for standard 15ml polish)"),
        countryOfOrigin: z.string().describe("ISO country code (e.g. US, CH, CA)"),
        hsCode: z.string().optional().describe("Harmonized system code (default: 330430)"),
      }),

      // Media from Drive
      media: z.array(z.object({
        driveFileId: z.string(),
        alt: z.string(),
        position: z.number(),
        filename: z.string().describe("SEO filename (e.g. cadillacquer-lavender-sunset-bottle-1.jpg)"),
      })),

      // Collections
      collectionsToJoin: z.array(z.string()).optional().describe("Collection GIDs to add the product to"),

      // US market translation
      usTranslation: z.object({
        metaTitle: z.string(),
        metaDescription: z.string(),
        bodyHtml: z.string(),
      }),
    },
    async (params) => {
      const warnings: string[] = [];
      const startTime = Date.now();

      // Resolve shop once, bind to all queries
      const shop = resolveShop();
      const q = <T = unknown>(query: string, variables?: Record<string, unknown>) =>
        gql<T>(query, variables, shop);

      try {
        console.log(`[create] Starting: "${params.title}" by ${params.vendor} on ${shop}`);

        // ---------------------------------------------------------------
        // Pre-check: handle uniqueness
        // ---------------------------------------------------------------
        const existingRes = await q<{
          productByHandle: { id: string; title: string } | null;
        }>(
          `query($handle: String!) { productByHandle(handle: $handle) { id title } }`,
          { handle: params.handle },
        );

        if (existingRes.data?.productByHandle) {
          const existing = existingRes.data.productByHandle;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Handle already exists",
                existingProduct: existing,
                message: `Product "${existing.title}" (${existing.id}) already uses handle "${params.handle}". Update the existing product or choose a different handle.`,
              }, null, 2),
            }],
            isError: true,
          };
        }

        // ---------------------------------------------------------------
        // Step 1: productCreate
        // ---------------------------------------------------------------
        console.log("[create] Step 1: productCreate");
        const createInput: Record<string, unknown> = {
          title: params.title,
          descriptionHtml: params.descriptionHtml,
          handle: params.handle,
          vendor: params.vendor,
          productType: params.productType ?? "",
          status: "DRAFT",
          tags: params.tags,
          seo: params.seo,
        };
        if (params.templateSuffix) createInput.templateSuffix = params.templateSuffix;
        if (params.collectionsToJoin?.length) createInput.collectionsToJoin = params.collectionsToJoin;
        if (params.metafields.length > 0) createInput.metafields = params.metafields;

        const createRes = await q<{
          productCreate: {
            product: {
              id: string;
              handle: string;
              onlineStoreUrl: string | null;
              variants: { edges: Array<{ node: { id: string } }> };
            };
            userErrors: Array<{ field: string[]; message: string }>;
          };
        }>(
          `mutation($product: ProductCreateInput!) {
            productCreate(product: $product) {
              product {
                id handle onlineStoreUrl
                variants(first: 1) { edges { node { id } } }
              }
              userErrors { field message }
            }
          }`,
          { product: createInput },
        );

        throwIfUserErrors(createRes.data?.productCreate?.userErrors, "productCreate");
        const product = createRes.data?.productCreate?.product;
        if (!product) throw new Error("productCreate returned no product");

        const productId = product.id;
        const variantId = product.variants.edges[0]?.node?.id;
        console.log(`[create] Created product ${productId} (handle: ${product.handle})`);

        // ---------------------------------------------------------------
        // Step 2: productUpdate — set category
        // ---------------------------------------------------------------
        console.log("[create] Step 2: productUpdate (category)");
        const catRes = await q<{
          productUpdate: {
            product: { id: string; category: { id: string } | null };
            userErrors: Array<{ field: string[]; message: string }>;
          };
        }>(
          `mutation($product: ProductUpdateInput!) {
            productUpdate(product: $product) {
              product { id category { id } }
              userErrors { field message }
            }
          }`,
          { product: { id: productId, category: params.taxonomyGid } },
        );
        throwIfUserErrors(catRes.data?.productUpdate?.userErrors, "productUpdate (category)");

        // ---------------------------------------------------------------
        // Step 3: metafieldsSet — constrained metafields
        // ---------------------------------------------------------------
        if (params.constrainedMetafields.length > 0) {
          console.log(`[create] Step 3: metafieldsSet (${params.constrainedMetafields.length} constrained)`);
          const mfInputs = params.constrainedMetafields.map((mf) => ({
            ownerId: productId,
            namespace: mf.namespace,
            key: mf.key,
            value: mf.value,
            type: mf.type,
          }));

          const mfRes = await q<{
            metafieldsSet: {
              metafields: Array<{ id: string; namespace: string; key: string }>;
              userErrors: Array<{ field: string[]; message: string }>;
            };
          }>(
            `mutation($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                metafields { id namespace key }
                userErrors { field message }
              }
            }`,
            { metafields: mfInputs },
          );
          throwIfUserErrors(mfRes.data?.metafieldsSet?.userErrors, "metafieldsSet");
        }

        // ---------------------------------------------------------------
        // Step 4: productVariantsBulkUpdate
        // ---------------------------------------------------------------
        if (variantId) {
          console.log("[create] Step 4: productVariantsBulkUpdate");
          const variantInput = {
            id: variantId,
            price: params.variant.price,
            ...(params.variant.compareAtPrice ? { compareAtPrice: params.variant.compareAtPrice } : {}),
            taxable: true,
            inventoryPolicy: "DENY",
            inventoryItem: {
              tracked: true,
              sku: params.variant.sku,
              measurement: {
                weight: { value: params.variant.weight, unit: "GRAMS" },
              },
              countryCodeOfOrigin: params.variant.countryOfOrigin,
              harmonizedSystemCode: params.variant.hsCode ?? DEFAULT_HS_CODE,
            },
          };

          const varRes = await q<{
            productVariantsBulkUpdate: {
              productVariants: Array<{ id: string; sku: string }>;
              userErrors: Array<{ field: string[]; message: string }>;
            };
          }>(
            `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants { id sku }
                userErrors { field message }
              }
            }`,
            { productId, variants: [variantInput] },
          );
          throwIfUserErrors(varRes.data?.productVariantsBulkUpdate?.userErrors, "productVariantsBulkUpdate");
        } else {
          warnings.push("No default variant found — skipped variant update");
        }

        // ---------------------------------------------------------------
        // Step 5: Media upload (Drive -> Shopify)
        // ---------------------------------------------------------------
        let mediaResult = { uploaded: 0, errors: [] as string[] };
        if (params.media.length > 0) {
          console.log(`[create] Step 5: Media upload (${params.media.length} images)`);
          // Sort by position before uploading
          const sorted = [...params.media].sort((a, b) => a.position - b.position);
          mediaResult = await uploadMediaToShopify(productId, sorted, shop);
          if (mediaResult.errors.length > 0) {
            for (const err of mediaResult.errors) {
              warnings.push(`Media: ${err}`);
            }
          }
        }

        // ---------------------------------------------------------------
        // Step 6: Verification re-read
        // ---------------------------------------------------------------
        console.log("[create] Step 6: Verification");
        const verifyRes = await q<{
          product: {
            id: string;
            handle: string;
            onlineStoreUrl: string | null;
            category: { id: string; name: string } | null;
            variants: { edges: Array<{ node: {
              id: string; sku: string; price: string; taxable: boolean;
              inventoryPolicy: string;
              inventoryItem: {
                countryCodeOfOrigin: string | null;
                harmonizedSystemCode: string | null;
              };
            } }> };
            metafields: { edges: Array<{ node: { namespace: string; key: string; value: string } }> };
            media: { edges: Array<{ node: { id: string } }> };
          } | null;
        }>(
          `query($id: ID!) {
            product(id: $id) {
              id handle onlineStoreUrl
              category { id name }
              variants(first: 1) { edges { node {
                id sku price taxable inventoryPolicy
                inventoryItem { countryCodeOfOrigin harmonizedSystemCode }
              } } }
              metafields(first: 50) { edges { node { namespace key value } } }
              media(first: 50) { edges { node { id } } }
            }
          }`,
          { id: productId },
        );

        const verified = verifyRes.data?.product;
        const actualVariant = verified?.variants?.edges?.[0]?.node;
        const actualMetafields = verified?.metafields?.edges?.map((e) => e.node) ?? [];
        const actualMediaCount = verified?.media?.edges?.length ?? 0;
        const expectedMetafieldCount = params.metafields.length + params.constrainedMetafields.length;

        // Check for missing metafields
        const actualMfKeys = new Set(actualMetafields.map((m) => `${m.namespace}.${m.key}`));
        const missingMf = [...params.metafields, ...params.constrainedMetafields]
          .map((m) => `${m.namespace}.${m.key}`)
          .filter((k) => !actualMfKeys.has(k));

        const verification = {
          category: {
            expected: params.taxonomyGid,
            actual: verified?.category?.id ?? "none",
            ok: verified?.category?.id === params.taxonomyGid,
          },
          sku: {
            expected: params.variant.sku,
            actual: actualVariant?.sku ?? "none",
            ok: actualVariant?.sku === params.variant.sku,
          },
          metafields: {
            expected: expectedMetafieldCount,
            actual: actualMetafields.length,
            ok: missingMf.length === 0,
            ...(missingMf.length > 0 ? { missing: missingMf } : {}),
          },
          media: {
            expected: params.media.length,
            actual: actualMediaCount,
            ok: actualMediaCount === params.media.length,
          },
          translation: { registered: false, keys: [] as string[] },
        };

        // ---------------------------------------------------------------
        // Step 7: US market translation
        // ---------------------------------------------------------------
        console.log("[create] Step 7: US market translation");
        try {
          const txResult = await registerTranslation(
            productId,
            US_MARKET_GID,
            params.usTranslation,
            shop,
          );
          verification.translation = {
            registered: txResult.registered.length > 0,
            keys: txResult.registered.map((r) => r.key),
          };
          if (txResult.warnings.length > 0) {
            for (const w of txResult.warnings) warnings.push(`Translation: ${w}`);
          }
        } catch (err) {
          warnings.push(`US translation failed: ${err}. Register manually via translate_for_market.`);
        }

        // ---------------------------------------------------------------
        // Build admin URL
        // ---------------------------------------------------------------
        const numericId = extractId(productId);
        // We don't have shop domain in scope, so construct a relative admin path
        const adminPath = `/admin/products/${numericId}`;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[create] Complete: ${productId} in ${elapsed}s`);

        const result = {
          product: {
            id: productId,
            handle: verified?.handle ?? params.handle,
            url: verified?.onlineStoreUrl,
            adminPath,
          },
          verification,
          processingTimeSeconds: Number(elapsed),
          warnings,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };

      } catch (err) {
        console.error("[create] Fatal error:", err);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: String(err),
              message: "Product creation failed. Check warnings and retry, or create manually.",
              warnings,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );
}
