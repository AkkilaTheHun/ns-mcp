import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

const DEFINITION_FIELDS = `
  id
  name
  type
  description
  displayNameKey
  fieldDefinitions {
    name
    key
    type { name }
    required
    description
  }
  access { admin storefront }
  capabilities {
    publishable { enabled }
    translatable { enabled }
    renderable { enabled }
    onlineStore { enabled }
  }
  metaobjectsCount
  createdAt
  updatedAt
`;

const METAOBJECT_FIELDS = `
  id
  handle
  type
  displayName
  fields {
    key
    value
    type
  }
  capabilities {
    publishable { status }
  }
  createdAt
  updatedAt
`;

const METAOBJECT_DETAIL_FIELDS = `
  id
  handle
  type
  displayName
  fields {
    key
    value
    type
  }
  definition {
    id
    name
    type
  }
  capabilities {
    publishable { status }
  }
  createdAt
  updatedAt
`;

const fieldDefinitionCreateSchema = z.object({
  key: z.string().describe("Field key (2-64 chars, alphanumeric/hyphen/underscore)"),
  name: z.string().optional().describe("Human-readable field name"),
  type: z.string().describe("Metafield type (e.g. 'single_line_text_field', 'number_integer', 'url', 'boolean', 'color', 'date', 'json', 'rich_text_field', 'multi_line_text_field', 'file_reference', 'metaobject_reference')"),
  required: z.boolean().optional().describe("Whether the field is required"),
  description: z.string().optional().describe("Administrative description"),
});

const metaobjectFieldInputSchema = z.object({
  key: z.string().describe("The field key"),
  value: z.string().describe("The field value"),
});

