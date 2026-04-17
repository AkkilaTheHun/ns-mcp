import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

const ORDER_FIELDS = `
  id
  name
  createdAt
  updatedAt
  processedAt
  closedAt
  cancelledAt
  cancelReason
  displayFinancialStatus
  displayFulfillmentStatus
  returnStatus
  confirmed
  test
  note
  tags
  email
  phone
  currencyCode
  presentmentCurrencyCode
  totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  subtotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  totalTaxSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  currentTotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  customer {
    id
    displayName
    email
  }
  shippingAddress {
    firstName
    lastName
    company
    address1
    address2
    city
    province
    provinceCode
    country
    countryCodeV2
    zip
    phone
  }
  billingAddress {
    firstName
    lastName
    company
    address1
    address2
    city
    province
    provinceCode
    country
    countryCodeV2
    zip
    phone
  }
  lineItems(first: 50) {
    edges {
      node {
        id
        title
        quantity
        sku
        variantTitle
        vendor
        originalTotalSet { shopMoney { amount currencyCode } }
        discountedTotalSet { shopMoney { amount currencyCode } }
        variant {
          id
          title
          sku
          price
        }
      }
    }
  }
  fulfillments {
    id
    status
    createdAt
    trackingInfo {
      number
      url
      company
    }
  }
  transactions(first: 10) {
    id
    kind
    status
    amountSet { shopMoney { amount currencyCode } }
    gateway
    createdAt
  }
  refunds {
    id
    createdAt
    note
    totalRefundedSet { shopMoney { amount currencyCode } }
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

const ORDER_SUMMARY_FIELDS = `
  id
  name
  createdAt
  updatedAt
  displayFinancialStatus
  displayFulfillmentStatus
  returnStatus
  confirmed
  note
  tags
  email
  totalPriceSet { shopMoney { amount currencyCode } }
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  customer {
    id
    displayName
    email
  }
