import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

const CUSTOMER_FIELDS = `
  id
  firstName
  lastName
  displayName
  state
  note
  tags
  taxExempt
  taxExemptions
  locale
  createdAt
  updatedAt
  verifiedEmail
  numberOfOrders
  amountSpent { amount currencyCode }
  defaultEmailAddress {
    emailAddress
    validFormat
    marketingState
    marketingOptInLevel
    marketingUpdatedAt
  }
  defaultPhoneNumber {
    phoneNumber
    marketingState
    marketingOptInLevel
    marketingUpdatedAt
  }
  defaultAddress {
    id
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
  addressesV2(first: 10) {
    edges {
      node {
        id
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

const CUSTOMER_SUMMARY_FIELDS = `
  id
  firstName
  lastName
  displayName
  state
  tags
  numberOfOrders
  amountSpent { amount currencyCode }
  defaultEmailAddress { emailAddress }
  defaultPhoneNumber { phoneNumber }
  createdAt
  updatedAt
`;

const addressSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional().describe("Province/state name"),
  country: z.string().optional().describe("Country name"),
  zip: z.string().optional(),
  phone: z.string().optional(),
});

export function registerCustomerTools(server: McpServer): void {
  // --- List Customers ---
  server.tool(
    "list_customers",
    "List customers with optional filtering, sorting, and pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of customers to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query (e.g. 'email:*@example.com', 'tag:vip', 'state:enabled', 'orders_count:>5')"),
      sortKey: z.enum(["CREATED_AT", "ID", "LOCATION", "NAME", "ORDERS_COUNT", "RELEVANCE", "UPDATED_AT"]).default("UPDATED_AT"),
      reverse: z.boolean().default(false),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ customers: unknown }>(`
        query Customers($first: Int!, $after: String, $query: String, $sortKey: CustomerSortKeys!, $reverse: Boolean!) {
          customers(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${CUSTOMER_SUMMARY_FIELDS} }
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

  // --- Get Customer ---
  server.tool(
    "get_customer",
    "Get full details of a single customer by ID.",
    {
      id: z.string().describe("Customer GID (e.g. gid://shopify/Customer/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL(`
        query GetCustomer($id: ID!) {
          customer(id: $id) { ${CUSTOMER_FIELDS} }
        }
      `, { id });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Search Customers ---
  server.tool(
    "search_customers",
    "Search customers using Shopify search syntax.",
    {
      query: z.string().describe("Search query (e.g. 'email:john@example.com', 'first_name:John', 'tag:wholesale', 'state:enabled AND orders_count:>0')"),
      first: z.number().min(1).max(250).default(25),
    },
    async ({ query, first }) => {
      const res = await shopifyGraphQL<{ customers: unknown }>(`
        query SearchCustomers($query: String!, $first: Int!) {
          customers(first: $first, query: $query) {
            edges {
              node { ${CUSTOMER_SUMMARY_FIELDS} }
            }
          }
        }
      `, { query, first });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Count Customers ---
  server.tool(
    "count_customers",
    "Get the total number of customers, optionally filtered.",
    {
      query: z.string().optional().describe("Optional filter query"),
    },
    async ({ query }) => {
      const res = await shopifyGraphQL<{ customersCount: { count: number } }>(`
        query CustomersCount($query: String) {
          customersCount(query: $query) {
            count
          }
        }
      `, { query });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Create Customer ---
  server.tool(
    "create_customer",
    "Create a new customer.",
    {
      firstName: z.string().optional().describe("First name"),
      lastName: z.string().optional().describe("Last name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number (E.164 format, e.g. +16135551111)"),
      note: z.string().optional().describe("Note about the customer"),
      tags: z.array(z.string()).optional().describe("Tags"),
      locale: z.string().optional().describe("Locale (e.g. 'en', 'fr')"),
      taxExempt: z.boolean().optional().describe("Whether exempt from taxes"),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).optional(),
      emailMarketingConsent: z.object({
        marketingState: z.enum(["SUBSCRIBED", "UNSUBSCRIBED", "PENDING"]),
        marketingOptInLevel: z.enum(["SINGLE_OPT_IN", "CONFIRMED_OPT_IN", "UNKNOWN"]).optional(),
      }).optional().describe("Email marketing consent"),
      smsMarketingConsent: z.object({
        marketingState: z.enum(["SUBSCRIBED", "UNSUBSCRIBED", "PENDING"]),
        marketingOptInLevel: z.enum(["SINGLE_OPT_IN", "CONFIRMED_OPT_IN", "UNKNOWN"]).optional(),
      }).optional().describe("SMS marketing consent"),
    },
    async (input) => {
      const res = await shopifyGraphQL<{
        customerCreate: { customer: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CustomerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { ${CUSTOMER_FIELDS} }
            userErrors { field message }
          }
        }
      `, { input });

      throwIfUserErrors(res.data?.customerCreate?.userErrors, "customerCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.customerCreate?.customer) }] };
    },
  );

  // --- Update Customer ---
  server.tool(
    "update_customer",
    "Update an existing customer's fields.",
    {
      id: z.string().describe("Customer GID"),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      note: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Tags (replaces all existing tags)"),
      locale: z.string().optional(),
      taxExempt: z.boolean().optional(),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).optional(),
    },
    async (input) => {
      const res = await shopifyGraphQL<{
        customerUpdate: { customer: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CustomerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { ${CUSTOMER_FIELDS} }
            userErrors { field message }
          }
        }
      `, { input });

      throwIfUserErrors(res.data?.customerUpdate?.userErrors, "customerUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.customerUpdate?.customer) }] };
    },
  );

  // --- Delete Customer ---
  server.tool(
    "delete_customer",
    "Delete a customer. Can only delete customers who haven't placed any orders.",
    {
      id: z.string().describe("Customer GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        customerDelete: { deletedCustomerId: string; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation CustomerDelete($input: CustomerDeleteInput!) {
          customerDelete(input: $input) {
            deletedCustomerId
            userErrors { field message }
          }
        }
      `, { input: { id } });

      throwIfUserErrors(res.data?.customerDelete?.userErrors, "customerDelete");
      return { content: [{ type: "text" as const, text: `Customer ${res.data?.customerDelete?.deletedCustomerId} deleted.` }] };
    },
  );

  // --- Add Tags to Customer ---
  server.tool(
    "add_customer_tags",
    "Add tags to a customer without removing existing tags.",
    {
      id: z.string().describe("Customer GID"),
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
      return { content: [{ type: "text" as const, text: `Added ${tags.length} tag(s) to customer.` }] };
    },
  );

  // --- Remove Tags from Customer ---
  server.tool(
    "remove_customer_tags",
    "Remove tags from a customer.",
    {
      id: z.string().describe("Customer GID"),
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
      return { content: [{ type: "text" as const, text: `Removed ${tags.length} tag(s) from customer.` }] };
    },
  );

  // --- Set Customer Metafields ---
  server.tool(
    "set_customer_metafields",
    "Set metafields on a customer (creates or updates).",
    {
      customerId: z.string().describe("Customer GID"),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).describe("Metafields to set"),
    },
    async ({ customerId, metafields }) => {
      const metafieldsInput = metafields.map((mf) => ({
        ownerId: customerId,
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

  // --- Update Email Marketing Consent ---
  server.tool(
    "update_customer_email_consent",
    "Update a customer's email marketing consent.",
    {
      customerId: z.string().describe("Customer GID"),
      marketingState: z.enum(["SUBSCRIBED", "UNSUBSCRIBED", "PENDING"]).describe("Marketing state"),
      marketingOptInLevel: z.enum(["SINGLE_OPT_IN", "CONFIRMED_OPT_IN", "UNKNOWN"]).optional(),
    },
    async ({ customerId, marketingState, marketingOptInLevel }) => {
      const res = await shopifyGraphQL<{
        customerEmailMarketingConsentUpdate: {
          customer: { id: string; emailMarketingConsent: unknown };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation CustomerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) {
            customer {
              id
              defaultEmailAddress { emailAddress marketingState marketingOptInLevel marketingUpdatedAt }
            }
            userErrors { field message }
          }
        }
      `, {
        input: {
          customerId,
          emailMarketingConsent: { marketingState, marketingOptInLevel },
        },
      });

      throwIfUserErrors(res.data?.customerEmailMarketingConsentUpdate?.userErrors, "customerEmailMarketingConsentUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.customerEmailMarketingConsentUpdate?.customer) }] };
    },
  );

  // --- Generate Account Activation URL ---
  server.tool(
    "generate_customer_activation_url",
    "Generate a one-time account activation URL for a customer. Expires after 30 days.",
    {
      customerId: z.string().describe("Customer GID"),
    },
    async ({ customerId }) => {
      const res = await shopifyGraphQL<{
        customerGenerateAccountActivationUrl: {
          accountActivationUrl: string;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation CustomerGenerateAccountActivationUrl($customerId: ID!) {
          customerGenerateAccountActivationUrl(customerId: $customerId) {
            accountActivationUrl
            userErrors { field message }
          }
        }
      `, { customerId });

      throwIfUserErrors(res.data?.customerGenerateAccountActivationUrl?.userErrors, "customerGenerateAccountActivationUrl");
      return { content: [{ type: "text" as const, text: res.data?.customerGenerateAccountActivationUrl?.accountActivationUrl ?? "null" }] };
    },
  );
}
