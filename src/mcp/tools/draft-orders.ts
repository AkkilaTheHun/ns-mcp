import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

const DRAFT_ORDER_SUMMARY_FIELDS = `
  id
  name
  status
  currencyCode
  totalPriceSet { shopMoney { amount currencyCode } }
  note2
  tags
  createdAt
  updatedAt
  customer {
    id
    displayName
    defaultEmailAddress { emailAddress }
  }
  lineItems(first: 5) {
    edges {
      node {
        id
        name
        quantity
        originalUnitPriceWithCurrency { amount currencyCode }
      }
    }
  }
`;

const DRAFT_ORDER_FIELDS = `
  id
  name
  status
  phone
  currencyCode
  note2
  tags
  taxExempt
  taxesIncluded
  totalPriceSet { shopMoney { amount currencyCode } }
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalTaxSet { shopMoney { amount currencyCode } }
  invoiceUrl
  completedAt
  createdAt
  updatedAt
  customer {
    id
    displayName
    defaultEmailAddress { emailAddress }
  }
  lineItems(first: 50) {
    edges {
      node {
        id
        name
        sku
        quantity
        originalUnitPriceWithCurrency { amount currencyCode }
        variant { id title }
        product { id }
        appliedDiscount { title value valueType }
      }
    }
  }
  shippingAddress {
    firstName lastName company
    address1 address2 city province provinceCode
    country countryCodeV2 zip phone
  }
  billingAddress {
    firstName lastName company
    address1 address2 city province provinceCode
    country countryCodeV2 zip phone
  }
  shippingLine { title }
  appliedDiscount { title value valueType }
  order { id }
`;

const addressSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  country: z.string().optional(),
  zip: z.string().optional(),
  phone: z.string().optional(),
});

const lineItemSchema = z.object({
  title: z.string().optional().describe("Title for custom line items"),
  variantId: z.string().optional().describe("Product variant GID"),
  quantity: z.number().min(1).describe("Quantity"),
  originalUnitPrice: z.string().optional().describe("Unit price for custom line items (e.g. '14.99')"),
  appliedDiscount: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    value: z.number(),
    valueType: z.enum(["FIXED_AMOUNT", "PERCENTAGE"]),
  }).optional(),
  weight: z.object({
    value: z.number(),
    unit: z.enum(["KILOGRAMS", "GRAMS", "POUNDS", "OUNCES"]),
  }).optional(),
  customAttributes: z.array(z.object({
    key: z.string(),
    value: z.string(),
  })).optional(),
});