`;

export function registerOrderTools(server: McpServer): void {
  // --- List Orders ---
  server.tool(
    "list_orders",
    "List orders with optional filtering, sorting, and pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of orders to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query (e.g. 'financial_status:paid', 'fulfillment_status:unfulfilled', 'tag:rush', 'created_at:>2024-01-01')"),
      sortKey: z.enum(["CREATED_AT", "CUSTOMER_NAME", "FINANCIAL_STATUS", "FULFILLMENT_STATUS", "ID", "ORDER_NUMBER", "PROCESSED_AT", "RELEVANCE", "TOTAL_PRICE", "UPDATED_AT"]).default("CREATED_AT"),
      reverse: z.boolean().default(true),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ orders: unknown }>(`
        query Orders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys!, $reverse: Boolean!) {
          orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${ORDER_SUMMARY_FIELDS} }
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

  // --- Get Order ---
  server.tool(
    "get_order",
    "Get full details of a single order by ID.",
    {
      id: z.string().describe("Order GID (e.g. gid://shopify/Order/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL(`
        query GetOrder($id: ID!) {
          order(id: $id) { ${ORDER_FIELDS} }
        }
      `, { id });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Search Orders ---
  server.tool(
    "search_orders",
    "Search orders using Shopify search syntax.",
    {
      query: z.string().describe("Search query (e.g. 'name:#1001', 'email:john@example.com', 'financial_status:paid AND fulfillment_status:shipped', 'tag:express')"),
      first: z.number().min(1).max(250).default(25),
    },
    async ({ query, first }) => {
      const res = await shopifyGraphQL<{ orders: unknown }>(`
        query SearchOrders($query: String!, $first: Int!) {
          orders(first: $first, query: $query) {
            edges {
              node { ${ORDER_SUMMARY_FIELDS} }
            }
          }
        }
      `, { query, first });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Count Orders ---
  server.tool(
    "count_orders",
    "Get the total number of orders, optionally filtered.",
    {
      query: z.string().optional().describe("Optional filter query"),
    },
    async ({ query }) => {
      const res = await shopifyGraphQL<{ ordersCount: { count: number } }>(`
        query OrdersCount($query: String) {
          ordersCount(query: $query) {
            count
          }
        }
      `, { query });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Update Order ---
  server.tool(
    "update_order",
    "Update an existing order's fields (tags, note, email, shippingAddress, metafields).",
    {
      id: z.string().describe("Order GID"),
      tags: z.array(z.string()).optional().describe("Tags (replaces all existing tags)"),
      note: z.string().optional().describe("Order note"),
      email: z.string().optional().describe("Customer email on the order"),
      shippingAddress: z.object({
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
      }).optional().describe("Shipping address fields to update"),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).optional(),
    },
    async ({ id, tags, note, email, shippingAddress, metafields }) => {
      const input: Record<string, unknown> = { id };
      if (tags !== undefined) input.tags = tags;
      if (note !== undefined) input.note = note;
      if (email !== undefined) input.email = email;
      if (shippingAddress !== undefined) input.shippingAddress = shippingAddress;
      if (metafields !== undefined) input.metafields = metafields;

      const res = await shopifyGraphQL<{
        orderUpdate: { order: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation OrderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { ${ORDER_FIELDS} }
            userErrors { field message }
          }
        }
      `, { input });

      throwIfUserErrors(res.data?.orderUpdate?.userErrors, "orderUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.orderUpdate?.order) }] };
    },
  );

  // --- Cancel Order ---
  server.tool(
    "cancel_order",
    "Cancel an order. Optionally specify reason, refund, restock, and notification preferences.",
    {
      orderId: z.string().describe("Order GID"),
      reason: z.enum(["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "OTHER", "STAFF"]).optional().describe("Cancellation reason"),
      notifyCustomer: z.boolean().default(false).describe("Whether to notify the customer"),
      refund: z.boolean().default(false).describe("Whether to refund the order"),
      restock: z.boolean().default(false).describe("Whether to restock the items"),
      staffNote: z.string().optional().describe("Staff note about the cancellation"),
    },
    async ({ orderId, reason, notifyCustomer, refund, restock, staffNote }) => {
      const res = await shopifyGraphQL<{
        orderCancel: { order: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!, $notifyCustomer: Boolean, $refund: Boolean, $restock: Boolean, $staffNote: String) {
          orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: $notifyCustomer, refund: $refund, restock: $restock, staffNote: $staffNote) {
            order {
              id
              name
              cancelledAt
              cancelReason
              displayFinancialStatus
              displayFulfillmentStatus
            }
            userErrors { field message }
          }
        }
      `, { orderId, reason: reason ?? "OTHER", notifyCustomer, refund, restock, staffNote });

      throwIfUserErrors(res.data?.orderCancel?.userErrors, "orderCancel");
      return { content: [{ type: "text" as const, text: toText(res.data?.orderCancel?.order) }] };
    },
  );

  // --- Close Order ---
  server.tool(
    "close_order",
    "Close an order (mark it as completed/archived).",
    {
      id: z.string().describe("Order GID"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        orderClose: { order: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation OrderClose($input: OrderCloseInput!) {
          orderClose(input: $input) {
            order {
              id
              name
              closedAt
              displayFinancialStatus
              displayFulfillmentStatus
            }
            userErrors { field message }
          }
        }
      `, { input: { id } });

      throwIfUserErrors(res.data?.orderClose?.userErrors, "orderClose");
      return { content: [{ type: "text" as const, text: toText(res.data?.orderClose?.order) }] };
    },
  );

  // --- Add Order Tags ---
  server.tool(
    "add_order_tags",
    "Add tags to an order without removing existing tags.",
    {
      id: z.string().describe("Order GID"),
      tags: z.array(z.string()).describe("Tags to add"),
    },
    async ({ id, tags }) => {
      const res = await shopifyGraphQL<{
        tagsAdd: { node: { id: string }; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation TagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }
      `, { id, tags });

      throwIfUserErrors(res.data?.tagsAdd?.userErrors, "tagsAdd");
      return { content: [{ type: "text" as const, text: `Added ${tags.length} tag(s) to order.` }] };
    },
  );

  // --- Remove Order Tags ---
  server.tool(
    "remove_order_tags",
    "Remove tags from an order.",
    {
      id: z.string().describe("Order GID"),
      tags: z.array(z.string()).describe("Tags to remove"),
    },
    async ({ id, tags }) => {
      const res = await shopifyGraphQL<{
        tagsRemove: { node: { id: string }; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation TagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }
      `, { id, tags });

      throwIfUserErrors(res.data?.tagsRemove?.userErrors, "tagsRemove");
      return { content: [{ type: "text" as const, text: `Removed ${tags.length} tag(s) from order.` }] };
    },
  );

  // --- Set Order Metafields ---
  server.tool(
    "set_order_metafields",
    "Set metafields on an order (creates or updates).",
    {
      orderId: z.string().describe("Order GID"),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).describe("Metafields to set"),
    },
    async ({ orderId, metafields }) => {
      const metafieldsInput = metafields.map((mf) => ({
        ownerId: orderId,
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

  // --- Create Order Note ---
  server.tool(
    "create_order_note",
    "Add or update a note on an order.",
    {
      id: z.string().describe("Order GID"),
      note: z.string().describe("Note text to set on the order"),
    },
    async ({ id, note }) => {
      const res = await shopifyGraphQL<{
        orderUpdate: { order: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation OrderUpdateNote($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
              name
              note
            }
            userErrors { field message }
          }
        }
      `, { input: { id, note } });

      throwIfUserErrors(res.data?.orderUpdate?.userErrors, "orderUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.orderUpdate?.order) }] };
    },
  );
}
