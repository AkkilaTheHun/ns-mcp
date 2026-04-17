import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

// --- GraphQL Fragments ---

const COLLECTION_FIELDS = `
  id
  title
  handle
  descriptionHtml
  sortOrder
  templateSuffix
  updatedAt
  productsCount {
    count
  }
  image {
    url
    altText
    width
    height
  }
  seo {
    title
    description
  }
  ruleSet {
    appliedDisjunctively
    rules {
      column
      relation
      condition
    }
  }
  metafields(first: 25) {
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
`;

const COLLECTION_SUMMARY_FIELDS = `
  id
  title
  handle
  sortOrder
  updatedAt
  productsCount {
    count
  }
  image {
    url
    altText
  }
  ruleSet {
    appliedDisjunctively
    rules {
      column
      relation
      condition
    }
  }
`;

export function registerCollectionTools(server: McpServer): void {
  // --- List Collections ---
  server.tool(
    "list_collections",
    "List collections with optional filtering and pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of collections to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query (e.g. 'title:*summer*', 'collection_type:smart')"),
      sortKey: z.enum(["TITLE", "UPDATED_AT", "ID", "RELEVANCE"]).default("UPDATED_AT"),
      reverse: z.boolean().default(false),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ collections: { edges: unknown[]; pageInfo: unknown } }>(`
        query ListCollections($first: Int!, $after: String, $query: String, $sortKey: CollectionSortKeys!, $reverse: Boolean!) {
          collections(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${COLLECTION_SUMMARY_FIELDS} }
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

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Get Collection ---
  server.tool(
    "get_collection",
    "Get full details of a collection by ID or handle.",
    {
      id: z.string().optional().describe("Collection GID"),
      handle: z.string().optional().describe("Collection handle"),
    },
    async ({ id, handle }) => {
      if (!id && !handle) {
        return { content: [{ type: "text" as const, text: "Error: Provide either id or handle" }], isError: true };
      }

      let query: string;
      let variables: Record<string, unknown>;

      if (id) {
        query = `query GetCollection($id: ID!) { collection(id: $id) { ${COLLECTION_FIELDS} } }`;
        variables = { id };
      } else {
        query = `query GetCollectionByHandle($handle: String!) { collectionByHandle(handle: $handle) { ${COLLECTION_FIELDS} } }`;
        variables = { handle };
      }

      const res = await shopifyGraphQL(query, variables);
      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Create Collection (Manual/Custom) ---
  server.tool(
    "create_collection",
    "Create a manual (custom) collection.",
    {
      title: z.string().describe("Collection title"),
      descriptionHtml: z.string().optional().describe("Collection description (HTML)"),
      image: z.object({
        src: z.string().describe("Image URL"),
        altText: z.string().optional(),
      }).optional().describe("Collection image"),
      templateSuffix: z.string().optional(),
      sortOrder: z.enum([
        "ALPHA_ASC", "ALPHA_DESC", "BEST_SELLING", "CREATED", "CREATED_DESC",
        "MANUAL", "PRICE_ASC", "PRICE_DESC",
      ]).optional().describe("Product sort order within the collection"),
      seo: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
      }).optional(),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).optional(),
    },
    async (input) => {
      const res = await shopifyGraphQL<{
        collectionCreate: { collection: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CollectionCreate($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { ${COLLECTION_FIELDS} }
            userErrors { field message }
          }
        }
      `, { input });

      throwIfUserErrors(res.data?.collectionCreate?.userErrors, "collectionCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.collectionCreate?.collection) }] };
    },
  );

  // --- Create Smart Collection ---
  server.tool(
    "create_smart_collection",
    "Create a smart (automated) collection with rules.",
    {
      title: z.string().describe("Collection title"),
      descriptionHtml: z.string().optional(),
      ruleSet: z.object({
        appliedDisjunctively: z.boolean().describe("true = match ANY rule (OR), false = match ALL rules (AND)"),
        rules: z.array(z.object({
          column: z.enum([
            "TAG", "TITLE", "TYPE", "VENDOR", "VARIANT_PRICE",
            "IS_PRICE_REDUCED", "VARIANT_COMPARE_AT_PRICE", "VARIANT_WEIGHT",
            "VARIANT_INVENTORY", "VARIANT_TITLE", "PRODUCT_METAFIELD_DEFINITION",
          ]).describe("Rule column"),
          relation: z.enum([
            "EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN",
            "STARTS_WITH", "ENDS_WITH", "CONTAINS", "NOT_CONTAINS",
          ]).describe("Rule relation"),
          condition: z.string().describe("Rule value"),
          conditionObjectId: z.string().optional().describe("For metafield rules, the metafield definition GID"),
        })).describe("Collection rules"),
      }).describe("Smart collection rules"),
      sortOrder: z.enum([
        "ALPHA_ASC", "ALPHA_DESC", "BEST_SELLING", "CREATED", "CREATED_DESC",
        "MANUAL", "PRICE_ASC", "PRICE_DESC",
      ]).optional(),
      image: z.object({
        src: z.string(),
        altText: z.string().optional(),
      }).optional(),
      templateSuffix: z.string().optional(),
      seo: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
      }).optional(),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).optional(),
    },
    async (input) => {
      const res = await shopifyGraphQL<{
        collectionCreate: { collection: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CollectionCreate($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { ${COLLECTION_FIELDS} }
            userErrors { field message }
          }
        }
      `, { input });

      throwIfUserErrors(res.data?.collectionCreate?.userErrors, "collectionCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.collectionCreate?.collection) }] };
    },
  );

  // --- Update Collection ---
  server.tool(
    "update_collection",
    "Update an existing collection.",
    {
      id: z.string().describe("Collection GID"),
      title: z.string().optional(),
      descriptionHtml: z.string().optional(),
      image: z.object({
        src: z.string(),
        altText: z.string().optional(),
      }).optional(),
      templateSuffix: z.string().optional(),
      sortOrder: z.enum([
        "ALPHA_ASC", "ALPHA_DESC", "BEST_SELLING", "CREATED", "CREATED_DESC",
        "MANUAL", "PRICE_ASC", "PRICE_DESC",
      ]).optional(),
      ruleSet: z.object({
        appliedDisjunctively: z.boolean(),
        rules: z.array(z.object({
          column: z.enum([
            "TAG", "TITLE", "TYPE", "VENDOR", "VARIANT_PRICE",
            "IS_PRICE_REDUCED", "VARIANT_COMPARE_AT_PRICE", "VARIANT_WEIGHT",
            "VARIANT_INVENTORY", "VARIANT_TITLE", "PRODUCT_METAFIELD_DEFINITION",
          ]),
          relation: z.enum([
            "EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN",
            "STARTS_WITH", "ENDS_WITH", "CONTAINS", "NOT_CONTAINS",
          ]),
          condition: z.string(),
          conditionObjectId: z.string().optional(),
        })),
      }).optional().describe("Update smart collection rules (replaces existing rules)"),
      seo: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
      }).optional(),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).optional(),
    },
    async (input) => {
      const res = await shopifyGraphQL<{
        collectionUpdate: { collection: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CollectionUpdate($input: CollectionInput!) {
          collectionUpdate(input: $input) {
            collection { ${COLLECTION_FIELDS} }
            userErrors { field message }
          }
        }
      `, { input });

      throwIfUserErrors(res.data?.collectionUpdate?.userErrors, "collectionUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.collectionUpdate?.collection) }] };
    },
  );

  // --- Delete Collection ---
  server.tool(
    "delete_collection",
    "Delete a collection by ID. This is irreversible.",
    {
      id: z.string().describe("Collection GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        collectionDelete: { deletedCollectionId: string; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CollectionDelete($input: CollectionDeleteInput!) {
          collectionDelete(input: $input) {
            deletedCollectionId
            userErrors { field message }
          }
        }
      `, { input: { id } });

      throwIfUserErrors(res.data?.collectionDelete?.userErrors, "collectionDelete");
      return { content: [{ type: "text" as const, text: `Collection ${res.data?.collectionDelete?.deletedCollectionId} deleted.` }] };
    },
  );

  // --- Add Products to Collection ---
  server.tool(
    "add_products_to_collection",
    "Add products to a manual collection.",
    {
      collectionId: z.string().describe("Collection GID"),
      productIds: z.array(z.string()).describe("Product GIDs to add"),
    },
    async ({ collectionId, productIds }) => {
      const res = await shopifyGraphQL<{
        collectionAddProducts: { collection: { id: string; productsCount: { count: number } }; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $productIds) {
            collection {
              id
              productsCount { count }
            }
            userErrors { field message }
          }
        }
      `, { id: collectionId, productIds });

      throwIfUserErrors(res.data?.collectionAddProducts?.userErrors, "collectionAddProducts");
      return { content: [{ type: "text" as const, text: toText(res.data?.collectionAddProducts?.collection) }] };
    },
  );

  // --- Remove Products from Collection ---
  server.tool(
    "remove_products_from_collection",
    "Remove products from a manual collection.",
    {
      collectionId: z.string().describe("Collection GID"),
      productIds: z.array(z.string()).describe("Product GIDs to remove"),
    },
    async ({ collectionId, productIds }) => {
      const res = await shopifyGraphQL<{
        collectionRemoveProducts: { userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CollectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
          collectionRemoveProducts(id: $id, productIds: $productIds) {
            userErrors { field message }
          }
        }
      `, { id: collectionId, productIds });

      throwIfUserErrors(res.data?.collectionRemoveProducts?.userErrors, "collectionRemoveProducts");
      return { content: [{ type: "text" as const, text: `Removed ${productIds.length} product(s) from collection.` }] };
    },
  );

  // --- List Products in Collection ---
  server.tool(
    "list_collection_products",
    "List all products within a collection.",
    {
      collectionId: z.string().describe("Collection GID"),
      first: z.number().min(1).max(250).default(50),
      after: z.string().optional().describe("Pagination cursor"),
    },
    async ({ collectionId, first, after }) => {
      const res = await shopifyGraphQL<{ collection: unknown }>(`
        query CollectionProducts($id: ID!, $first: Int!, $after: String) {
          collection(id: $id) {
            id
            title
            products(first: $first, after: $after) {
              edges {
                cursor
                node {
                  id
                  title
                  handle
                  status
                  vendor
                  totalInventory
                  featuredImage { url altText }
                  variants(first: 3) {
                    edges {
                      node {
                        id
                        title
                        price
                        sku
                      }
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `, { id: collectionId, first, after });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Reorder Products in Collection ---
  server.tool(
    "reorder_collection_products",
    "Reorder products within a manual collection.",
    {
      collectionId: z.string().describe("Collection GID"),
      moves: z.array(z.object({
        id: z.string().describe("Product GID to move"),
        newPosition: z.string().describe("New zero-based position as string"),
      })).describe("Product moves"),
    },
    async ({ collectionId, moves }) => {
      const res = await shopifyGraphQL<{
        collectionReorderProducts: { userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CollectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
          collectionReorderProducts(id: $id, moves: $moves) {
            userErrors { field message }
          }
        }
      `, { id: collectionId, moves });

      throwIfUserErrors(res.data?.collectionReorderProducts?.userErrors, "collectionReorderProducts");
      return { content: [{ type: "text" as const, text: `Reordered ${moves.length} product(s) in collection.` }] };
    },
  );

  // --- Count Collections ---
  server.tool(
    "count_collections",
    "Get the total number of collections.",
    {
      query: z.string().optional().describe("Optional filter query"),
    },
    async ({ query }) => {
      const res = await shopifyGraphQL<{ collectionsCount: { count: number } }>(`
        query CollectionsCount($query: String) {
          collectionsCount(query: $query) {
            count
          }
        }
      `, { query });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Set Collection Metafields ---
  server.tool(
    "set_collection_metafields",
    "Set metafields on a collection (creates or updates).",
    {
      collectionId: z.string().describe("Collection GID"),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).describe("Metafields to set"),
    },
    async ({ collectionId, metafields }) => {
      const metafieldsInput = metafields.map((mf) => ({
        ownerId: collectionId,
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
      return { content: [{ type: "text" as const, text: toText(res.data?.metafieldsSet?.metafields) }] };
    },
  );
}
