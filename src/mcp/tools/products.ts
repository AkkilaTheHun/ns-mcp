import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors } from "../../shopify/client.js";

// --- GraphQL Fragments ---

const PRODUCT_FIELDS = `
  id
  title
  handle
  descriptionHtml
  vendor
  productType
  status
  tags
  templateSuffix
  createdAt
  updatedAt
  publishedAt
  onlineStoreUrl
  totalInventory
  tracksInventory
  hasOnlyDefaultVariant
  options {
    id
    name
    position
    values
  }
  images(first: 20) {
    edges {
      node {
        id
        url
        altText
        width
        height
      }
    }
  }
  variants(first: 100) {
    edges {
      node {
        id
        title
        sku
        barcode
        price
        compareAtPrice
        inventoryQuantity
        weight
        weightUnit
        requiresShipping
        taxable
        selectedOptions {
          name
          value
        }
        image {
          id
          url
          altText
        }
      }
    }
  }
  metafields(first: 50) {
    edges {
      node {
        id
        namespace
        key
        value
        type
      }
    }
  }
  seo {
    title
    description
  }
`;

const PRODUCT_SUMMARY_FIELDS = `
  id
  title
  handle
  status
  vendor
  productType
  totalInventory
  tags
  createdAt
  updatedAt
  variants(first: 3) {
    edges {
      node {
        id
        title
        price
        sku
        inventoryQuantity
      }
    }
  }
  featuredImage {
    url
    altText
  }
`;

