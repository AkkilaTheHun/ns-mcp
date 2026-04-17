import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

const DISCOUNT_NODE_FIELDS = `
  id
  discount {
    ... on DiscountAutomaticBasic {
      title
      status
      startsAt
      endsAt
      summary
      asyncUsageCount
      minimumRequirement {
        ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
        ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
      }
      customerGets {
        value {
          ... on DiscountPercentage { percentage }
          ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
        }
        items {
          ... on AllDiscountItems { allItems }
        }
      }
      createdAt
      updatedAt
    }
    ... on DiscountCodeBasic {
      title
      status
      startsAt
      endsAt
      summary
      asyncUsageCount
      usageLimit
      appliesOncePerCustomer
      codes(first: 10) {
        edges {
          node {
            code
          }
        }
      }
      minimumRequirement {
        ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
        ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
      }
      customerGets {
        value {
          ... on DiscountPercentage { percentage }
          ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
        }
        items {
          ... on AllDiscountItems { allItems }
        }
      }
      createdAt
      updatedAt
    }
    ... on DiscountAutomaticApp {
      title
      status
      startsAt
      endsAt
      createdAt
      updatedAt
    }
    ... on DiscountCodeApp {
      title
      status
      startsAt
      endsAt
      createdAt
      updatedAt
    }
    ... on DiscountAutomaticBxgy {
      title
      status
      startsAt
      endsAt
      summary
      createdAt
      updatedAt
    }
    ... on DiscountCodeBxgy {
      title
      status
      startsAt
      endsAt
      summary
      createdAt
      updatedAt
    }
    ... on DiscountAutomaticFreeShipping {
      title
      status
      startsAt
      endsAt
      summary
      createdAt
      updatedAt
    }
    ... on DiscountCodeFreeShipping {
      title
      status
      startsAt
      endsAt
      summary
      createdAt
      updatedAt
    }
  }
`;

const DISCOUNT_SUMMARY_FIELDS = `
  id
  discount {
    ... on DiscountAutomaticBasic {
      title
      status
      startsAt
      endsAt
      summary
      asyncUsageCount
      createdAt
    }
    ... on DiscountCodeBasic {
      title
      status
      startsAt
      endsAt
      summary
      asyncUsageCount
      codes(first: 3) {
        edges { node { code } }
      }
      createdAt
    }
    ... on DiscountAutomaticApp {
      title
      status
      startsAt
      endsAt
      createdAt
    }
    ... on DiscountCodeApp {
      title
      status
      startsAt
      endsAt
      createdAt
    }
    ... on DiscountAutomaticBxgy {
      title
      status
      startsAt
      endsAt
      summary
      createdAt
    }
    ... on DiscountCodeBxgy {
      title
      status
      startsAt
      endsAt
      summary
      createdAt
    }
    ... on DiscountAutomaticFreeShipping {
      title
      status
      startsAt
      endsAt
      summary
      createdAt
    }
    ... on DiscountCodeFreeShipping {
      title
      status
      startsAt
      endsAt
      summary
      createdAt
    }
  }
`;

const AUTOMATIC_BASIC_RESULT_FIELDS = `
  automaticDiscountNode {
    id
    discount {
      ... on DiscountAutomaticBasic {
        title
        status
        startsAt
        endsAt
        summary
        customerGets {
          value {
            ... on DiscountPercentage { percentage }
            ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
          }
          items {
            ... on AllDiscountItems { allItems }
          }
        }
        minimumRequirement {
          ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
          ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
        }
        createdAt
        updatedAt
      }
    }
  }
  userErrors { field code message }
`;

const CODE_BASIC_RESULT_FIELDS = `
  codeDiscountNode {
    id
    discount {
      ... on DiscountCodeBasic {
        title
        status
        startsAt
        endsAt
        summary
        usageLimit
        appliesOncePerCustomer
        codes(first: 10) {
          edges { node { code } }
        }
        customerGets {
          value {
            ... on DiscountPercentage { percentage }
            ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
          }
          items {
            ... on AllDiscountItems { allItems }
          }
        }
        minimumRequirement {
          ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
          ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
        }
        createdAt
        updatedAt
      }
    }
  }
  userErrors { field code message }
`;

