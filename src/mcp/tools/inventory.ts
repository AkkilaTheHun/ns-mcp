import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

const LOCATION_FIELDS = `
  id
  name
  isActive
  fulfillsOnlineOrders
  hasActiveInventory
  address {
    address1
    address2
    city
    province
    provinceCode
    country
    countryCode
    zip
    phone
  }
`;

const INVENTORY_ITEM_FIELDS = `
  id
  sku
  tracked
  requiresShipping
  countryCodeOfOrigin
  harmonizedSystemCode
  createdAt
  updatedAt
  variants(first: 1) {
    edges {
      node {
        id
        title
        displayName
        product {
          id
          title
        }
      }
    }
  }
`;

const INVENTORY_LEVEL_FIELDS = `
  id
  quantities(names: ["available", "incoming", "committed", "damaged", "on_hand", "quality_control", "reserved", "safety_stock"]) {
    name
    quantity
  }
  location {
    id
    name
  }
  item {
    id
    sku
  }
`;

export function registerInventoryTools(server: McpServer): void {
  // --- List Locations ---
  server.tool(
    "list_locations",
    "List all locations for the shop with optional filtering and pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of locations to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      includeLegacy: z.boolean().default(true).describe("Include legacy locations"),
      includeInactive: z.boolean().default(false).describe("Include inactive locations"),
    },
    async ({ first, after, includeLegacy, includeInactive }) => {
      const res = await shopifyGraphQL<{ locations: unknown }>(`
        query Locations($first: Int!, $after: String, $includeLegacy: Boolean!, $includeInactive: Boolean!) {
          locations(first: $first, after: $after, includeLegacy: $includeLegacy, includeInactive: $includeInactive) {
            edges {
              cursor
              node { ${LOCATION_FIELDS} }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              endCursor
              startCursor
            }
          }
        }
      `, { first, after, includeLegacy, includeInactive });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Get Location ---
  server.tool(
    "get_location",
    "Get full details of a single location by ID.",
    {
      id: z.string().describe("Location GID (e.g. gid://shopify/Location/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL(`
        query GetLocation($id: ID!) {
          location(id: $id) { ${LOCATION_FIELDS} }
        }
      `, { id });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Get Inventory Item ---
  server.tool(
    "get_inventory_item",
    "Get an inventory item by ID, including SKU, tracking info, and variant details.",
    {
      id: z.string().describe("InventoryItem GID (e.g. gid://shopify/InventoryItem/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL(`
        query GetInventoryItem($id: ID!) {
          inventoryItem(id: $id) { ${INVENTORY_ITEM_FIELDS} }
        }
      `, { id });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Get Inventory Levels ---
  server.tool(
    "get_inventory_levels",
    "Get inventory levels for an inventory item across all stocked locations.",
    {
      inventoryItemId: z.string().describe("InventoryItem GID"),
      first: z.number().min(1).max(250).default(50).describe("Number of inventory levels to return"),
      after: z.string().optional().describe("Cursor for pagination"),
    },
    async ({ inventoryItemId, first, after }) => {
      const res = await shopifyGraphQL<{ inventoryItem: unknown }>(`
        query GetInventoryLevels($inventoryItemId: ID!, $first: Int!, $after: String) {
          inventoryItem(id: $inventoryItemId) {
            id
            sku
            tracked
            inventoryLevels(first: $first, after: $after) {
              edges {
                cursor
                node { ${INVENTORY_LEVEL_FIELDS} }
              }
              pageInfo {
                hasNextPage
                hasPreviousPage
                endCursor
                startCursor
              }
            }
          }
        }
      `, { inventoryItemId, first, after });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Set Inventory Quantities (absolute) ---
  server.tool(
    "set_inventory_quantities",
    "Set absolute inventory quantities at specific locations. Uses inventorySetQuantities mutation. The 'name' field should be a quantity name like 'available', 'on_hand', etc.",
    {
      reason: z.string().describe("Reason for the quantity change (e.g. 'correction', 'cycle_count')"),
      name: z.string().describe("Inventory quantity name to set (e.g. 'available', 'on_hand')"),
      quantities: z.array(z.object({
        inventoryItemId: z.string().describe("InventoryItem GID"),
        locationId: z.string().describe("Location GID"),
        quantity: z.number().int().describe("Absolute quantity to set"),
      })).describe("Array of inventory quantities to set"),
      ignoreCompareQuantity: z.boolean().default(true).describe("If true, skip compare-and-swap check"),
    },
    async ({ reason, name, quantities, ignoreCompareQuantity }) => {
      const input = {
        reason,
        name,
        ignoreCompareQuantity,
        quantities: quantities.map((q) => ({
          inventoryItemId: q.inventoryItemId,
          locationId: q.locationId,
          quantity: q.quantity,
        })),
      };

      const res = await shopifyGraphQL<{
        inventorySetQuantities: {
          inventoryAdjustmentGroup: unknown;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup {
              reason
              changes {
                name
                delta
                item { id sku }
                location { id name }
              }
            }
            userErrors { field message }
          }
        }
      `, { input });

      throwIfUserErrors(res.data?.inventorySetQuantities?.userErrors, "inventorySetQuantities");
      return { content: [{ type: "text" as const, text: toText(res.data?.inventorySetQuantities?.inventoryAdjustmentGroup) }] };
    },
  );

  // --- Adjust Inventory Quantities (deltas) ---
  server.tool(
    "adjust_inventory_quantities",
    "Adjust inventory quantities by delta (positive or negative) at specific locations. Uses inventoryAdjustQuantities mutation.",
    {
      reason: z.string().describe("Reason for the adjustment (e.g. 'correction', 'shrinkage', 'received')"),
      name: z.string().describe("Inventory quantity name to adjust (e.g. 'available', 'on_hand')"),
      changes: z.array(z.object({
        inventoryItemId: z.string().describe("InventoryItem GID"),
        locationId: z.string().describe("Location GID"),
        delta: z.number().int().describe("Quantity change (positive to add, negative to subtract)"),
      })).describe("Array of inventory changes to apply"),
    },
    async ({ reason, name, changes }) => {
      const input = {
        reason,
        name,
        changes: changes.map((c) => ({
          inventoryItemId: c.inventoryItemId,
          locationId: c.locationId,
          delta: c.delta,
        })),
      };

      const res = await shopifyGraphQL<{
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: unknown;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            inventoryAdjustmentGroup {
              reason
              changes {
                name
                delta
                item { id sku }
                location { id name }
              }
            }
            userErrors { field message }
          }
        }
      `, { input });

      throwIfUserErrors(res.data?.inventoryAdjustQuantities?.userErrors, "inventoryAdjustQuantities");
      return { content: [{ type: "text" as const, text: toText(res.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup) }] };
    },
  );

  // --- Activate Inventory at Location ---
  server.tool(
    "activate_inventory_at_location",
    "Activate an inventory item at a location so it can be stocked there.",
    {
      inventoryItemId: z.string().describe("InventoryItem GID"),
      locationId: z.string().describe("Location GID to activate inventory at"),
      available: z.number().int().optional().describe("Initial available quantity (defaults to 0)"),
    },
    async ({ inventoryItemId, locationId, available }) => {
      const res = await shopifyGraphQL<{
        inventoryActivate: {
          inventoryLevel: unknown;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation InventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
            inventoryLevel { ${INVENTORY_LEVEL_FIELDS} }
            userErrors { field message }
          }
        }
      `, { inventoryItemId, locationId, available });

      throwIfUserErrors(res.data?.inventoryActivate?.userErrors, "inventoryActivate");
      return { content: [{ type: "text" as const, text: toText(res.data?.inventoryActivate?.inventoryLevel) }] };
    },
  );

  // --- Deactivate Inventory at Location ---
  server.tool(
    "deactivate_inventory_at_location",
    "Deactivate an inventory item at a location so it is no longer stocked there. Requires the inventory level ID (gid://shopify/InventoryLevel/...).",
    {
      inventoryLevelId: z.string().describe("InventoryLevel GID (e.g. gid://shopify/InventoryLevel/123). Use get_inventory_levels to find this."),
    },
    async ({ inventoryLevelId }) => {
      const res = await shopifyGraphQL<{
        inventoryDeactivate: {
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation InventoryDeactivate($inventoryLevelId: ID!) {
          inventoryDeactivate(inventoryLevelId: $inventoryLevelId) {
            userErrors { field message }
          }
        }
      `, { inventoryLevelId });

      throwIfUserErrors(res.data?.inventoryDeactivate?.userErrors, "inventoryDeactivate");
      return { content: [{ type: "text" as const, text: "Inventory deactivated at location successfully." }] };
    },
  );
}