export function registerMetaobjectTools(server: McpServer): void {
  // --- List Metaobject Definitions ---
  server.tool(
    "list_metaobject_definitions",
    "List all metaobject definitions configured for the store.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of definitions to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      reverse: z.boolean().default(false),
    },
    async ({ first, after, reverse }) => {
      const res = await shopifyGraphQL<{ metaobjectDefinitions: unknown }>(`
        query MetaobjectDefinitions($first: Int!, $after: String, $reverse: Boolean!) {
          metaobjectDefinitions(first: $first, after: $after, reverse: $reverse) {
            edges {
              cursor
              node { ${DEFINITION_FIELDS} }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              endCursor
              startCursor
            }
          }
        }
      `, { first, after, reverse });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Get Metaobject Definition ---
  server.tool(
    "get_metaobject_definition",
    "Get a metaobject definition by ID or by type. Provide either id or type.",
    {
      id: z.string().optional().describe("MetaobjectDefinition GID (e.g. gid://shopify/MetaobjectDefinition/123)"),
      type: z.string().optional().describe("Metaobject definition type (e.g. 'lookbook', 'author')"),
    },
    async ({ id, type }) => {
      if (id) {
        const res = await shopifyGraphQL(`
          query MetaobjectDefinition($id: ID!) {
            metaobjectDefinition(id: $id) { ${DEFINITION_FIELDS} }
          }
        `, { id });
        return { content: [{ type: "text" as const, text: toText(res.data) }] };
      }

      if (type) {
        const res = await shopifyGraphQL(`
          query MetaobjectDefinitionByType($type: String!) {
            metaobjectDefinitionByType(type: $type) { ${DEFINITION_FIELDS} }
          }
        `, { type });
        return { content: [{ type: "text" as const, text: toText(res.data) }] };
      }

      throw new Error("Either id or type must be provided.");
    },
  );

  // --- Create Metaobject Definition ---
  server.tool(
    "create_metaobject_definition",
    "Create a new metaobject definition that establishes the structure for custom data objects.",
    {
      type: z.string().describe("Unique type identifier (3-255 chars, alphanumeric/hyphen/underscore). Prefix with '$app:' to reserve for your app."),
      name: z.string().optional().describe("Human-readable name"),
      description: z.string().optional().describe("Administrative description"),
      displayNameKey: z.string().optional().describe("Key of a field to use as the display name for metaobjects of this type"),
      fieldDefinitions: z.array(fieldDefinitionCreateSchema).optional().describe("Field definitions for this metaobject type"),
      access: z.object({
        admin: z.enum(["MERCHANT_READ", "MERCHANT_READ_WRITE"]).optional().describe("Admin API access level"),
        storefront: z.enum(["NONE", "PUBLIC_READ"]).optional().describe("Storefront API access level"),
      }).optional().describe("Access configuration"),
      capabilities: z.object({
        publishable: z.object({ enabled: z.boolean() }).optional(),
        translatable: z.object({ enabled: z.boolean() }).optional(),
        renderable: z.object({ enabled: z.boolean() }).optional(),
        onlineStore: z.object({ enabled: z.boolean() }).optional(),
      }).optional().describe("Capabilities configuration"),
    },
    async ({ type, name, description, displayNameKey, fieldDefinitions, access, capabilities }) => {
      const definition: Record<string, unknown> = { type };
      if (name !== undefined) definition.name = name;
      if (description !== undefined) definition.description = description;
      if (displayNameKey !== undefined) definition.displayNameKey = displayNameKey;
      if (fieldDefinitions !== undefined) definition.fieldDefinitions = fieldDefinitions;
      if (access !== undefined) definition.access = access;
      if (capabilities !== undefined) definition.capabilities = capabilities;

      const res = await shopifyGraphQL<{
        metaobjectDefinitionCreate: {
          metaobjectDefinition: unknown;
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      }>(`
        mutation MetaobjectDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
          metaobjectDefinitionCreate(definition: $definition) {
            metaobjectDefinition {
              id
              name
              type
              description
              displayNameKey
              fieldDefinitions {
                name
                key
                type { name }
                required
                description
              }
            }
            userErrors { field message code }
          }
        }
      `, { definition });

      throwIfUserErrors(res.data?.metaobjectDefinitionCreate?.userErrors, "metaobjectDefinitionCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.metaobjectDefinitionCreate?.metaobjectDefinition) }] };
    },
  );

  // --- Update Metaobject Definition ---
  server.tool(
    "update_metaobject_definition",
    "Update a metaobject definition's configuration and field structure.",
    {
      id: z.string().describe("MetaobjectDefinition GID"),
      name: z.string().optional().describe("Updated human-readable name"),
      description: z.string().optional().describe("Updated description"),
      displayNameKey: z.string().optional().describe("Updated display name key"),
      fieldDefinitions: z.array(z.object({
        create: fieldDefinitionCreateSchema.optional().describe("Create a new field definition"),
        update: z.object({
          key: z.string().describe("Key of the field definition to update"),
          name: z.string().optional(),
          description: z.string().optional(),
          required: z.boolean().optional(),
        }).optional().describe("Update an existing field definition"),
        delete: z.object({
          key: z.string().describe("Key of the field definition to delete"),
        }).optional().describe("Delete a field definition"),
      })).optional().describe("Field definition operations (create, update, or delete)"),
      access: z.object({
        admin: z.enum(["MERCHANT_READ", "MERCHANT_READ_WRITE"]).optional(),
        storefront: z.enum(["NONE", "PUBLIC_READ"]).optional(),
      }).optional(),
      capabilities: z.object({
        publishable: z.object({ enabled: z.boolean() }).optional(),
        translatable: z.object({ enabled: z.boolean() }).optional(),
        renderable: z.object({ enabled: z.boolean() }).optional(),
        onlineStore: z.object({ enabled: z.boolean() }).optional(),
      }).optional(),
      resetFieldOrder: z.boolean().optional().describe("If true, reorder fields based on submitted fields first, then alphabetized omissions"),
    },
    async ({ id, name, description, displayNameKey, fieldDefinitions, access, capabilities, resetFieldOrder }) => {
      const definition: Record<string, unknown> = {};
      if (name !== undefined) definition.name = name;
      if (description !== undefined) definition.description = description;
      if (displayNameKey !== undefined) definition.displayNameKey = displayNameKey;
      if (fieldDefinitions !== undefined) definition.fieldDefinitions = fieldDefinitions;
      if (access !== undefined) definition.access = access;
      if (capabilities !== undefined) definition.capabilities = capabilities;
      if (resetFieldOrder !== undefined) definition.resetFieldOrder = resetFieldOrder;

      const res = await shopifyGraphQL<{
        metaobjectDefinitionUpdate: {
          metaobjectDefinition: unknown;
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      }>(`
        mutation MetaobjectDefinitionUpdate($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
          metaobjectDefinitionUpdate(id: $id, definition: $definition) {
            metaobjectDefinition {
              id
              name
              type
              description
              displayNameKey
              fieldDefinitions {
                name
                key
                type { name }
                required
                description
              }
            }
            userErrors { field message code }
          }
        }
      `, { id, definition });

      throwIfUserErrors(res.data?.metaobjectDefinitionUpdate?.userErrors, "metaobjectDefinitionUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.metaobjectDefinitionUpdate?.metaobjectDefinition) }] };
    },
  );

  // --- Delete Metaobject Definition ---
  server.tool(
    "delete_metaobject_definition",
    "Delete a metaobject definition and all its related metaobjects and metafields asynchronously.",
    {
      id: z.string().describe("MetaobjectDefinition GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        metaobjectDefinitionDelete: {
          deletedId: string;
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      }>(`
        mutation MetaobjectDefinitionDelete($id: ID!) {
          metaobjectDefinitionDelete(id: $id) {
            deletedId
            userErrors { field message code }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.metaobjectDefinitionDelete?.userErrors, "metaobjectDefinitionDelete");
      return { content: [{ type: "text" as const, text: `Metaobject definition ${res.data?.metaobjectDefinitionDelete?.deletedId} deleted.` }] };
    },
  );

  // --- List Metaobjects ---
  server.tool(
    "list_metaobjects",
    "List metaobjects of a specific type with optional filtering, sorting, and pagination.",
    {
      type: z.string().describe("The metaobject type to query (e.g. 'lookbook', 'author')"),
      first: z.number().min(1).max(250).default(50).describe("Number of metaobjects to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      sortKey: z.string().optional().describe("Sort key (supports 'id', 'type', 'updated_at', 'display_name')"),
      reverse: z.boolean().default(false),
      query: z.string().optional().describe("Filter query (e.g. 'display_name:Winter', 'fields.color:blue', 'handle:my-handle')"),
    },
    async ({ type, first, after, sortKey, reverse, query }) => {
      const res = await shopifyGraphQL<{ metaobjects: unknown }>(`
        query Metaobjects($type: String!, $first: Int!, $after: String, $reverse: Boolean!, $sortKey: String, $query: String) {
          metaobjects(type: $type, first: $first, after: $after, reverse: $reverse, sortKey: $sortKey, query: $query) {
            edges {
              cursor
              node { ${METAOBJECT_FIELDS} }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              endCursor
              startCursor
            }
          }
        }
      `, { type, first, after, reverse, sortKey, query });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Get Metaobject ---
  server.tool(
    "get_metaobject",
    "Get a single metaobject by ID, or by handle and type.",
    {
      id: z.string().optional().describe("Metaobject GID (e.g. gid://shopify/Metaobject/123)"),
      handle: z.string().optional().describe("Metaobject handle (must also provide type)"),
      type: z.string().optional().describe("Metaobject type (required when using handle)"),
    },
    async ({ id, handle, type }) => {
      if (id) {
        const res = await shopifyGraphQL(`
          query Metaobject($id: ID!) {
            metaobject(id: $id) { ${METAOBJECT_DETAIL_FIELDS} }
          }
        `, { id });
        return { content: [{ type: "text" as const, text: toText(res.data) }] };
      }

      if (handle && type) {
        const res = await shopifyGraphQL(`
          query MetaobjectByHandle($handle: MetaobjectHandleInput!) {
            metaobjectByHandle(handle: $handle) { ${METAOBJECT_DETAIL_FIELDS} }
          }
        `, { handle: { handle, type } });
        return { content: [{ type: "text" as const, text: toText(res.data) }] };
      }

      throw new Error("Either id, or both handle and type must be provided.");
    },
  );

  // --- Create Metaobject ---
  server.tool(
    "create_metaobject",
    "Create a new metaobject entry. The type must match an existing metaobject definition.",
    {
      type: z.string().describe("Metaobject type (must match an existing definition)"),
      handle: z.string().optional().describe("Unique handle (auto-generated if omitted)"),
      fields: z.array(metaobjectFieldInputSchema).optional().describe("Field key/value pairs"),
      capabilities: z.object({
        publishable: z.object({
          status: z.enum(["ACTIVE", "DRAFT"]).describe("Visibility status"),
        }).optional(),
      }).optional().describe("Capabilities for the metaobject"),
    },
    async ({ type, handle, fields, capabilities }) => {
      const metaobject: Record<string, unknown> = { type };
      if (handle !== undefined) metaobject.handle = handle;
      if (fields !== undefined) metaobject.fields = fields;
      if (capabilities !== undefined) metaobject.capabilities = capabilities;

      const res = await shopifyGraphQL<{
        metaobjectCreate: {
          metaobject: unknown;
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      }>(`
        mutation MetaobjectCreate($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject {
              id
              handle
              type
              displayName
              fields {
                key
                value
                type
              }
            }
            userErrors { field message code }
          }
        }
      `, { metaobject });

      throwIfUserErrors(res.data?.metaobjectCreate?.userErrors, "metaobjectCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.metaobjectCreate?.metaobject) }] };
    },
  );

  // --- Update Metaobject ---
  server.tool(
    "update_metaobject",
    "Update an existing metaobject's fields, handle, or capabilities.",
    {
      id: z.string().describe("Metaobject GID"),
      handle: z.string().optional().describe("Updated handle"),
      fields: z.array(metaobjectFieldInputSchema).optional().describe("Updated field key/value pairs"),
      redirectNewHandle: z.boolean().optional().describe("Create a redirect from the old handle to the new one"),
      capabilities: z.object({
        publishable: z.object({
          status: z.enum(["ACTIVE", "DRAFT"]).describe("Visibility status"),
        }).optional(),
      }).optional().describe("Updated capabilities"),
    },
    async ({ id, handle, fields, redirectNewHandle, capabilities }) => {
      const metaobject: Record<string, unknown> = {};
      if (handle !== undefined) metaobject.handle = handle;
      if (fields !== undefined) metaobject.fields = fields;
      if (redirectNewHandle !== undefined) metaobject.redirectNewHandle = redirectNewHandle;
      if (capabilities !== undefined) metaobject.capabilities = capabilities;

      const res = await shopifyGraphQL<{
        metaobjectUpdate: {
          metaobject: unknown;
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      }>(`
        mutation MetaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
          metaobjectUpdate(id: $id, metaobject: $metaobject) {
            metaobject {
              id
              handle
              type
              displayName
              fields {
                key
                value
                type
              }
            }
            userErrors { field message code }
          }
        }
      `, { id, metaobject });

      throwIfUserErrors(res.data?.metaobjectUpdate?.userErrors, "metaobjectUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.metaobjectUpdate?.metaobject) }] };
    },
  );

  // --- Delete Metaobject ---
  server.tool(
    "delete_metaobject",
    "Delete a metaobject and its associated metafields.",
    {
      id: z.string().describe("Metaobject GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        metaobjectDelete: {
          deletedId: string;
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      }>(`
        mutation MetaobjectDelete($id: ID!) {
          metaobjectDelete(id: $id) {
            deletedId
            userErrors { field message code }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.metaobjectDelete?.userErrors, "metaobjectDelete");
      return { content: [{ type: "text" as const, text: `Metaobject ${res.data?.metaobjectDelete?.deletedId} deleted.` }] };
    },
  );
}
