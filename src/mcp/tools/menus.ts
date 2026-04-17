import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

const MENU_ITEM_FIELDS = `
  id
  title
  type
  url
  resourceId
  tags
  items {
    id
    title
    type
    url
    resourceId
    tags
    items {
      id
      title
      type
      url
      resourceId
      tags
    }
  }
`;

const MENU_FIELDS = `
  id
  title
  handle
  items {
    ${MENU_ITEM_FIELDS}
  }
`;

const menuItemTypeEnum = z.enum([
  "ARTICLE", "BLOG", "CATALOG", "COLLECTION", "COLLECTIONS",
  "CUSTOMER_ACCOUNT_PAGE", "FRONTPAGE", "HTTP", "METAOBJECT",
  "PAGE", "PRODUCT", "SEARCH", "SHOP_POLICY",
]);

// Recursive menu item schema (up to 3 levels deep)
const menuItemLevel3 = z.object({
  title: z.string().describe("Menu item title"),
  type: menuItemTypeEnum.describe("Menu item type (e.g. COLLECTION, PAGE, HTTP, PRODUCT, BLOG, SEARCH, FRONTPAGE)"),
  url: z.string().optional().describe("URL (required for HTTP type, optional for resource-linked types)"),
  resourceId: z.string().optional().describe("Resource GID (e.g. gid://shopify/Collection/123) for COLLECTION, PRODUCT, PAGE, etc."),
  tags: z.array(z.string()).optional().describe("Tags to filter a collection (only for COLLECTION type)"),
});

const menuItemLevel2 = menuItemLevel3.extend({
  items: z.array(menuItemLevel3).optional().describe("Nested sub-items (level 3)"),
});

const menuItemCreateSchema = menuItemLevel2.extend({
  items: z.array(menuItemLevel2).optional().describe("Nested sub-items (level 2)"),
});

const menuItemUpdateSchema = menuItemLevel2.extend({
  id: z.string().optional().describe("MenuItem GID (required when updating existing items, omit for new items)"),
  items: z.array(menuItemLevel2.extend({
    id: z.string().optional().describe("MenuItem GID"),
  })).optional(),
});

export function registerMenuTools(server: McpServer): void {
  // --- List Menus ---
  server.tool(
    "list_menus",
    "List all navigation menus (e.g. main-menu, footer).",
    {
      first: z.number().min(1).max(250).default(25).describe("Number of menus to return"),
      after: z.string().optional().describe("Cursor for pagination"),
    },
    async ({ first, after }) => {
      const res = await shopifyGraphQL<{ menus: unknown }>(`
        query Menus($first: Int!, $after: String) {
          menus(first: $first, after: $after) {
            edges {
              cursor
              node {
                id
                title
                handle
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `, { first, after });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Get Menu ---
  server.tool(
    "get_menu",
    "Get a menu with all its items and nested sub-items (up to 3 levels). Provide either an ID or a handle. For handle lookups, searches menus and returns the first match.",
    {
      id: z.string().optional().describe("Menu GID"),
      handle: z.string().optional().describe("Menu handle (e.g. 'main-menu', 'footer')"),
    },
    async ({ id, handle }) => {
      if (!id && !handle) {
        return { content: [{ type: "text" as const, text: "Error: Provide either id or handle" }], isError: true };
      }

      if (id) {
        const res = await shopifyGraphQL(`query GetMenu($id: ID!) { menu(id: $id) { ${MENU_FIELDS} } }`, { id });
        return { content: [{ type: "text" as const, text: toText(res.data) }] };
      }

      // No menuByHandle query — find by listing and matching handle
      const res = await shopifyGraphQL<{ menus: { edges: Array<{ node: { id: string; handle: string } }> } }>(`
        query FindMenuByHandle($query: String!) {
          menus(first: 10, query: $query) {
            edges {
              node { ${MENU_FIELDS} }
            }
          }
        }
      `, { query: `handle:${handle}` });

      const match = res.data?.menus?.edges?.find((e) => e.node.handle === handle);
      if (!match) {
        return { content: [{ type: "text" as const, text: `No menu found with handle "${handle}"` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: toText(match.node) }] };
    },
  );

  // --- Create Menu ---
  server.tool(
    "create_menu",
    "Create a new navigation menu with items. Items can be nested up to 3 levels deep.",
    {
      title: z.string().describe("Menu title (e.g. 'Main Menu', 'Footer')"),
      handle: z.string().describe("URL-friendly handle (e.g. 'main-menu', 'footer')"),
      items: z.array(menuItemCreateSchema).describe("Menu items"),
    },
    async ({ title, handle, items }) => {
      const res = await shopifyGraphQL<{
        menuCreate: {
          menu: unknown;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation CreateMenu($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
          menuCreate(title: $title, handle: $handle, items: $items) {
            menu { ${MENU_FIELDS} }
            userErrors { field message }
          }
        }
      `, { title, handle, items });

      throwIfUserErrors(res.data?.menuCreate?.userErrors, "menuCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.menuCreate?.menu) }] };
    },
  );

  // --- Update Menu ---
  server.tool(
    "update_menu",
    "Update a menu's title, handle, and/or items. When updating items, provide the FULL item tree — this replaces all existing items. Include 'id' on items you want to keep/update, omit 'id' to create new items.",
    {
      id: z.string().describe("Menu GID"),
      title: z.string().describe("Menu title"),
      handle: z.string().describe("Menu handle"),
      items: z.array(menuItemUpdateSchema).describe("Full menu item tree (replaces existing)"),
    },
    async ({ id, title, handle, items }) => {
      const res = await shopifyGraphQL<{
        menuUpdate: {
          menu: unknown;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation UpdateMenu($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
          menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
            menu { ${MENU_FIELDS} }
            userErrors { field message }
          }
        }
      `, { id, title, handle, items });

      throwIfUserErrors(res.data?.menuUpdate?.userErrors, "menuUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.menuUpdate?.menu) }] };
    },
  );

  // --- Delete Menu ---
  server.tool(
    "delete_menu",
    "Delete a navigation menu by ID.",
    {
      id: z.string().describe("Menu GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        menuDelete: {
          deletedMenuId: string;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation DeleteMenu($id: ID!) {
          menuDelete(id: $id) {
            deletedMenuId
            userErrors { field message }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.menuDelete?.userErrors, "menuDelete");
      return { content: [{ type: "text" as const, text: `Menu ${res.data?.menuDelete?.deletedMenuId} deleted.` }] };
    },
  );
}