const customerGetsSchema = z.object({
  value: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("percentage"),
      percentage: z.number().min(0).max(1).describe("Percentage as decimal, e.g. 0.1 for 10%"),
    }),
    z.object({
      type: z.literal("fixedAmount"),
      amount: z.number().min(0).describe("Fixed discount amount"),
      appliesOnEachItem: z.boolean().default(false).describe("Whether the amount applies to each item vs the order"),
    }),
  ]).describe("Discount value: percentage (0-1) or fixed amount"),
  items: z.object({
    all: z.boolean().default(true).describe("Apply to all items"),
    products: z.array(z.string()).optional().describe("Product GIDs to apply to (if not all)"),
    collections: z.array(z.string()).optional().describe("Collection GIDs to apply to (if not all)"),
  }).default({ all: true }),
});

const minimumRequirementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("quantity"),
    greaterThanOrEqualToQuantity: z.string().describe("Minimum quantity (as string)"),
  }),
  z.object({
    type: z.literal("subtotal"),
    greaterThanOrEqualToSubtotal: z.number().describe("Minimum subtotal amount"),
  }),
]).default({ type: "none" });

function buildCustomerGetsInput(customerGets: z.infer<typeof customerGetsSchema>) {
  const value =
    customerGets.value.type === "percentage"
      ? { percentage: customerGets.value.percentage }
      : {
          discountAmount: {
            amount: customerGets.value.amount,
            appliesOnEachItem: customerGets.value.appliesOnEachItem,
          },
        };

  let items: Record<string, unknown>;
  if (customerGets.items.all) {
    items = { all: true };
  } else if (customerGets.items.products && customerGets.items.products.length > 0) {
    items = { products: { productsToAdd: customerGets.items.products } };
  } else if (customerGets.items.collections && customerGets.items.collections.length > 0) {
    items = { collections: { add: customerGets.items.collections } };
  } else {
    items = { all: true };
  }

  return { value, items };
}

function buildMinimumRequirementInput(req: z.infer<typeof minimumRequirementSchema>) {
  if (req.type === "quantity") {
    return { quantity: { greaterThanOrEqualToQuantity: req.greaterThanOrEqualToQuantity } };
  }
  if (req.type === "subtotal") {
    return { subtotal: { greaterThanOrEqualToSubtotal: req.greaterThanOrEqualToSubtotal.toString() } };
  }
  return undefined;
}