export function registerProductTools(server: McpServer): void {
  // --- List Products ---
  server.tool(
    "list_products",
    "List products with optional filtering, sorting, and pagination. Returns summary view.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of products to return (max 250)"),
      after: z.string().optional().describe("Cursor for pagination (from pageInfo.endCursor)"),
      query: z.string().optional().describe("Shopify search query (e.g. 'status:active', 'vendor:Nike', 'title:*shirt*', 'tag:sale')"),
      sortKey: z.enum(["TITLE", "PRODUCT_TYPE", "VENDOR", "INVENTORY_TOTAL", "UPDATED_AT", "CREATED_AT", "PUBLISHED_AT", "RELEVANCE"]).default("UPDATED_AT").describe("Sort key"),
      reverse: z.boolean().default(false).describe("Reverse sort order"),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ products: { edges: unknown[]; pageInfo: unknown } }>(`
        query ListProducts($first: Int!, $after: String, $query: String, $sortKey: ProductSortKeys!, $reverse: Boolean!) {
          products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${PRODUCT_SUMMARY_FIELDS} }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              endCursor
              startCursor
            }
          }
        }
      `, { first, after, query, sortKey, reverse });

      return { content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  // --- Get Product ---
  server.tool(
    "get_product",
    "Get full details of a single product by ID or handle.",
    {
      id: z.string().optional().describe("Product GID (e.g. gid://shopify/Product/123)"),
      handle: z.string().optional().describe("Product handle (URL slug)"),
    },
    async ({ id, handle }) => {
      if (!id && !handle) {
        return { content: [{ type: "text" as const, text: "Error: Provide either id or handle" }], isError: true };
      }

      let query: string;
      let variables: Record<string, unknown>;

      if (id) {
        query = `query GetProduct($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`;
        variables = { id };
      } else {
        query = `query GetProductByHandle($handle: String!) { productByHandle(handle: $handle) { ${PRODUCT_FIELDS} } }`;
        variables = { handle };
      }

      const res = await shopifyGraphQL(query, variables);
      return { content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  // --- Create Product ---
  server.tool(
    "create_product",
    "Create a new product. Only creates the product with a default variant — use create_product_variants to add more variants after.",
    {
      title: z.string().describe("Product title"),
      descriptionHtml: z.string().optional().describe("Product description (HTML)"),
      handle: z.string().optional().describe("URL-friendly slug (auto-generated from title if omitted)"),
      vendor: z.string().optional().describe("Product vendor"),
      productType: z.string().optional().describe("Product type"),
      status: z.enum(["ACTIVE", "ARCHIVED", "DRAFT"]).default("DRAFT").describe("Product status"),
      tags: z.array(z.string()).optional().describe("Product tags"),
      templateSuffix: z.string().optional().describe("Liquid template suffix"),
      productOptions: z.array(z.object({
        name: z.string().describe("Option name (e.g. Color, Size)"),
        values: z.array(z.object({
          name: z.string().describe("Option value (e.g. Red, Large)"),
        })).describe("Option values"),
      })).optional().describe("Product options (e.g. Color, Size) — define these, then use create_product_variants to create variants with option combinations"),
      collectionsToJoin: z.array(z.string()).optional().describe("Collection GIDs to add the product to"),
      seo: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
      }).optional().describe("SEO title and meta description"),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string().describe("Metafield type (e.g. single_line_text_field, number_integer, json, boolean)"),
      })).optional().describe("Product metafields"),
    },
    async (input) => {
      const res = await shopifyGraphQL<{
        productCreate: { product: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation ProductCreate($product: ProductCreateInput!) {
          productCreate(product: $product) {
            product { ${PRODUCT_FIELDS} }
            userErrors { field message }
          }
        }
      `, { product: input });

      throwIfUserErrors(res.data?.productCreate?.userErrors, "productCreate");
      return { content: [{ type: "text" as const, text: JSON.stringify(res.data?.productCreate?.product, null, 2) }] };
    },
  );

  // --- Update Product ---
  server.tool(
    "update_product",
    "Update an existing product's fields. Does NOT update variants — use update_product_variants for that.",
    {
      id: z.string().describe("Product GID (e.g. gid://shopify/Product/123)"),
      title: z.string().optional().describe("Product title"),
      descriptionHtml: z.string().optional().describe("Product description (HTML)"),
      handle: z.string().optional().describe("URL-friendly slug"),
      vendor: z.string().optional().describe("Product vendor"),
      productType: z.string().optional().describe("Product type"),
      status: z.enum(["ACTIVE", "ARCHIVED", "DRAFT"]).optional().describe("Product status"),
      tags: z.array(z.string()).optional().describe("Product tags (replaces all existing tags)"),
      templateSuffix: z.string().optional().describe("Liquid template suffix"),
      collectionsToJoin: z.array(z.string()).optional().describe("Collection GIDs to add the product to"),
      collectionsToLeave: z.array(z.string()).optional().describe("Collection GIDs to remove the product from"),
      seo: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
      }).optional().describe("SEO title and meta description"),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).optional().describe("Metafields to set/update"),
    },
    async (input) => {
      const res = await shopifyGraphQL<{
        productUpdate: { product: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation ProductUpdate($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product { ${PRODUCT_FIELDS} }
            userErrors { field message }
          }
        }
      `, { product: input });

      throwIfUserErrors(res.data?.productUpdate?.userErrors, "productUpdate");
      return { content: [{ type: "text" as const, text: JSON.stringify(res.data?.productUpdate?.product, null, 2) }] };
    },
  );

  // --- Delete Product ---
  server.tool(
    "delete_product",
    "Delete a product by ID. This is irreversible.",
    {
      id: z.string().describe("Product GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        productDelete: { deletedProductId: string; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation ProductDelete($input: ProductDeleteInput!) {
          productDelete(input: $input) {
            deletedProductId
            userErrors { field message }
          }
        }
      `, { input: { id } });

      throwIfUserErrors(res.data?.productDelete?.userErrors, "productDelete");
      return { content: [{ type: "text" as const, text: `Product ${res.data?.productDelete?.deletedProductId} deleted.` }] };
    },
  );

  // --- Create Product Variants ---
  server.tool(
    "create_product_variants",
    "Bulk create variants for an existing product.",
    {
      productId: z.string().describe("Product GID"),
      strategy: z.enum(["DEFAULT", "REMOVE_STANDALONE_VARIANT"]).default("REMOVE_STANDALONE_VARIANT").describe("REMOVE_STANDALONE_VARIANT removes the auto-created default variant"),
      variants: z.array(z.object({
        price: z.string().optional().describe("Variant price"),
        compareAtPrice: z.string().optional().describe("Compare at price"),
        sku: z.string().optional().describe("SKU"),
        barcode: z.string().optional().describe("Barcode"),
        weight: z.number().optional().describe("Weight"),
        weightUnit: z.enum(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"]).optional(),
        taxable: z.boolean().optional(),
        inventoryPolicy: z.enum(["DENY", "CONTINUE"]).optional().describe("DENY = stop selling when out of stock, CONTINUE = allow overselling"),
        optionValues: z.array(z.object({
          optionName: z.string().describe("Option name (e.g. 'Color')"),
          name: z.string().describe("Option value (e.g. 'Red')"),
        })).describe("Option values for this variant"),
        metafields: z.array(z.object({
          namespace: z.string(),
          key: z.string(),
          value: z.string(),
          type: z.string(),
        })).optional(),
      })).describe("Variants to create"),
    },
    async ({ productId, strategy, variants }) => {
      const res = await shopifyGraphQL<{
        productVariantsBulkCreate: {
          productVariants: unknown[];
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
          productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
            productVariants {
              id
              title
              sku
              price
              compareAtPrice
              inventoryQuantity
              selectedOptions { name value }
            }
            userErrors { field message }
          }
        }
      `, { productId, variants, strategy });

      throwIfUserErrors(res.data?.productVariantsBulkCreate?.userErrors, "productVariantsBulkCreate");
      return { content: [{ type: "text" as const, text: JSON.stringify(res.data?.productVariantsBulkCreate?.productVariants, null, 2) }] };
    },
  );

  // --- Update Product Variants ---
  server.tool(
    "update_product_variants",
    "Bulk update existing variants.",
    {
      productId: z.string().describe("Product GID"),
      variants: z.array(z.object({
        id: z.string().describe("Variant GID"),
        price: z.string().optional(),
        compareAtPrice: z.string().optional(),
        sku: z.string().optional(),
        barcode: z.string().optional(),
        weight: z.number().optional(),
        weightUnit: z.enum(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"]).optional(),
        requiresShipping: z.boolean().optional(),
        taxable: z.boolean().optional(),
        metafields: z.array(z.object({
          namespace: z.string(),
          key: z.string(),
          value: z.string(),
          type: z.string(),
        })).optional(),
      })).describe("Variants to update"),
    },
    async ({ productId, variants }) => {
      const res = await shopifyGraphQL<{
        productVariantsBulkUpdate: {
          productVariants: unknown[];
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              title
              sku
              price
              compareAtPrice
              inventoryQuantity
              selectedOptions { name value }
            }
            userErrors { field message }
          }
        }
      `, { productId, variants });

      throwIfUserErrors(res.data?.productVariantsBulkUpdate?.userErrors, "productVariantsBulkUpdate");
      return { content: [{ type: "text" as const, text: JSON.stringify(res.data?.productVariantsBulkUpdate?.productVariants, null, 2) }] };
    },
  );

  // --- Delete Product Variants ---
  server.tool(
    "delete_product_variants",
    "Bulk delete variants from a product.",
    {
      productId: z.string().describe("Product GID"),
      variantIds: z.array(z.string()).describe("Variant GIDs to delete"),
    },
    async ({ productId, variantIds }) => {
      const res = await shopifyGraphQL<{
        productVariantsBulkDelete: {
          product: { id: string };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation ProductVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
          productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
            product { id }
            userErrors { field message }
          }
        }
      `, { productId, variantsIds: variantIds });

      throwIfUserErrors(res.data?.productVariantsBulkDelete?.userErrors, "productVariantsBulkDelete");
      return { content: [{ type: "text" as const, text: `Deleted ${variantIds.length} variant(s).` }] };
    },
  );

  // --- Set Product Metafields ---
  server.tool(
    "set_product_metafields",
    "Set metafields on a product (creates or updates).",
    {
      productId: z.string().describe("Product GID"),
      metafields: z.array(z.object({
        namespace: z.string().describe("Metafield namespace"),
        key: z.string().describe("Metafield key"),
        value: z.string().describe("Metafield value"),
        type: z.string().describe("Metafield type (e.g. single_line_text_field, number_integer, json, boolean, url, date, color, rating, etc.)"),
      })).describe("Metafields to set"),
    },
    async ({ productId, metafields }) => {
      const metafieldsInput = metafields.map((mf) => ({
        ownerId: productId,
        namespace: mf.namespace,
        key: mf.key,
        value: mf.value,
        type: mf.type,
      }));

      const res = await shopifyGraphQL<{
        metafieldsSet: {
          metafields: Array<{ id: string; namespace: string; key: string; value: string; type: string }>;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key value type }
            userErrors { field message }
          }
        }
      `, { metafields: metafieldsInput });

      throwIfUserErrors(res.data?.metafieldsSet?.userErrors, "metafieldsSet");
      return { content: [{ type: "text" as const, text: JSON.stringify(res.data?.metafieldsSet?.metafields, null, 2) }] };
    },
  );

  // --- Delete Product Metafield ---
  server.tool(
    "delete_metafield",
    "Delete a metafield by its ID.",
    {
      id: z.string().describe("Metafield GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        metafieldDelete: {
          deletedId: string;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation MetafieldDelete($input: MetafieldDeleteInput!) {
          metafieldDelete(input: $input) {
            deletedId
            userErrors { field message }
          }
        }
      `, { input: { id } });

      throwIfUserErrors(res.data?.metafieldDelete?.userErrors, "metafieldDelete");
      return { content: [{ type: "text" as const, text: `Metafield ${res.data?.metafieldDelete?.deletedId} deleted.` }] };
    },
  );

  // --- Search Products ---
  server.tool(
    "search_products",
    "Search products using Shopify's search syntax. Supports title, vendor, tag, status, product_type, etc.",
    {
      query: z.string().describe("Search query (e.g. 'title:*gel* AND status:active AND tag:nail-art')"),
      first: z.number().min(1).max(250).default(25).describe("Number of results"),
    },
    async ({ query, first }) => {
      const res = await shopifyGraphQL<{ products: { edges: unknown[] } }>(`
        query SearchProducts($query: String!, $first: Int!) {
          products(first: $first, query: $query) {
            edges {
              node { ${PRODUCT_SUMMARY_FIELDS} }
            }
          }
        }
      `, { query, first });

      return { content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  // --- Get Product Count ---
  server.tool(
    "count_products",
    "Get the total number of products, optionally filtered.",
    {
      query: z.string().optional().describe("Optional filter query (e.g. 'status:active')"),
    },
    async ({ query }) => {
      const res = await shopifyGraphQL<{ productsCount: { count: number } }>(`
        query ProductsCount($query: String) {
          productsCount(query: $query) {
            count
          }
        }
      `, { query });

      return { content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  // --- Update Product Media / Images ---
  server.tool(
    "create_product_media",
    "Add images or other media to a product from URLs.",
    {
      productId: z.string().describe("Product GID"),
      media: z.array(z.object({
        originalSource: z.string().describe("URL of the media file"),
        alt: z.string().optional().describe("Alt text"),
        mediaContentType: z.enum(["IMAGE", "VIDEO", "EXTERNAL_VIDEO", "MODEL_3D"]).default("IMAGE"),
      })).describe("Media items to add"),
    },
    async ({ productId, media }) => {
      const res = await shopifyGraphQL<{
        productCreateMedia: {
          media: unknown[];
          mediaUserErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media {
              ... on MediaImage {
                id
                image { url altText }
                status
              }
            }
            mediaUserErrors { field message }
          }
        }
      `, { productId, media });

      throwIfUserErrors(res.data?.productCreateMedia?.mediaUserErrors, "productCreateMedia");
      return { content: [{ type: "text" as const, text: JSON.stringify(res.data?.productCreateMedia?.media, null, 2) }] };
    },
  );
}