export function registerDraftOrderTools(server: McpServer): void {
  // --- List Draft Orders ---
  server.tool(
    "list_draft_orders",
    "List draft orders with optional filtering, sorting, and pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of draft orders to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query (e.g. 'status:open', 'tag:wholesale', 'customer_id:123')"),
      sortKey: z.enum(["CUSTOMER_NAME", "ID", "NUMBER", "RELEVANCE", "STATUS", "TOTAL_PRICE", "UPDATED_AT"]).default("UPDATED_AT"),
      reverse: z.boolean().default(true),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ draftOrders: unknown }>(`
        query DraftOrders($first: Int!, $after: String, $query: String, $sortKey: DraftOrderSortKeys!, $reverse: Boolean!) {
          draftOrders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${DRAFT_ORDER_SUMMARY_FIELDS} }
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

  // --- Get Draft Order ---
  server.tool(
    "get_draft_order",
    "Get full details of a single draft order by ID.",
    {
      id: z.string().describe("Draft order GID (e.g. gid://shopify/DraftOrder/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL(`
        query GetDraftOrder($id: ID!) {
          draftOrder(id: $id) { ${DRAFT_ORDER_FIELDS} }
        }
      `, { id });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Create Draft Order ---
  server.tool(
    "create_draft_order",
    "Create a new draft order. Use for phone/chat orders, invoices, custom items, wholesale pricing, or pre-orders.",
    {
      lineItems: z.array(lineItemSchema).min(1).describe("Line items for the draft order"),
      customerId: z.string().optional().describe("Customer GID"),
      email: z.string().optional().describe("Customer email"),
      phone: z.string().optional().describe("Customer phone"),
      note: z.string().optional().describe("Note for the draft order"),
      tags: z.array(z.string()).optional(),
      taxExempt: z.boolean().optional(),
      shippingAddress: addressSchema.optional(),
      billingAddress: addressSchema.optional(),
      shippingLine: z.object({
        title: z.string().describe("Shipping method title"),
        price: z.number().describe("Shipping price"),
      }).optional(),
      appliedDiscount: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        value: z.number(),
        valueType: z.enum(["FIXED_AMOUNT", "PERCENTAGE"]),
      }).optional(),
      customAttributes: z.array(z.object({
        key: z.string(),
        value: z.string(),
      })).optional(),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).optional(),
    },
    async (input) => {
      const res = await shopifyGraphQL<{
        draftOrderCreate: { draftOrder: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation DraftOrderCreate($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder {
              id
              name
              status
              totalPriceSet { shopMoney { amount currencyCode } }
              invoiceUrl
              createdAt
              lineItems(first: 10) {
                edges {
                  node {
                    id
                    name
                    quantity
                    originalUnitPriceWithCurrency { amount currencyCode }
                  }
                }
              }
            }
            userErrors { field message }
          }
        }
      `, { input });

      throwIfUserErrors(res.data?.draftOrderCreate?.userErrors, "draftOrderCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.draftOrderCreate?.draftOrder) }] };
    },
  );

  // --- Update Draft Order ---
  server.tool(
    "update_draft_order",
    "Update an existing draft order. Can modify line items, customer info, addresses, discounts, notes, and tags.",
    {
      id: z.string().describe("Draft order GID"),
      lineItems: z.array(lineItemSchema).optional().describe("Replace line items"),
      customerId: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      note: z.string().optional(),
      tags: z.array(z.string()).optional(),
      taxExempt: z.boolean().optional(),
      shippingAddress: addressSchema.optional(),
      billingAddress: addressSchema.optional(),
      shippingLine: z.object({
        title: z.string(),
        price: z.number(),
      }).optional(),
      appliedDiscount: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        value: z.number(),
        valueType: z.enum(["FIXED_AMOUNT", "PERCENTAGE"]),
      }).optional(),
    },
    async ({ id, ...fields }) => {
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) input[k] = v;
      }

      const res = await shopifyGraphQL<{
        draftOrderUpdate: { draftOrder: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) {
            draftOrder {
              id
              name
              status
              totalPriceSet { shopMoney { amount currencyCode } }
              updatedAt
            }
            userErrors { field message }
          }
        }
      `, { id, input });

      throwIfUserErrors(res.data?.draftOrderUpdate?.userErrors, "draftOrderUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.draftOrderUpdate?.draftOrder) }] };
    },
  );

  // --- Complete Draft Order ---
  server.tool(
    "complete_draft_order",
    "Complete a draft order and convert it into a regular order. Marks the order as paid and reserves inventory.",
    {
      id: z.string().describe("Draft order GID"),
      paymentGatewayId: z.string().optional().describe("Payment gateway GID for specific payment processing"),
    },
    async ({ id, paymentGatewayId }) => {
      const res = await shopifyGraphQL<{
        draftOrderComplete: { draftOrder: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation DraftOrderComplete($id: ID!, $paymentGatewayId: ID) {
          draftOrderComplete(id: $id, paymentGatewayId: $paymentGatewayId) {
            draftOrder {
              id
              name
              status
              order { id name }
            }
            userErrors { field message }
          }
        }
      `, { id, paymentGatewayId });

      throwIfUserErrors(res.data?.draftOrderComplete?.userErrors, "draftOrderComplete");
      return { content: [{ type: "text" as const, text: toText(res.data?.draftOrderComplete?.draftOrder) }] };
    },
  );

  // --- Delete Draft Order ---
  server.tool(
    "delete_draft_order",
    "Delete a draft order.",
    {
      id: z.string().describe("Draft order GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        draftOrderDelete: { deletedId: string; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
          draftOrderDelete(input: $input) {
            deletedId
            userErrors { field message }
          }
        }
      `, { input: { id } });

      throwIfUserErrors(res.data?.draftOrderDelete?.userErrors, "draftOrderDelete");
      return { content: [{ type: "text" as const, text: `Draft order ${res.data?.draftOrderDelete?.deletedId} deleted.` }] };
    },
  );
}