export function registerDiscountTools(server: McpServer): void {
  // --- List All Discounts ---
  server.tool(
    "list_discounts",
    "List all discounts (both automatic and code-based) with pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of discounts to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query (e.g. 'title:*sale*', 'status:active')"),
      sortKey: z.enum(["CREATED_AT", "ID", "UPDATED_AT"]).default("CREATED_AT"),
      reverse: z.boolean().default(true),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ discountNodes: unknown }>(`
        query DiscountNodes($first: Int!, $after: String, $query: String, $sortKey: DiscountSortKeys!, $reverse: Boolean!) {
          discountNodes(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${DISCOUNT_SUMMARY_FIELDS} }
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

  // --- List Automatic Discounts ---
  server.tool(
    "list_automatic_discounts",
    "List automatic discounts with pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of discounts to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query"),
      sortKey: z.enum(["CREATED_AT", "ID", "UPDATED_AT"]).default("CREATED_AT"),
      reverse: z.boolean().default(true),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ automaticDiscountNodes: unknown }>(`
        query AutomaticDiscountNodes($first: Int!, $after: String, $query: String, $sortKey: AutomaticDiscountSortKeys!, $reverse: Boolean!) {
          automaticDiscountNodes(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${DISCOUNT_SUMMARY_FIELDS} }
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

  // --- List Code Discounts ---
  server.tool(
    "list_code_discounts",
    "List code-based discounts with pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of discounts to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query"),
      sortKey: z.enum(["CREATED_AT", "ID", "UPDATED_AT"]).default("CREATED_AT"),
      reverse: z.boolean().default(true),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ codeDiscountNodes: unknown }>(`
        query CodeDiscountNodes($first: Int!, $after: String, $query: String, $sortKey: CodeDiscountSortKeys!, $reverse: Boolean!) {
          codeDiscountNodes(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${DISCOUNT_SUMMARY_FIELDS} }
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

  // --- Get Discount ---
  server.tool(
    "get_discount",
    "Get full details of a single discount by ID.",
    {
      id: z.string().describe("Discount node GID (e.g. gid://shopify/DiscountNode/123 or gid://shopify/DiscountAutomaticNode/123 or gid://shopify/DiscountCodeNode/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL(`
        query GetDiscount($id: ID!) {
          discountNode(id: $id) { ${DISCOUNT_NODE_FIELDS} }
        }
      `, { id });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Create Basic Code Discount ---
  server.tool(
    "create_basic_code_discount",
    "Create a basic code discount (percentage or fixed amount). Requires a discount code that customers enter at checkout.",
    {
      title: z.string().describe("Discount title"),
      code: z.string().describe("Discount code that customers enter at checkout"),
      startsAt: z.string().describe("Start date in ISO 8601 format"),
      endsAt: z.string().optional().describe("End date in ISO 8601 format"),
      customerGets: customerGetsSchema.describe("What the customer gets"),
      minimumRequirement: minimumRequirementSchema.describe("Minimum requirement to qualify"),
      usageLimit: z.number().optional().describe("Maximum number of times the discount can be used in total"),
      appliesOncePerCustomer: z.boolean().default(false).describe("Whether each customer can use this discount only once"),
      combinesWith: z.object({
        orderDiscounts: z.boolean().default(false),
        productDiscounts: z.boolean().default(false),
        shippingDiscounts: z.boolean().default(false),
      }).optional().describe("Which other discount types this can combine with"),
    },
    async ({ title, code, startsAt, endsAt, customerGets, minimumRequirement, usageLimit, appliesOncePerCustomer, combinesWith }) => {
      const basicCodeDiscount: Record<string, unknown> = {
        title,
        code,
        startsAt,
        endsAt,
        customerGets: buildCustomerGetsInput(customerGets),
        usageLimit,
        appliesOncePerCustomer,
        combinesWith,
      };

      const minReq = buildMinimumRequirementInput(minimumRequirement);
      if (minReq) {
        basicCodeDiscount.minimumRequirement = minReq;
      }

      const res = await shopifyGraphQL<{
        discountCodeBasicCreate: {
          codeDiscountNode: unknown;
          userErrors: Array<{ field: string[]; code: string; message: string }>;
        };
      }>(`
        mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
            ${CODE_BASIC_RESULT_FIELDS}
          }
        }
      `, { basicCodeDiscount });

      throwIfUserErrors(res.data?.discountCodeBasicCreate?.userErrors, "discountCodeBasicCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.discountCodeBasicCreate?.codeDiscountNode) }] };
    },
  );

  // --- Update Basic Code Discount ---
  server.tool(
    "update_basic_code_discount",
    "Update an existing basic code discount.",
    {
      id: z.string().describe("Discount code node GID (e.g. gid://shopify/DiscountCodeNode/123)"),
      title: z.string().optional().describe("New title"),
      startsAt: z.string().optional().describe("New start date (ISO 8601)"),
      endsAt: z.string().optional().nullable().describe("New end date (ISO 8601), null to remove"),
      customerGets: customerGetsSchema.optional().describe("Updated customer gets"),
      minimumRequirement: minimumRequirementSchema.optional().describe("Updated minimum requirement"),
      usageLimit: z.number().optional().nullable().describe("Updated usage limit, null to remove"),
      appliesOncePerCustomer: z.boolean().optional(),
      combinesWith: z.object({
        orderDiscounts: z.boolean().default(false),
        productDiscounts: z.boolean().default(false),
        shippingDiscounts: z.boolean().default(false),
      }).optional(),
    },
    async ({ id, title, startsAt, endsAt, customerGets, minimumRequirement, usageLimit, appliesOncePerCustomer, combinesWith }) => {
      const basicCodeDiscount: Record<string, unknown> = {};
      if (title !== undefined) basicCodeDiscount.title = title;
      if (startsAt !== undefined) basicCodeDiscount.startsAt = startsAt;
      if (endsAt !== undefined) basicCodeDiscount.endsAt = endsAt;
      if (usageLimit !== undefined) basicCodeDiscount.usageLimit = usageLimit;
      if (appliesOncePerCustomer !== undefined) basicCodeDiscount.appliesOncePerCustomer = appliesOncePerCustomer;
      if (combinesWith !== undefined) basicCodeDiscount.combinesWith = combinesWith;
      if (customerGets) basicCodeDiscount.customerGets = buildCustomerGetsInput(customerGets);
      if (minimumRequirement) {
        const minReq = buildMinimumRequirementInput(minimumRequirement);
        if (minReq) basicCodeDiscount.minimumRequirement = minReq;
      }

      const res = await shopifyGraphQL<{
        discountCodeBasicUpdate: {
          codeDiscountNode: unknown;
          userErrors: Array<{ field: string[]; code: string; message: string }>;
        };
      }>(`
        mutation DiscountCodeBasicUpdate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
          discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
            ${CODE_BASIC_RESULT_FIELDS}
          }
        }
      `, { id, basicCodeDiscount });

      throwIfUserErrors(res.data?.discountCodeBasicUpdate?.userErrors, "discountCodeBasicUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.discountCodeBasicUpdate?.codeDiscountNode) }] };
    },
  );

  // --- Create Basic Automatic Discount ---
  server.tool(
    "create_basic_automatic_discount",
    "Create a basic automatic discount (percentage or fixed amount). Automatically applied at checkout without a code.",
    {
      title: z.string().describe("Discount title (shown to customers)"),
      startsAt: z.string().describe("Start date in ISO 8601 format"),
      endsAt: z.string().optional().describe("End date in ISO 8601 format"),
      customerGets: customerGetsSchema.describe("What the customer gets"),
      minimumRequirement: minimumRequirementSchema.describe("Minimum requirement to qualify"),
      combinesWith: z.object({
        orderDiscounts: z.boolean().default(false),
        productDiscounts: z.boolean().default(false),
        shippingDiscounts: z.boolean().default(false),
      }).optional().describe("Which other discount types this can combine with"),
    },
    async ({ title, startsAt, endsAt, customerGets, minimumRequirement, combinesWith }) => {
      const automaticBasicDiscount: Record<string, unknown> = {
        title,
        startsAt,
        endsAt,
        customerGets: buildCustomerGetsInput(customerGets),
        combinesWith,
      };

      const minReq = buildMinimumRequirementInput(minimumRequirement);
      if (minReq) {
        automaticBasicDiscount.minimumRequirement = minReq;
      }

      const res = await shopifyGraphQL<{
        discountAutomaticBasicCreate: {
          automaticDiscountNode: unknown;
          userErrors: Array<{ field: string[]; code: string; message: string }>;
        };
      }>(`
        mutation DiscountAutomaticBasicCreate($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
          discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
            ${AUTOMATIC_BASIC_RESULT_FIELDS}
          }
        }
      `, { automaticBasicDiscount });

      throwIfUserErrors(res.data?.discountAutomaticBasicCreate?.userErrors, "discountAutomaticBasicCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.discountAutomaticBasicCreate?.automaticDiscountNode) }] };
    },
  );

  // --- Update Basic Automatic Discount ---
  server.tool(
    "update_basic_automatic_discount",
    "Update an existing basic automatic discount.",
    {
      id: z.string().describe("Automatic discount node GID (e.g. gid://shopify/DiscountAutomaticNode/123)"),
      title: z.string().optional().describe("New title"),
      startsAt: z.string().optional().describe("New start date (ISO 8601)"),
      endsAt: z.string().optional().nullable().describe("New end date (ISO 8601), null to remove"),
      customerGets: customerGetsSchema.optional().describe("Updated customer gets"),
      minimumRequirement: minimumRequirementSchema.optional().describe("Updated minimum requirement"),
      combinesWith: z.object({
        orderDiscounts: z.boolean().default(false),
        productDiscounts: z.boolean().default(false),
        shippingDiscounts: z.boolean().default(false),
      }).optional(),
    },
    async ({ id, title, startsAt, endsAt, customerGets, minimumRequirement, combinesWith }) => {
      const automaticBasicDiscount: Record<string, unknown> = {};
      if (title !== undefined) automaticBasicDiscount.title = title;
      if (startsAt !== undefined) automaticBasicDiscount.startsAt = startsAt;
      if (endsAt !== undefined) automaticBasicDiscount.endsAt = endsAt;
      if (combinesWith !== undefined) automaticBasicDiscount.combinesWith = combinesWith;
      if (customerGets) automaticBasicDiscount.customerGets = buildCustomerGetsInput(customerGets);
      if (minimumRequirement) {
        const minReq = buildMinimumRequirementInput(minimumRequirement);
        if (minReq) automaticBasicDiscount.minimumRequirement = minReq;
      }

      const res = await shopifyGraphQL<{
        discountAutomaticBasicUpdate: {
          automaticDiscountNode: unknown;
          userErrors: Array<{ field: string[]; code: string; message: string }>;
        };
      }>(`
        mutation DiscountAutomaticBasicUpdate($id: ID!, $automaticBasicDiscount: DiscountAutomaticBasicInput!) {
          discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $automaticBasicDiscount) {
            ${AUTOMATIC_BASIC_RESULT_FIELDS}
          }
        }
      `, { id, automaticBasicDiscount });

      throwIfUserErrors(res.data?.discountAutomaticBasicUpdate?.userErrors, "discountAutomaticBasicUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.discountAutomaticBasicUpdate?.automaticDiscountNode) }] };
    },
  );

  // --- Delete Automatic Discount ---
  server.tool(
    "delete_automatic_discount",
    "Delete an automatic discount.",
    {
      id: z.string().describe("Automatic discount GID (e.g. gid://shopify/DiscountAutomaticNode/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        discountAutomaticDelete: {
          deletedAutomaticDiscountId: string;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation DiscountAutomaticDelete($id: ID!) {
          discountAutomaticDelete(id: $id) {
            deletedAutomaticDiscountId
            userErrors { field message }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.discountAutomaticDelete?.userErrors, "discountAutomaticDelete");
      return { content: [{ type: "text" as const, text: `Automatic discount ${res.data?.discountAutomaticDelete?.deletedAutomaticDiscountId} deleted.` }] };
    },
  );

  // --- Delete Code Discount ---
  server.tool(
    "delete_code_discount",
    "Delete a code-based discount.",
    {
      id: z.string().describe("Code discount GID (e.g. gid://shopify/DiscountCodeNode/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        discountCodeDelete: {
          deletedCodeDiscountId: string;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation DiscountCodeDelete($id: ID!) {
          discountCodeDelete(id: $id) {
            deletedCodeDiscountId
            userErrors { field message }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.discountCodeDelete?.userErrors, "discountCodeDelete");
      return { content: [{ type: "text" as const, text: `Code discount ${res.data?.discountCodeDelete?.deletedCodeDiscountId} deleted.` }] };
    },
  );

  // --- Activate Code Discount ---
  server.tool(
    "activate_discount",
    "Activate a code-based discount.",
    {
      id: z.string().describe("Code discount GID (e.g. gid://shopify/DiscountCodeNode/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        discountCodeActivate: {
          codeDiscountNode: { id: string; discount: { title: string; status: string } };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation DiscountCodeActivate($id: ID!) {
          discountCodeActivate(id: $id) {
            codeDiscountNode {
              id
              discount {
                ... on DiscountCodeBasic { title status }
                ... on DiscountCodeBxgy { title status }
                ... on DiscountCodeFreeShipping { title status }
                ... on DiscountCodeApp { title status }
              }
            }
            userErrors { field message }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.discountCodeActivate?.userErrors, "discountCodeActivate");
      return { content: [{ type: "text" as const, text: toText(res.data?.discountCodeActivate?.codeDiscountNode) }] };
    },
  );

  // --- Deactivate Code Discount ---
  server.tool(
    "deactivate_discount",
    "Deactivate a code-based discount.",
    {
      id: z.string().describe("Code discount GID (e.g. gid://shopify/DiscountCodeNode/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        discountCodeDeactivate: {
          codeDiscountNode: { id: string; discount: { title: string; status: string } };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation DiscountCodeDeactivate($id: ID!) {
          discountCodeDeactivate(id: $id) {
            codeDiscountNode {
              id
              discount {
                ... on DiscountCodeBasic { title status }
                ... on DiscountCodeBxgy { title status }
                ... on DiscountCodeFreeShipping { title status }
                ... on DiscountCodeApp { title status }
              }
            }
            userErrors { field message }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.discountCodeDeactivate?.userErrors, "discountCodeDeactivate");
      return { content: [{ type: "text" as const, text: toText(res.data?.discountCodeDeactivate?.codeDiscountNode) }] };
    },
  );
}
