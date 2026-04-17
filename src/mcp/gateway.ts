import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../shopify/client.js";
import { config, getShopCredentials } from "../config.js";
import { getCurrentSessionId } from "../context.js";
import { getSessionShop, setSessionShop } from "../session.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : toText(data) }] };
}

function fail(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function gql<T = unknown>(query: string, variables?: Record<string, unknown> | undefined, shop?: string) {
  return shopifyGraphQL<T>(query, variables ?? undefined, shop);
}

function checkErrors(userErrors: Array<{ field?: string[]; message: string }> | undefined | null, op: string) {
  throwIfUserErrors(userErrors, op);
}

// ============================================================
// SHOP
// ============================================================

export function registerShopGateway(server: McpServer): void {
  server.tool(
    "shopify_shop",
    `Manage store connections. Actions:
- list: List all connected stores and which is selected
- select: Select a store for this session (params: shop)
- info: Get store details (params: shop?)`,
    {
      action: z.enum(["list", "select", "info"]),
      shop: z.string().optional().describe("Shop domain (e.g. nailstuff-dev.myshopify.com)"),
    },
    async ({ action, shop }) => {
      if (action === "list") {
        const sessionId = getCurrentSessionId();
        const selected = sessionId ? getSessionShop(sessionId) : undefined;
        const shops = [...config.shops.keys()].map(d => ({ domain: d, isDefault: d === config.defaultShop, isSelected: d === selected }));
        return shops.length ? text(shops) : fail("No shops configured.");
      }
      if (action === "select") {
        if (!shop) return fail("shop parameter required");
        try { getShopCredentials(shop); } catch (e) { return fail(String(e)); }
        const sid = getCurrentSessionId();
        if (!sid) return fail("No active session");
        setSessionShop(sid, shop);
        return text(`Selected shop: ${shop}`);
      }
      // info
      const res = await gql(`query { shop { id name myshopifyDomain primaryDomain { host url } plan { displayName partnerDevelopment shopifyPlus } currencyCode weightUnit timezoneAbbreviation ianaTimezone contactEmail createdAt } }`, undefined, shop);
      return text(res.data);
    },
  );
}

// ============================================================
// PRODUCTS
// ============================================================

const PRODUCT_SUMMARY = `id title handle status vendor productType totalInventory tags createdAt updatedAt variants(first:3){edges{node{id title price sku inventoryQuantity}}} featuredMedia{...on MediaImage{image{url altText}}}`;
const PRODUCT_FULL = `id title handle descriptionHtml vendor productType status tags templateSuffix createdAt updatedAt publishedAt onlineStoreUrl totalInventory tracksInventory hasOnlyDefaultVariant options{id name position values} media(first:20){edges{node{...on MediaImage{id image{url altText width height} status}}}} variants(first:100){edges{node{id title sku barcode price compareAtPrice inventoryQuantity inventoryPolicy taxable position selectedOptions{name value} media(first:5){edges{node{...on MediaImage{id image{url altText}}}}}}}} metafields(first:50){edges{node{id namespace key value type}}} seo{title description}`;

export function registerProductGateway(server: McpServer): void {
  server.tool(
    "shopify_products",
    `Manage Shopify products. Actions:
- list: List products (params: first?, after?, query?, sortKey?, reverse?)
- get: Get product by ID or handle (params: id?, handle?)
- search: Search products (params: query, first?)
- count: Count products (params: query?)
- create: Create product (params: title, descriptionHtml?, handle?, vendor?, productType?, status?, tags?, productOptions?, collectionsToJoin?, seo?, metafields?)
- update: Update product (params: id, title?, descriptionHtml?, handle?, vendor?, productType?, status?, tags?, collectionsToJoin?, collectionsToLeave?, seo?, metafields?)
- delete: Delete product (params: id)
- add_media: Add media from URLs (params: productId, media[{originalSource, alt?, mediaContentType?}])`,
    {
      action: z.enum(["list", "get", "search", "count", "create", "update", "delete", "add_media"]),
      // Shared
      id: z.string().optional(),
      handle: z.string().optional(),
      query: z.string().optional(),
      first: z.number().optional(),
      after: z.string().optional(),
      sortKey: z.string().optional(),
      reverse: z.boolean().optional(),
      // Create/Update
      title: z.string().optional(),
      descriptionHtml: z.string().optional(),
      vendor: z.string().optional(),
      productType: z.string().optional(),
      status: z.enum(["ACTIVE", "ARCHIVED", "DRAFT"]).optional(),
      tags: z.array(z.string()).optional(),
      templateSuffix: z.string().optional(),
      productOptions: z.array(z.object({ name: z.string(), values: z.array(z.object({ name: z.string() })) })).optional(),
      collectionsToJoin: z.array(z.string()).optional(),
      collectionsToLeave: z.array(z.string()).optional(),
      seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),
      metafields: z.array(z.object({ namespace: z.string(), key: z.string(), value: z.string(), type: z.string() })).optional(),
      // Media
      productId: z.string().optional(),
      media: z.array(z.object({ originalSource: z.string(), alt: z.string().optional(), mediaContentType: z.enum(["IMAGE", "VIDEO", "EXTERNAL_VIDEO", "MODEL_3D"]).optional() })).optional(),
    },
    async ({ action, ...p }) => {
      switch (action) {
        case "list": {
          const res = await gql(`query($first:Int!,$after:String,$query:String,$sortKey:ProductSortKeys!,$reverse:Boolean!){products(first:$first,after:$after,query:$query,sortKey:$sortKey,reverse:$reverse){edges{cursor node{${PRODUCT_SUMMARY}}}pageInfo{hasNextPage hasPreviousPage endCursor startCursor}}}`,
            { first: p.first ?? 50, after: p.after, query: p.query, sortKey: p.sortKey ?? "UPDATED_AT", reverse: p.reverse ?? false });
          return text(res.data);
        }
        case "get": {
          if (!p.id && !p.handle) return fail("Provide id or handle");
          if (p.id) {
            const res = await gql(`query($id:ID!){product(id:$id){${PRODUCT_FULL}}}`, { id: p.id });
            return text(res.data);
          }
          const res = await gql(`query($handle:String!){productByHandle(handle:$handle){${PRODUCT_FULL}}}`, { handle: p.handle });
          return text(res.data);
        }
        case "search": {
          if (!p.query) return fail("query required");
          const res = await gql(`query($query:String!,$first:Int!){products(first:$first,query:$query){edges{node{${PRODUCT_SUMMARY}}}}}`, { query: p.query, first: p.first ?? 25 });
          return text(res.data);
        }
        case "count": {
          const res = await gql(`query($query:String){productsCount(query:$query){count}}`, { query: p.query });
          return text(res.data);
        }
        case "create": {
          if (!p.title) return fail("title required");
          const input: Record<string, unknown> = {};
          for (const k of ["title", "descriptionHtml", "handle", "vendor", "productType", "status", "tags", "templateSuffix", "productOptions", "collectionsToJoin", "seo", "metafields"] as const) {
            if (p[k] !== undefined) input[k] = p[k];
          }
          const res = await gql<{ productCreate: { product: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($product:ProductCreateInput!){productCreate(product:$product){product{${PRODUCT_FULL}}userErrors{field message}}}`, { product: input });
          checkErrors(res.data?.productCreate?.userErrors, "productCreate");
          return text(res.data?.productCreate?.product);
        }
        case "update": {
          if (!p.id) return fail("id required");
          const input: Record<string, unknown> = { id: p.id };
          for (const k of ["title", "descriptionHtml", "handle", "vendor", "productType", "status", "tags", "templateSuffix", "collectionsToJoin", "collectionsToLeave", "seo", "metafields"] as const) {
            if (p[k] !== undefined) input[k] = p[k];
          }
          const res = await gql<{ productUpdate: { product: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($product:ProductUpdateInput!){productUpdate(product:$product){product{${PRODUCT_FULL}}userErrors{field message}}}`, { product: input });
          checkErrors(res.data?.productUpdate?.userErrors, "productUpdate");
          return text(res.data?.productUpdate?.product);
        }
        case "delete": {
          if (!p.id) return fail("id required");
          const res = await gql<{ productDelete: { deletedProductId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:ProductDeleteInput!){productDelete(input:$input){deletedProductId userErrors{field message}}}`, { input: { id: p.id } });
          checkErrors(res.data?.productDelete?.userErrors, "productDelete");
          return text(`Product ${res.data?.productDelete?.deletedProductId} deleted.`);
        }
        case "add_media": {
          if (!p.productId || !p.media) return fail("productId and media required");
          const res = await gql<{ productSet: { product: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($synchronous:Boolean!,$input:ProductSetInput!){productSet(synchronous:$synchronous,input:$input){product{id title media(first:20){edges{node{...on MediaImage{id image{url altText} status}}}}}userErrors{field message}}}`,
            { synchronous: true, input: { id: p.productId, media: p.media } });
          checkErrors(res.data?.productSet?.userErrors, "productSet");
          return text(res.data?.productSet?.product);
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}

// ============================================================
// VARIANTS
// ============================================================

export function registerVariantGateway(server: McpServer): void {
  server.tool(
    "shopify_variants",
    `Manage product variants. Actions:
- create: Bulk create variants (params: productId, variants[{price?, compareAtPrice?, barcode?, taxable?, inventoryPolicy?, inventoryItem?, optionValues[{optionName, name}], metafields?}], strategy?)
- update: Bulk update variants (params: productId, variants[{id, price?, compareAtPrice?, barcode?, taxable?, inventoryPolicy?, inventoryItem?, metafields?}])
- delete: Bulk delete variants (params: productId, variantIds[])`,
    {
      action: z.enum(["create", "update", "delete"]),
      productId: z.string().describe("Product GID"),
      strategy: z.enum(["DEFAULT", "REMOVE_STANDALONE_VARIANT"]).optional(),
      variants: z.array(z.record(z.string(), z.unknown())).optional().describe("Variant data array"),
      variantIds: z.array(z.string()).optional().describe("Variant GIDs to delete"),
    },
    async ({ action, productId, strategy, variants, variantIds }) => {
      if (action === "create") {
        if (!variants) return fail("variants required");
        const res = await gql<{ productVariantsBulkCreate: { productVariants: unknown[]; userErrors: Array<{ field: string[]; message: string }> } }>(
          `mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!,$strategy:ProductVariantsBulkCreateStrategy){productVariantsBulkCreate(productId:$productId,variants:$variants,strategy:$strategy){productVariants{id title sku price compareAtPrice inventoryQuantity selectedOptions{name value}}userErrors{field message}}}`,
          { productId, variants, strategy: strategy ?? "REMOVE_STANDALONE_VARIANT" });
        checkErrors(res.data?.productVariantsBulkCreate?.userErrors, "productVariantsBulkCreate");
        return text(res.data?.productVariantsBulkCreate?.productVariants);
      }
      if (action === "update") {
        if (!variants) return fail("variants required");
        const res = await gql<{ productVariantsBulkUpdate: { productVariants: unknown[]; userErrors: Array<{ field: string[]; message: string }> } }>(
          `mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants){productVariants{id title sku price compareAtPrice inventoryQuantity selectedOptions{name value}}userErrors{field message}}}`,
          { productId, variants });
        checkErrors(res.data?.productVariantsBulkUpdate?.userErrors, "productVariantsBulkUpdate");
        return text(res.data?.productVariantsBulkUpdate?.productVariants);
      }
      // delete
      if (!variantIds) return fail("variantIds required");
      const res = await gql<{ productVariantsBulkDelete: { product: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
        `mutation($productId:ID!,$variantsIds:[ID!]!){productVariantsBulkDelete(productId:$productId,variantsIds:$variantsIds){product{id}userErrors{field message}}}`,
        { productId, variantsIds: variantIds });
      checkErrors(res.data?.productVariantsBulkDelete?.userErrors, "productVariantsBulkDelete");
      return text(`Deleted ${variantIds.length} variant(s).`);
    },
  );
}

// ============================================================
// COLLECTIONS
// ============================================================

const COLLECTION_SUMMARY = `id title handle sortOrder updatedAt productsCount{count} image{url altText} ruleSet{appliedDisjunctively rules{column relation condition}}`;
const COLLECTION_FULL = `id title handle descriptionHtml sortOrder templateSuffix updatedAt productsCount{count} image{url altText width height} seo{title description} ruleSet{appliedDisjunctively rules{column relation condition}} metafields(first:25){edges{node{id namespace key value type}}}`;

export function registerCollectionGateway(server: McpServer): void {
  server.tool(
    "shopify_collections",
    `Manage collections. Actions:
- list: List collections (params: first?, after?, query?, sortKey?, reverse?)
- get: Get collection by ID or handle (params: id?, handle?)
- count: Count collections (params: query?)
- create: Create manual collection (params: title, descriptionHtml?, sortOrder?, image?, seo?, metafields?)
- create_smart: Create smart collection with rules (params: title, ruleSet{appliedDisjunctively, rules[{column, relation, condition}]}, descriptionHtml?, sortOrder?, seo?)
- update: Update collection (params: id, title?, descriptionHtml?, sortOrder?, ruleSet?, seo?, metafields?)
- delete: Delete collection (params: id)
- add_products: Add products to manual collection (params: collectionId, productIds[])
- remove_products: Remove products (params: collectionId, productIds[])
- list_products: List products in collection (params: collectionId, first?, after?)
- reorder: Reorder products (params: collectionId, moves[{id, newPosition}])`,
    {
      action: z.enum(["list", "get", "count", "create", "create_smart", "update", "delete", "add_products", "remove_products", "list_products", "reorder"]),
      id: z.string().optional(),
      handle: z.string().optional(),
      query: z.string().optional(),
      first: z.number().optional(),
      after: z.string().optional(),
      sortKey: z.string().optional(),
      reverse: z.boolean().optional(),
      title: z.string().optional(),
      descriptionHtml: z.string().optional(),
      sortOrder: z.string().optional(),
      templateSuffix: z.string().optional(),
      image: z.object({ src: z.string(), altText: z.string().optional() }).optional(),
      ruleSet: z.object({ appliedDisjunctively: z.boolean(), rules: z.array(z.object({ column: z.string(), relation: z.string(), condition: z.string(), conditionObjectId: z.string().optional() })) }).optional(),
      seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),
      metafields: z.array(z.object({ namespace: z.string(), key: z.string(), value: z.string(), type: z.string() })).optional(),
      collectionId: z.string().optional(),
      productIds: z.array(z.string()).optional(),
      moves: z.array(z.object({ id: z.string(), newPosition: z.string() })).optional(),
    },
    async ({ action, ...p }) => {
      switch (action) {
        case "list": {
          const res = await gql(`query($first:Int!,$after:String,$query:String,$sortKey:CollectionSortKeys!,$reverse:Boolean!){collections(first:$first,after:$after,query:$query,sortKey:$sortKey,reverse:$reverse){edges{cursor node{${COLLECTION_SUMMARY}}}pageInfo{hasNextPage hasPreviousPage endCursor startCursor}}}`,
            { first: p.first ?? 50, after: p.after, query: p.query, sortKey: p.sortKey ?? "UPDATED_AT", reverse: p.reverse ?? false });
          return text(res.data);
        }
        case "get": {
          if (!p.id && !p.handle) return fail("Provide id or handle");
          if (p.id) { const res = await gql(`query($id:ID!){collection(id:$id){${COLLECTION_FULL}}}`, { id: p.id }); return text(res.data); }
          const res = await gql(`query($handle:String!){collectionByHandle(handle:$handle){${COLLECTION_FULL}}}`, { handle: p.handle });
          return text(res.data);
        }
        case "count": {
          const res = await gql(`query($query:String){collectionsCount(query:$query){count}}`, { query: p.query });
          return text(res.data);
        }
        case "create":
        case "create_smart": {
          if (!p.title) return fail("title required");
          const input: Record<string, unknown> = {};
          for (const k of ["title", "descriptionHtml", "sortOrder", "templateSuffix", "image", "ruleSet", "seo", "metafields"] as const) {
            if (p[k] !== undefined) input[k] = p[k];
          }
          const res = await gql<{ collectionCreate: { collection: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:CollectionInput!){collectionCreate(input:$input){collection{${COLLECTION_FULL}}userErrors{field message}}}`, { input });
          checkErrors(res.data?.collectionCreate?.userErrors, "collectionCreate");
          return text(res.data?.collectionCreate?.collection);
        }
        case "update": {
          if (!p.id) return fail("id required");
          const input: Record<string, unknown> = { id: p.id };
          for (const k of ["title", "descriptionHtml", "sortOrder", "templateSuffix", "image", "ruleSet", "seo", "metafields"] as const) {
            if (p[k] !== undefined) input[k] = p[k];
          }
          const res = await gql<{ collectionUpdate: { collection: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:CollectionInput!){collectionUpdate(input:$input){collection{${COLLECTION_FULL}}userErrors{field message}}}`, { input });
          checkErrors(res.data?.collectionUpdate?.userErrors, "collectionUpdate");
          return text(res.data?.collectionUpdate?.collection);
        }
        case "delete": {
          if (!p.id) return fail("id required");
          const res = await gql<{ collectionDelete: { deletedCollectionId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:CollectionDeleteInput!){collectionDelete(input:$input){deletedCollectionId userErrors{field message}}}`, { input: { id: p.id } });
          checkErrors(res.data?.collectionDelete?.userErrors, "collectionDelete");
          return text(`Collection ${res.data?.collectionDelete?.deletedCollectionId} deleted.`);
        }
        case "add_products": {
          if (!p.collectionId || !p.productIds) return fail("collectionId and productIds required");
          const res = await gql<{ collectionAddProducts: { collection: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$productIds:[ID!]!){collectionAddProducts(id:$id,productIds:$productIds){collection{id productsCount{count}}userErrors{field message}}}`,
            { id: p.collectionId, productIds: p.productIds });
          checkErrors(res.data?.collectionAddProducts?.userErrors, "collectionAddProducts");
          return text(res.data?.collectionAddProducts?.collection);
        }
        case "remove_products": {
          if (!p.collectionId || !p.productIds) return fail("collectionId and productIds required");
          const res = await gql<{ collectionRemoveProducts: { userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$productIds:[ID!]!){collectionRemoveProducts(id:$id,productIds:$productIds){userErrors{field message}}}`,
            { id: p.collectionId, productIds: p.productIds });
          checkErrors(res.data?.collectionRemoveProducts?.userErrors, "collectionRemoveProducts");
          return text(`Removed ${p.productIds.length} product(s).`);
        }
        case "list_products": {
          if (!p.collectionId) return fail("collectionId required");
          const res = await gql(`query($id:ID!,$first:Int!,$after:String){collection(id:$id){id title products(first:$first,after:$after){edges{cursor node{id title handle status vendor totalInventory featuredMedia{...on MediaImage{image{url altText}}} variants(first:3){edges{node{id title price sku}}}}}pageInfo{hasNextPage endCursor}}}}`,
            { id: p.collectionId, first: p.first ?? 50, after: p.after });
          return text(res.data);
        }
        case "reorder": {
          if (!p.collectionId || !p.moves) return fail("collectionId and moves required");
          const res = await gql<{ collectionReorderProducts: { userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$moves:[MoveInput!]!){collectionReorderProducts(id:$id,moves:$moves){userErrors{field message}}}`,
            { id: p.collectionId, moves: p.moves });
          checkErrors(res.data?.collectionReorderProducts?.userErrors, "collectionReorderProducts");
          return text(`Reordered ${p.moves.length} product(s).`);
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}

// ============================================================
// METAFIELDS (shared across resources)
// ============================================================

export function registerMetafieldGateway(server: McpServer): void {
  server.tool(
    "shopify_metafields",
    `Manage metafields on any resource (products, collections, customers, orders, etc.). Actions:
- set: Set metafields (params: metafields[{ownerId, namespace, key, value, type}])
- delete: Delete metafields (params: metafields[{ownerId, namespace, key}])`,
    {
      action: z.enum(["set", "delete"]),
      metafields: z.array(z.record(z.string(), z.string())).describe("Metafield data. For set: ownerId, namespace, key, value, type. For delete: ownerId, namespace, key."),
    },
    async ({ action, metafields }) => {
      if (action === "set") {
        const res = await gql<{ metafieldsSet: { metafields: unknown[]; userErrors: Array<{ field: string[]; message: string }> } }>(
          `mutation($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){metafields{id namespace key value type}userErrors{field message}}}`,
          { metafields });
        checkErrors(res.data?.metafieldsSet?.userErrors, "metafieldsSet");
        return text(res.data?.metafieldsSet?.metafields);
      }
      // delete
      const res = await gql<{ metafieldsDelete: { deletedMetafields: unknown[]; userErrors: Array<{ field: string[]; message: string }> } }>(
        `mutation($metafields:[MetafieldIdentifierInput!]!){metafieldsDelete(metafields:$metafields){deletedMetafields{ownerId key namespace}userErrors{field message}}}`,
        { metafields });
      checkErrors(res.data?.metafieldsDelete?.userErrors, "metafieldsDelete");
      return text(`Deleted ${metafields.length} metafield(s).`);
    },
  );
}

// ============================================================
// CUSTOMERS
// ============================================================

const CUSTOMER_SUMMARY = `id firstName lastName displayName state tags numberOfOrders amountSpent{amount currencyCode} defaultEmailAddress{emailAddress} defaultPhoneNumber{phoneNumber} createdAt updatedAt`;
const CUSTOMER_FULL = `id firstName lastName displayName state note tags taxExempt taxExemptions locale createdAt updatedAt verifiedEmail numberOfOrders amountSpent{amount currencyCode} defaultEmailAddress{emailAddress validFormat marketingState marketingOptInLevel marketingUpdatedAt} defaultPhoneNumber{phoneNumber marketingState marketingOptInLevel marketingUpdatedAt} defaultAddress{id firstName lastName company address1 address2 city province provinceCode country countryCodeV2 zip phone} addressesV2(first:10){edges{node{id firstName lastName company address1 address2 city province provinceCode country countryCodeV2 zip phone}}} metafields(first:25){edges{node{id namespace key value type}}}`;

export function registerCustomerGateway(server: McpServer): void {
  server.tool(
    "shopify_customers",
    `Manage customers. Actions:
- list: List customers (params: first?, after?, query?, sortKey?, reverse?)
- get: Get customer by ID (params: id)
- search: Search customers (params: query, first?)
- count: Count customers (params: query?)
- create: Create customer (params: firstName?, lastName?, email?, phone?, note?, tags?, locale?, taxExempt?, metafields?)
- update: Update customer (params: id, firstName?, lastName?, email?, phone?, note?, tags?, locale?, taxExempt?, metafields?)
- delete: Delete customer (params: id) — only if no orders
- add_tags: Add tags (params: id, tags[])
- remove_tags: Remove tags (params: id, tags[])
- update_email_consent: Update email marketing (params: customerId, marketingState, marketingOptInLevel?)
- activation_url: Generate activation URL (params: customerId)`,
    {
      action: z.enum(["list", "get", "search", "count", "create", "update", "delete", "add_tags", "remove_tags", "update_email_consent", "activation_url"]),
      id: z.string().optional(),
      customerId: z.string().optional(),
      query: z.string().optional(),
      first: z.number().optional(),
      after: z.string().optional(),
      sortKey: z.string().optional(),
      reverse: z.boolean().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      note: z.string().optional(),
      tags: z.array(z.string()).optional(),
      locale: z.string().optional(),
      taxExempt: z.boolean().optional(),
      metafields: z.array(z.object({ namespace: z.string(), key: z.string(), value: z.string(), type: z.string() })).optional(),
      marketingState: z.enum(["SUBSCRIBED", "UNSUBSCRIBED", "PENDING"]).optional(),
      marketingOptInLevel: z.enum(["SINGLE_OPT_IN", "CONFIRMED_OPT_IN", "UNKNOWN"]).optional(),
    },
    async ({ action, ...p }) => {
      switch (action) {
        case "list": {
          const res = await gql(`query($first:Int!,$after:String,$query:String,$sortKey:CustomerSortKeys!,$reverse:Boolean!){customers(first:$first,after:$after,query:$query,sortKey:$sortKey,reverse:$reverse){edges{cursor node{${CUSTOMER_SUMMARY}}}pageInfo{hasNextPage hasPreviousPage endCursor startCursor}}}`,
            { first: p.first ?? 50, after: p.after, query: p.query, sortKey: p.sortKey ?? "UPDATED_AT", reverse: p.reverse ?? false });
          return text(res.data);
        }
        case "get": {
          if (!p.id) return fail("id required");
          const res = await gql(`query($id:ID!){customer(id:$id){${CUSTOMER_FULL}}}`, { id: p.id });
          return text(res.data);
        }
        case "search": {
          if (!p.query) return fail("query required");
          const res = await gql(`query($query:String!,$first:Int!){customers(first:$first,query:$query){edges{node{${CUSTOMER_SUMMARY}}}}}`, { query: p.query, first: p.first ?? 25 });
          return text(res.data);
        }
        case "count": {
          const res = await gql(`query($query:String){customersCount(query:$query){count}}`, { query: p.query });
          return text(res.data);
        }
        case "create": {
          const input: Record<string, unknown> = {};
          for (const k of ["firstName", "lastName", "email", "phone", "note", "tags", "locale", "taxExempt", "metafields"] as const) {
            if (p[k] !== undefined) input[k] = p[k];
          }
          const res = await gql<{ customerCreate: { customer: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:CustomerInput!){customerCreate(input:$input){customer{${CUSTOMER_FULL}}userErrors{field message}}}`, { input });
          checkErrors(res.data?.customerCreate?.userErrors, "customerCreate");
          return text(res.data?.customerCreate?.customer);
        }
        case "update": {
          if (!p.id) return fail("id required");
          const input: Record<string, unknown> = { id: p.id };
          for (const k of ["firstName", "lastName", "email", "phone", "note", "tags", "locale", "taxExempt", "metafields"] as const) {
            if (p[k] !== undefined) input[k] = p[k];
          }
          const res = await gql<{ customerUpdate: { customer: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:CustomerInput!){customerUpdate(input:$input){customer{${CUSTOMER_FULL}}userErrors{field message}}}`, { input });
          checkErrors(res.data?.customerUpdate?.userErrors, "customerUpdate");
          return text(res.data?.customerUpdate?.customer);
        }
        case "delete": {
          if (!p.id) return fail("id required");
          const res = await gql<{ customerDelete: { deletedCustomerId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:CustomerDeleteInput!){customerDelete(input:$input){deletedCustomerId userErrors{field message}}}`, { input: { id: p.id } });
          checkErrors(res.data?.customerDelete?.userErrors, "customerDelete");
          return text(`Customer ${res.data?.customerDelete?.deletedCustomerId} deleted.`);
        }
        case "add_tags": {
          if (!p.id || !p.tags) return fail("id and tags required");
          const res = await gql<{ tagsAdd: { userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){node{id}userErrors{field message}}}`, { id: p.id, tags: p.tags });
          checkErrors(res.data?.tagsAdd?.userErrors, "tagsAdd");
          return text(`Added ${p.tags.length} tag(s).`);
        }
        case "remove_tags": {
          if (!p.id || !p.tags) return fail("id and tags required");
          const res = await gql<{ tagsRemove: { userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$tags:[String!]!){tagsRemove(id:$id,tags:$tags){node{id}userErrors{field message}}}`, { id: p.id, tags: p.tags });
          checkErrors(res.data?.tagsRemove?.userErrors, "tagsRemove");
          return text(`Removed ${p.tags.length} tag(s).`);
        }
        case "update_email_consent": {
          const cid = p.customerId ?? p.id;
          if (!cid || !p.marketingState) return fail("customerId and marketingState required");
          const res = await gql<{ customerEmailMarketingConsentUpdate: { customer: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:CustomerEmailMarketingConsentUpdateInput!){customerEmailMarketingConsentUpdate(input:$input){customer{id defaultEmailAddress{emailAddress marketingState marketingOptInLevel marketingUpdatedAt}}userErrors{field message}}}`,
            { input: { customerId: cid, emailMarketingConsent: { marketingState: p.marketingState, marketingOptInLevel: p.marketingOptInLevel } } });
          checkErrors(res.data?.customerEmailMarketingConsentUpdate?.userErrors, "customerEmailMarketingConsentUpdate");
          return text(res.data?.customerEmailMarketingConsentUpdate?.customer);
        }
        case "activation_url": {
          const cid = p.customerId ?? p.id;
          if (!cid) return fail("customerId required");
          const res = await gql<{ customerGenerateAccountActivationUrl: { accountActivationUrl: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($customerId:ID!){customerGenerateAccountActivationUrl(customerId:$customerId){accountActivationUrl userErrors{field message}}}`, { customerId: cid });
          checkErrors(res.data?.customerGenerateAccountActivationUrl?.userErrors, "customerGenerateAccountActivationUrl");
          return text(res.data?.customerGenerateAccountActivationUrl?.accountActivationUrl ?? "null");
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}
