import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../shopify/client.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
function text(data: unknown): ToolResult { return { content: [{ type: "text", text: typeof data === "string" ? data : toText(data) }] }; }
function fail(msg: string): ToolResult { return { content: [{ type: "text", text: msg }], isError: true }; }
async function gql<T = unknown>(q: string, v?: Record<string, unknown> | undefined) { return shopifyGraphQL<T>(q, v ?? undefined); }
function check(ue: Array<{ field?: string[]; message: string }> | undefined | null, op: string) { throwIfUserErrors(ue, op); }

// ============================================================
// ORDERS
// ============================================================

const ORDER_SUMMARY = `id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{shopMoney{amount currencyCode}} customer{id displayName defaultEmailAddress{emailAddress}} tags note`;
const ORDER_FULL = `id name email createdAt updatedAt cancelledAt closedAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{shopMoney{amount currencyCode}} subtotalPriceSet{shopMoney{amount currencyCode}} totalTaxSet{shopMoney{amount currencyCode}} totalShippingPriceSet{shopMoney{amount currencyCode}} totalRefundedSet{shopMoney{amount currencyCode}} customer{id displayName defaultEmailAddress{emailAddress}} shippingAddress{firstName lastName address1 address2 city province country zip phone} billingAddress{firstName lastName address1 address2 city province country zip phone} lineItems(first:50){edges{node{id title quantity originalUnitPriceSet{shopMoney{amount currencyCode}} variant{id title sku}}}} tags note metafields(first:25){edges{node{id namespace key value type}}}`;

export function registerOrderGateway(server: McpServer): void {
  server.tool(
    "shopify_orders",
    `Manage orders (read-heavy, limited write). Actions:
- list: List orders (params: first?, after?, query?, sortKey?, reverse?)
- get: Get order by ID (params: id)
- search: Search orders (params: query, first?)
- count: Count orders (params: query?)
- update: Update order note/tags/metafields (params: id, note?, tags?, metafields?)
- cancel: Cancel order (params: id, reason?, notifyCustomer?, refund?, restock?, staffNote?)
- close: Close order (params: id)
- add_tags: Add tags (params: id, tags[])
- remove_tags: Remove tags (params: id, tags[])`,
    {
      action: z.enum(["list", "get", "search", "count", "update", "cancel", "close", "add_tags", "remove_tags"]),
      id: z.string().optional(),
      query: z.string().optional(),
      first: z.number().optional(),
      after: z.string().optional(),
      sortKey: z.string().optional(),
      reverse: z.boolean().optional(),
      note: z.string().optional(),
      tags: z.array(z.string()).optional(),
      metafields: z.array(z.object({ namespace: z.string(), key: z.string(), value: z.string(), type: z.string() })).optional(),
      reason: z.enum(["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "OTHER", "STAFF"]).optional(),
      notifyCustomer: z.boolean().optional(),
      refund: z.boolean().optional(),
      restock: z.boolean().optional(),
      staffNote: z.string().optional(),
    },
    async ({ action, ...p }) => {
      switch (action) {
        case "list": {
          const res = await gql(`query($first:Int!,$after:String,$query:String,$sortKey:OrderSortKeys!,$reverse:Boolean!){orders(first:$first,after:$after,query:$query,sortKey:$sortKey,reverse:$reverse){edges{cursor node{${ORDER_SUMMARY}}}pageInfo{hasNextPage hasPreviousPage endCursor startCursor}}}`,
            { first: p.first ?? 50, after: p.after, query: p.query, sortKey: p.sortKey ?? "CREATED_AT", reverse: p.reverse ?? true });
          return text(res.data);
        }
        case "get": {
          if (!p.id) return fail("id required");
          const res = await gql(`query($id:ID!){order(id:$id){${ORDER_FULL}}}`, { id: p.id });
          return text(res.data);
        }
        case "search": {
          if (!p.query) return fail("query required");
          const res = await gql(`query($query:String!,$first:Int!){orders(first:$first,query:$query){edges{node{${ORDER_SUMMARY}}}}}`, { query: p.query, first: p.first ?? 25 });
          return text(res.data);
        }
        case "count": {
          const res = await gql(`query($query:String){ordersCount(query:$query){count}}`, { query: p.query });
          return text(res.data);
        }
        case "update": {
          if (!p.id) return fail("id required");
          const input: Record<string, unknown> = { id: p.id };
          if (p.note !== undefined) input.note = p.note;
          if (p.tags) input.tags = p.tags;
          if (p.metafields) input.metafields = p.metafields;
          const res = await gql<{ orderUpdate: { order: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:OrderInput!){orderUpdate(input:$input){order{${ORDER_FULL}}userErrors{field message}}}`, { input });
          check(res.data?.orderUpdate?.userErrors, "orderUpdate");
          return text(res.data?.orderUpdate?.order);
        }
        case "cancel": {
          if (!p.id) return fail("id required");
          const res = await gql<{ orderCancel: { order: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($orderId:ID!,$reason:OrderCancelReason!,$notifyCustomer:Boolean,$refund:Boolean,$restock:Boolean,$staffNote:String){orderCancel(orderId:$orderId,reason:$reason,notifyCustomer:$notifyCustomer,refund:$refund,restock:$restock,staffNote:$staffNote){order{id name displayFinancialStatus}userErrors{field message}}}`,
            { orderId: p.id, reason: p.reason ?? "OTHER", notifyCustomer: p.notifyCustomer ?? false, refund: p.refund ?? false, restock: p.restock ?? false, staffNote: p.staffNote });
          check(res.data?.orderCancel?.userErrors, "orderCancel");
          return text(res.data?.orderCancel?.order);
        }
        case "close": {
          if (!p.id) return fail("id required");
          const res = await gql<{ orderClose: { order: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:OrderCloseInput!){orderClose(input:$input){order{id name}userErrors{field message}}}`, { input: { id: p.id } });
          check(res.data?.orderClose?.userErrors, "orderClose");
          return text(res.data?.orderClose?.order);
        }
        case "add_tags":
        case "remove_tags": {
          if (!p.id || !p.tags) return fail("id and tags required");
          const mutation = action === "add_tags" ? "tagsAdd" : "tagsRemove";
          const res = await gql<Record<string, { userErrors: Array<{ field: string[]; message: string }> }>>(
            `mutation($id:ID!,$tags:[String!]!){${mutation}(id:$id,tags:$tags){node{id}userErrors{field message}}}`, { id: p.id, tags: p.tags });
          check(res.data?.[mutation]?.userErrors, mutation);
          return text(`${action === "add_tags" ? "Added" : "Removed"} ${p.tags.length} tag(s).`);
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}

// ============================================================
// INVENTORY
// ============================================================

export function registerInventoryGateway(server: McpServer): void {
  server.tool(
    "shopify_inventory",
    `Manage inventory and locations. Actions:
- list_locations: List locations (params: first?, includeLegacy?, includeInactive?)
- get_location: Get location (params: id)
- get_item: Get inventory item (params: id)
- get_levels: Get inventory levels for an item (params: inventoryItemId, first?)
- set_quantities: Set absolute quantities (params: input{reason, name, quantities[{inventoryItemId, locationId, quantity}], ignoreCompareQuantity?})
- adjust_quantities: Adjust by delta (params: input{reason, name, changes[{inventoryItemId, locationId, delta}]})
- activate: Activate at location (params: inventoryItemId, locationId, available?)
- deactivate: Deactivate at location (params: inventoryLevelId)`,
    {
      action: z.enum(["list_locations", "get_location", "get_item", "get_levels", "set_quantities", "adjust_quantities", "activate", "deactivate"]),
      id: z.string().optional(),
      inventoryItemId: z.string().optional(),
      inventoryLevelId: z.string().optional(),
      locationId: z.string().optional(),
      first: z.number().optional(),
      includeLegacy: z.boolean().optional(),
      includeInactive: z.boolean().optional(),
      available: z.number().optional(),
      input: z.record(z.string(), z.unknown()).optional().describe("Input for set/adjust quantities"),
    },
    async ({ action, ...p }) => {
      switch (action) {
        case "list_locations": {
          const res = await gql(`query($first:Int!,$includeLegacy:Boolean,$includeInactive:Boolean){locations(first:$first,includeLegacy:$includeLegacy,includeInactive:$includeInactive){edges{node{id name isActive address{formatted}}}}}`,
            { first: p.first ?? 50, includeLegacy: p.includeLegacy ?? false, includeInactive: p.includeInactive ?? false });
          return text(res.data);
        }
        case "get_location": {
          if (!p.id) return fail("id required");
          const res = await gql(`query($id:ID){location(id:$id){id name isActive address{formatted address1 address2 city province country zip}}}`, { id: p.id });
          return text(res.data);
        }
        case "get_item": {
          if (!p.id) return fail("id required");
          const res = await gql(`query($id:ID!){inventoryItem(id:$id){id sku tracked createdAt updatedAt variants(first:1){edges{node{id title product{id title}}}}}}`, { id: p.id });
          return text(res.data);
        }
        case "get_levels": {
          if (!p.inventoryItemId) return fail("inventoryItemId required");
          const res = await gql(`query($id:ID!,$first:Int!){inventoryItem(id:$id){id sku inventoryLevels(first:$first){edges{node{id location{id name}quantities{name quantity}}}}}}`,
            { id: p.inventoryItemId, first: p.first ?? 50 });
          return text(res.data);
        }
        case "set_quantities": {
          if (!p.input) return fail("input required");
          const res = await gql<{ inventorySetQuantities: { inventoryAdjustmentGroup: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:InventorySetQuantitiesInput!){inventorySetQuantities(input:$input){inventoryAdjustmentGroup{reason}userErrors{field message}}}`, { input: p.input });
          check(res.data?.inventorySetQuantities?.userErrors, "inventorySetQuantities");
          return text(res.data?.inventorySetQuantities?.inventoryAdjustmentGroup);
        }
        case "adjust_quantities": {
          if (!p.input) return fail("input required");
          const res = await gql<{ inventoryAdjustQuantities: { inventoryAdjustmentGroup: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:InventoryAdjustQuantitiesInput!){inventoryAdjustQuantities(input:$input){inventoryAdjustmentGroup{reason}userErrors{field message}}}`, { input: p.input });
          check(res.data?.inventoryAdjustQuantities?.userErrors, "inventoryAdjustQuantities");
          return text(res.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup);
        }
        case "activate": {
          if (!p.inventoryItemId || !p.locationId) return fail("inventoryItemId and locationId required");
          const res = await gql<{ inventoryActivate: { inventoryLevel: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($inventoryItemId:ID!,$locationId:ID!,$available:Int){inventoryActivate(inventoryItemId:$inventoryItemId,locationId:$locationId,available:$available){inventoryLevel{id quantities{name quantity}}userErrors{field message}}}`,
            { inventoryItemId: p.inventoryItemId, locationId: p.locationId, available: p.available });
          check(res.data?.inventoryActivate?.userErrors, "inventoryActivate");
          return text(res.data?.inventoryActivate?.inventoryLevel);
        }
        case "deactivate": {
          if (!p.inventoryLevelId) return fail("inventoryLevelId required");
          const res = await gql<{ inventoryDeactivate: { userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($inventoryLevelId:ID!){inventoryDeactivate(inventoryLevelId:$inventoryLevelId){userErrors{field message}}}`,
            { inventoryLevelId: p.inventoryLevelId });
          check(res.data?.inventoryDeactivate?.userErrors, "inventoryDeactivate");
          return text("Inventory deactivated.");
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}

// ============================================================
// DISCOUNTS
// ============================================================

export function registerDiscountGateway(server: McpServer): void {
  server.tool(
    "shopify_discounts",
    `Manage discounts. Actions:
- list: List all discounts (params: first?, after?, query?, sortKey?, reverse?)
- get: Get discount by ID (params: id)
- create_code: Create code discount (params: title, code, startsAt, endsAt?, customerGets, minimumRequirement?, usageLimit?, appliesOncePerCustomer?)
- create_automatic: Create automatic discount (params: title, startsAt, endsAt?, customerGets, minimumRequirement?)
- delete_code: Delete code discount (params: id)
- delete_automatic: Delete automatic discount (params: id)
- activate: Activate code discount (params: id)
- deactivate: Deactivate code discount (params: id)

customerGets: {value: {percentage: 0.1} or {amount: "10", currencyCode: "USD"}, items: {all: true} or {productIds: [...]} or {collectionIds: [...]}}
minimumRequirement: {subtotal: "50"} or {quantity: 3}`,
    {
      action: z.enum(["list", "get", "create_code", "create_automatic", "delete_code", "delete_automatic", "activate", "deactivate"]),
      id: z.string().optional(),
      query: z.string().optional(),
      first: z.number().optional(),
      after: z.string().optional(),
      sortKey: z.string().optional(),
      reverse: z.boolean().optional(),
      title: z.string().optional(),
      code: z.string().optional(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      customerGets: z.record(z.string(), z.unknown()).optional(),
      minimumRequirement: z.record(z.string(), z.unknown()).optional(),
      usageLimit: z.number().optional(),
      appliesOncePerCustomer: z.boolean().optional(),
    },
    async ({ action, ...p }) => {
      const DISCOUNT_FIELDS = `... on DiscountAutomaticBasic{title startsAt endsAt status customerGets{value{...on DiscountPercentage{percentage}...on DiscountAmount{amount{amount currencyCode}}}items{...on AllDiscountItems{allItems}}}} ... on DiscountCodeBasic{title codes(first:3){nodes{code}} startsAt endsAt status customerGets{value{...on DiscountPercentage{percentage}...on DiscountAmount{amount{amount currencyCode}}}items{...on AllDiscountItems{allItems}}}}`;

      switch (action) {
        case "list": {
          const res = await gql(`query($first:Int!,$after:String,$query:String,$reverse:Boolean){discountNodes(first:$first,after:$after,query:$query,reverse:$reverse){edges{cursor node{id discount{${DISCOUNT_FIELDS}}}}pageInfo{hasNextPage endCursor}}}`,
            { first: p.first ?? 25, after: p.after, query: p.query, reverse: p.reverse ?? false });
          return text(res.data);
        }
        case "get": {
          if (!p.id) return fail("id required");
          const res = await gql(`query($id:ID!){discountNode(id:$id){id discount{${DISCOUNT_FIELDS}}}}`, { id: p.id });
          return text(res.data);
        }
        case "create_code": {
          if (!p.title || !p.code || !p.startsAt || !p.customerGets) return fail("title, code, startsAt, customerGets required");
          const cg = p.customerGets as Record<string, unknown>;
          const val = cg.value as Record<string, unknown>;
          const customerGets = {
            value: val.percentage !== undefined ? { percentage: val.percentage } : { discountAmount: { amount: val.amount, appliesOnEachItem: false } },
            items: cg.items ?? { all: true },
          };
          const basicDetail: Record<string, unknown> = { title: p.title, code: p.code, startsAt: p.startsAt, customerGets };
          if (p.endsAt) basicDetail.endsAt = p.endsAt;
          if (p.usageLimit) basicDetail.usageLimit = p.usageLimit;
          if (p.appliesOncePerCustomer) basicDetail.appliesOncePerCustomer = p.appliesOncePerCustomer;
          const res = await gql<{ discountCodeBasicCreate: { codeDiscountNode: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($basicCodeDiscount:DiscountCodeBasicInput!){discountCodeBasicCreate(basicCodeDiscount:$basicCodeDiscount){codeDiscountNode{id}userErrors{field message}}}`,
            { basicCodeDiscount: basicDetail });
          check(res.data?.discountCodeBasicCreate?.userErrors, "discountCodeBasicCreate");
          return text(res.data?.discountCodeBasicCreate?.codeDiscountNode);
        }
        case "create_automatic": {
          if (!p.title || !p.startsAt || !p.customerGets) return fail("title, startsAt, customerGets required");
          const cg = p.customerGets as Record<string, unknown>;
          const val = cg.value as Record<string, unknown>;
          const customerGets = {
            value: val.percentage !== undefined ? { percentage: val.percentage } : { discountAmount: { amount: val.amount, appliesOnEachItem: false } },
            items: cg.items ?? { all: true },
          };
          const detail: Record<string, unknown> = { title: p.title, startsAt: p.startsAt, customerGets };
          if (p.endsAt) detail.endsAt = p.endsAt;
          const res = await gql<{ discountAutomaticBasicCreate: { automaticDiscountNode: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($automaticBasicDiscount:DiscountAutomaticBasicInput!){discountAutomaticBasicCreate(automaticBasicDiscount:$automaticBasicDiscount){automaticDiscountNode{id}userErrors{field message}}}`,
            { automaticBasicDiscount: detail });
          check(res.data?.discountAutomaticBasicCreate?.userErrors, "discountAutomaticBasicCreate");
          return text(res.data?.discountAutomaticBasicCreate?.automaticDiscountNode);
        }
        case "delete_code": {
          if (!p.id) return fail("id required");
          const res = await gql<{ discountCodeDelete: { userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){discountCodeDelete(id:$id){userErrors{field message}}}`, { id: p.id });
          check(res.data?.discountCodeDelete?.userErrors, "discountCodeDelete");
          return text("Discount deleted.");
        }
        case "delete_automatic": {
          if (!p.id) return fail("id required");
          const res = await gql<{ discountAutomaticDelete: { userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){discountAutomaticDelete(id:$id){userErrors{field message}}}`, { id: p.id });
          check(res.data?.discountAutomaticDelete?.userErrors, "discountAutomaticDelete");
          return text("Discount deleted.");
        }
        case "activate": {
          if (!p.id) return fail("id required");
          const res = await gql<{ discountCodeActivate: { userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){discountCodeActivate(id:$id){codeDiscountNode{id}userErrors{field message}}}`, { id: p.id });
          check(res.data?.discountCodeActivate?.userErrors, "discountCodeActivate");
          return text("Discount activated.");
        }
        case "deactivate": {
          if (!p.id) return fail("id required");
          const res = await gql<{ discountCodeDeactivate: { userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){discountCodeDeactivate(id:$id){codeDiscountNode{id}userErrors{field message}}}`, { id: p.id });
          check(res.data?.discountCodeDeactivate?.userErrors, "discountCodeDeactivate");
          return text("Discount deactivated.");
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}

// ============================================================
// NAVIGATION (Menus + Redirects)
// ============================================================

const MENU_ITEMS = `id title type url resourceId tags items{id title type url resourceId tags items{id title type url resourceId tags}}`;

export function registerNavigationGateway(server: McpServer): void {
  server.tool(
    "shopify_navigation",
    `Manage navigation menus and URL redirects. Actions:
MENUS:
- list_menus: List menus (params: first?)
- get_menu: Get menu by ID or handle (params: id?, handle?)
- create_menu: Create menu (params: title, handle, items[])
- update_menu: Update menu — replaces full item tree (params: id, title, handle, items[])
- delete_menu: Delete menu (params: id)
REDIRECTS:
- list_redirects: List redirects (params: first?, after?, query?)
- create_redirect: Create redirect (params: path, target)
- update_redirect: Update redirect (params: id, path?, target?)
- delete_redirect: Delete redirect (params: id)
- bulk_delete_redirects: Bulk delete by search (params: search)`,
    {
      action: z.enum(["list_menus", "get_menu", "create_menu", "update_menu", "delete_menu", "list_redirects", "create_redirect", "update_redirect", "delete_redirect", "bulk_delete_redirects"]),
      id: z.string().optional(),
      handle: z.string().optional(),
      title: z.string().optional(),
      items: z.array(z.record(z.string(), z.unknown())).optional(),
      first: z.number().optional(),
      after: z.string().optional(),
      query: z.string().optional(),
      path: z.string().optional(),
      target: z.string().optional(),
      search: z.string().optional(),
    },
    async ({ action, ...p }) => {
      switch (action) {
        case "list_menus": {
          const res = await gql(`query($first:Int!,$after:String){menus(first:$first,after:$after){edges{cursor node{id title handle}}pageInfo{hasNextPage endCursor}}}`, { first: p.first ?? 25, after: p.after });
          return text(res.data);
        }
        case "get_menu": {
          if (p.id) {
            const res = await gql(`query($id:ID!){menu(id:$id){id title handle items{${MENU_ITEMS}}}}`, { id: p.id });
            return text(res.data);
          }
          if (p.handle) {
            const res = await gql<{ menus: { edges: Array<{ node: Record<string, unknown> }> } }>(`query($query:String!){menus(first:10,query:$query){edges{node{id title handle items{${MENU_ITEMS}}}}}}`, { query: `handle:${p.handle}` });
            const match = res.data?.menus?.edges?.find((e) => e.node.handle === p.handle);
            return match ? text(match.node) : fail(`No menu with handle "${p.handle}"`);
          }
          return fail("id or handle required");
        }
        case "create_menu": {
          if (!p.title || !p.handle || !p.items) return fail("title, handle, items required");
          const res = await gql<{ menuCreate: { menu: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($title:String!,$handle:String!,$items:[MenuItemCreateInput!]!){menuCreate(title:$title,handle:$handle,items:$items){menu{id title handle items{${MENU_ITEMS}}}userErrors{field message}}}`,
            { title: p.title, handle: p.handle, items: p.items });
          check(res.data?.menuCreate?.userErrors, "menuCreate");
          return text(res.data?.menuCreate?.menu);
        }
        case "update_menu": {
          if (!p.id || !p.title || !p.handle || !p.items) return fail("id, title, handle, items required");
          const res = await gql<{ menuUpdate: { menu: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$title:String!,$handle:String!,$items:[MenuItemUpdateInput!]!){menuUpdate(id:$id,title:$title,handle:$handle,items:$items){menu{id title handle items{${MENU_ITEMS}}}userErrors{field message}}}`,
            { id: p.id, title: p.title, handle: p.handle, items: p.items });
          check(res.data?.menuUpdate?.userErrors, "menuUpdate");
          return text(res.data?.menuUpdate?.menu);
        }
        case "delete_menu": {
          if (!p.id) return fail("id required");
          const res = await gql<{ menuDelete: { deletedMenuId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){menuDelete(id:$id){deletedMenuId userErrors{field message}}}`, { id: p.id });
          check(res.data?.menuDelete?.userErrors, "menuDelete");
          return text(`Menu ${res.data?.menuDelete?.deletedMenuId} deleted.`);
        }
        case "list_redirects": {
          const res = await gql(`query($first:Int!,$after:String,$query:String){urlRedirects(first:$first,after:$after,query:$query){edges{cursor node{id path target}}pageInfo{hasNextPage endCursor}}}`,
            { first: p.first ?? 50, after: p.after, query: p.query });
          return text(res.data);
        }
        case "create_redirect": {
          if (!p.path || !p.target) return fail("path and target required");
          const res = await gql<{ urlRedirectCreate: { urlRedirect: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($urlRedirect:UrlRedirectInput!){urlRedirectCreate(urlRedirect:$urlRedirect){urlRedirect{id path target}userErrors{field message}}}`, { urlRedirect: { path: p.path, target: p.target } });
          check(res.data?.urlRedirectCreate?.userErrors, "urlRedirectCreate");
          return text(res.data?.urlRedirectCreate?.urlRedirect);
        }
        case "update_redirect": {
          if (!p.id) return fail("id required");
          const redir: Record<string, string> = {};
          if (p.path) redir.path = p.path;
          if (p.target) redir.target = p.target;
          const res = await gql<{ urlRedirectUpdate: { urlRedirect: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$urlRedirect:UrlRedirectInput!){urlRedirectUpdate(id:$id,urlRedirect:$urlRedirect){urlRedirect{id path target}userErrors{field message}}}`, { id: p.id, urlRedirect: redir });
          check(res.data?.urlRedirectUpdate?.userErrors, "urlRedirectUpdate");
          return text(res.data?.urlRedirectUpdate?.urlRedirect);
        }
        case "delete_redirect": {
          if (!p.id) return fail("id required");
          const res = await gql<{ urlRedirectDelete: { deletedUrlRedirectId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){urlRedirectDelete(id:$id){deletedUrlRedirectId userErrors{field message}}}`, { id: p.id });
          check(res.data?.urlRedirectDelete?.userErrors, "urlRedirectDelete");
          return text(`Redirect ${res.data?.urlRedirectDelete?.deletedUrlRedirectId} deleted.`);
        }
        case "bulk_delete_redirects": {
          if (!p.search) return fail("search required");
          const res = await gql<{ urlRedirectBulkDeleteBySearch: { job: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($search:String!){urlRedirectBulkDeleteBySearch(search:$search){job{id done}userErrors{field message}}}`, { search: p.search });
          check(res.data?.urlRedirectBulkDeleteBySearch?.userErrors, "urlRedirectBulkDeleteBySearch");
          return text(res.data?.urlRedirectBulkDeleteBySearch?.job);
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}

// ============================================================
// CONTENT (Pages + Blog/Articles)
// ============================================================

export function registerContentGateway(server: McpServer): void {
  server.tool(
    "shopify_content",
    `Manage pages and blog articles. Actions:
PAGES:
- list_pages: List pages (params: first?, after?, query?)
- get_page: Get page by ID (params: id)
- create_page: Create page (params: title, body?, handle?, isPublished?)
- update_page: Update page (params: id, title?, body?, handle?, isPublished?)
- delete_page: Delete page (params: id)
BLOG/ARTICLES:
- list_blogs: List blogs (params: first?)
- list_articles: List articles (params: first?, after?, query?)
- create_article: Create article (params: blogId, title, body?, authorName?, tags?, isPublished?)
- update_article: Update article (params: id, title?, body?, tags?, isPublished?)
- delete_article: Delete article (params: id)`,
    {
      action: z.enum(["list_pages", "get_page", "create_page", "update_page", "delete_page", "list_blogs", "list_articles", "create_article", "update_article", "delete_article"]),
      id: z.string().optional(),
      blogId: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      handle: z.string().optional(),
      isPublished: z.boolean().optional(),
      authorName: z.string().optional(),
      tags: z.array(z.string()).optional(),
      query: z.string().optional(),
      first: z.number().optional(),
      after: z.string().optional(),
    },
    async ({ action, ...p }) => {
      switch (action) {
        case "list_pages": {
          const res = await gql(`query($first:Int!,$after:String,$query:String){pages(first:$first,after:$after,query:$query){edges{cursor node{id title handle isPublished createdAt updatedAt}}pageInfo{hasNextPage endCursor}}}`,
            { first: p.first ?? 25, after: p.after, query: p.query });
          return text(res.data);
        }
        case "get_page": {
          if (!p.id) return fail("id required");
          const res = await gql(`query($id:ID!){page(id:$id){id title handle body isPublished createdAt updatedAt metafields(first:10){edges{node{id namespace key value type}}}}}`, { id: p.id });
          return text(res.data);
        }
        case "create_page": {
          if (!p.title) return fail("title required");
          const input: Record<string, unknown> = { title: p.title };
          if (p.body !== undefined) input.body = p.body;
          if (p.handle) input.handle = p.handle;
          if (p.isPublished !== undefined) input.isPublished = p.isPublished;
          const res = await gql<{ pageCreate: { page: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($page:PageCreateInput!){pageCreate(page:$page){page{id title handle isPublished}userErrors{field message}}}`, { page: input });
          check(res.data?.pageCreate?.userErrors, "pageCreate");
          return text(res.data?.pageCreate?.page);
        }
        case "update_page": {
          if (!p.id) return fail("id required");
          const input: Record<string, unknown> = { id: p.id };
          if (p.title) input.title = p.title;
          if (p.body !== undefined) input.body = p.body;
          if (p.handle) input.handle = p.handle;
          if (p.isPublished !== undefined) input.isPublished = p.isPublished;
          const res = await gql<{ pageUpdate: { page: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$page:PageUpdateInput!){pageUpdate(id:$id,page:$page){page{id title handle isPublished}userErrors{field message}}}`, { id: p.id, page: input });
          check(res.data?.pageUpdate?.userErrors, "pageUpdate");
          return text(res.data?.pageUpdate?.page);
        }
        case "delete_page": {
          if (!p.id) return fail("id required");
          const res = await gql<{ pageDelete: { deletedPageId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){pageDelete(id:$id){deletedPageId userErrors{field message}}}`, { id: p.id });
          check(res.data?.pageDelete?.userErrors, "pageDelete");
          return text(`Page deleted.`);
        }
        case "list_blogs": {
          const res = await gql(`query($first:Int!){blogs(first:$first){edges{node{id title handle}}}}`, { first: p.first ?? 25 });
          return text(res.data);
        }
        case "list_articles": {
          const res = await gql(`query($first:Int!,$after:String,$query:String){articles(first:$first,after:$after,query:$query){edges{cursor node{id title handle blog{id title} tags isPublished publishedAt}}pageInfo{hasNextPage endCursor}}}`,
            { first: p.first ?? 25, after: p.after, query: p.query });
          return text(res.data);
        }
        case "create_article": {
          if (!p.blogId || !p.title) return fail("blogId and title required");
          const input: Record<string, unknown> = { blog: { id: p.blogId }, title: p.title };
          if (p.body !== undefined) input.body = p.body;
          if (p.authorName) input.author = { name: p.authorName };
          if (p.tags) input.tags = p.tags;
          if (p.isPublished !== undefined) input.isPublished = p.isPublished;
          const res = await gql<{ articleCreate: { article: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($article:ArticleCreateInput!){articleCreate(article:$article){article{id title handle isPublished}userErrors{field message}}}`, { article: input });
          check(res.data?.articleCreate?.userErrors, "articleCreate");
          return text(res.data?.articleCreate?.article);
        }
        case "update_article": {
          if (!p.id) return fail("id required");
          const input: Record<string, unknown> = { id: p.id };
          if (p.title) input.title = p.title;
          if (p.body !== undefined) input.body = p.body;
          if (p.tags) input.tags = p.tags;
          if (p.isPublished !== undefined) input.isPublished = p.isPublished;
          const res = await gql<{ articleUpdate: { article: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$article:ArticleUpdateInput!){articleUpdate(id:$id,article:$article){article{id title handle isPublished}userErrors{field message}}}`, { id: p.id, article: input });
          check(res.data?.articleUpdate?.userErrors, "articleUpdate");
          return text(res.data?.articleUpdate?.article);
        }
        case "delete_article": {
          if (!p.id) return fail("id required");
          const res = await gql<{ articleDelete: { deletedArticleId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){articleDelete(id:$id){deletedArticleId userErrors{field message}}}`, { id: p.id });
          check(res.data?.articleDelete?.userErrors, "articleDelete");
          return text("Article deleted.");
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}

// ============================================================
// FILES
// ============================================================

export function registerFileGateway(server: McpServer): void {
  server.tool(
    "shopify_files",
    `Manage files (images, videos, documents). Actions:
- list: List files (params: first?, after?, query?)
- get: Get file by ID (params: id)
- create: Create files from URLs (params: files[{originalSource, alt?, contentType?}])
- update: Update file metadata (params: files[{id, alt?, filename?}])
- delete: Delete files (params: ids[])`,
    {
      action: z.enum(["list", "get", "create", "update", "delete"]),
      id: z.string().optional(),
      ids: z.array(z.string()).optional(),
      query: z.string().optional(),
      first: z.number().optional(),
      after: z.string().optional(),
      files: z.array(z.record(z.string(), z.unknown())).optional(),
    },
    async ({ action, ...p }) => {
      switch (action) {
        case "list": {
          const res = await gql(`query($first:Int!,$after:String,$query:String){files(first:$first,after:$after,query:$query){edges{cursor node{...on GenericFile{id url mimeType createdAt}...on MediaImage{id image{url altText width height} mimeType createdAt}...on Video{id filename sources{url mimeType}}}}pageInfo{hasNextPage endCursor}}}`,
            { first: p.first ?? 25, after: p.after, query: p.query });
          return text(res.data);
        }
        case "get": {
          if (!p.id) return fail("id required");
          const res = await gql(`query($id:[ID!]!){nodes(ids:$id){...on GenericFile{id url mimeType createdAt}...on MediaImage{id image{url altText width height} mimeType createdAt fileStatus}...on Video{id filename sources{url mimeType}}}}`, { id: [p.id] });
          return text(res.data);
        }
        case "create": {
          if (!p.files) return fail("files required");
          const res = await gql<{ fileCreate: { files: unknown[]; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($files:[FileCreateInput!]!){fileCreate(files:$files){files{...on GenericFile{id url}...on MediaImage{id image{url altText}}}userErrors{field message}}}`, { files: p.files });
          check(res.data?.fileCreate?.userErrors, "fileCreate");
          return text(res.data?.fileCreate?.files);
        }
        case "update": {
          if (!p.files) return fail("files required");
          const res = await gql<{ fileUpdate: { files: unknown[]; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($files:[FileUpdateInput!]!){fileUpdate(files:$files){files{...on GenericFile{id url}...on MediaImage{id image{url altText}}}userErrors{field message}}}`, { files: p.files });
          check(res.data?.fileUpdate?.userErrors, "fileUpdate");
          return text(res.data?.fileUpdate?.files);
        }
        case "delete": {
          if (!p.ids) return fail("ids required");
          const res = await gql<{ fileDelete: { deletedFileIds: string[]; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($fileIds:[ID!]!){fileDelete(fileIds:$fileIds){deletedFileIds userErrors{field message}}}`, { fileIds: p.ids });
          check(res.data?.fileDelete?.userErrors, "fileDelete");
          return text(`Deleted ${p.ids.length} file(s).`);
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}

// ============================================================
// DRAFT ORDERS
// ============================================================

export function registerDraftOrderGateway(server: McpServer): void {
  server.tool(
    "shopify_draft_orders",
    `Manage draft orders. Actions:
- list: List draft orders (params: first?, after?, query?, sortKey?, reverse?)
- get: Get draft order by ID (params: id)
- create: Create draft order (params: lineItems[{variantId?, title?, quantity, originalUnitPrice?}], customerId?, shippingAddress?, billingAddress?, note?, tags?, metafields?)
- update: Update draft order (params: id, lineItems?, note?, tags?, shippingAddress?)
- complete: Complete draft order → real order (params: id, paymentPending?)
- delete: Delete draft order (params: id)`,
    {
      action: z.enum(["list", "get", "create", "update", "complete", "delete"]),
      id: z.string().optional(),
      query: z.string().optional(),
      first: z.number().optional(),
      after: z.string().optional(),
      sortKey: z.string().optional(),
      reverse: z.boolean().optional(),
      lineItems: z.array(z.record(z.string(), z.unknown())).optional(),
      customerId: z.string().optional(),
      shippingAddress: z.record(z.string(), z.unknown()).optional(),
      billingAddress: z.record(z.string(), z.unknown()).optional(),
      note: z.string().optional(),
      tags: z.array(z.string()).optional(),
      metafields: z.array(z.object({ namespace: z.string(), key: z.string(), value: z.string(), type: z.string() })).optional(),
      paymentPending: z.boolean().optional(),
    },
    async ({ action, ...p }) => {
      const DO_SUMMARY = `id name status createdAt updatedAt totalPriceSet{shopMoney{amount currencyCode}} customer{id displayName}`;
      const DO_FULL = `id name status createdAt updatedAt note tags totalPriceSet{shopMoney{amount currencyCode}} subtotalPriceSet{shopMoney{amount currencyCode}} totalTaxSet{shopMoney{amount currencyCode}} customer{id displayName defaultEmailAddress{emailAddress}} shippingAddress{firstName lastName address1 address2 city province country zip} lineItems(first:50){edges{node{id title quantity originalUnitPriceSet{shopMoney{amount currencyCode}} variant{id title sku}}}}`;
      switch (action) {
        case "list": {
          const res = await gql(`query($first:Int!,$after:String,$query:String,$sortKey:DraftOrderSortKeys!,$reverse:Boolean!){draftOrders(first:$first,after:$after,query:$query,sortKey:$sortKey,reverse:$reverse){edges{cursor node{${DO_SUMMARY}}}pageInfo{hasNextPage endCursor}}}`,
            { first: p.first ?? 25, after: p.after, query: p.query, sortKey: p.sortKey ?? "UPDATED_AT", reverse: p.reverse ?? true });
          return text(res.data);
        }
        case "get": {
          if (!p.id) return fail("id required");
          const res = await gql(`query($id:ID!){draftOrder(id:$id){${DO_FULL}}}`, { id: p.id });
          return text(res.data);
        }
        case "create": {
          if (!p.lineItems) return fail("lineItems required");
          const input: Record<string, unknown> = { lineItems: p.lineItems };
          if (p.customerId) input.customerId = p.customerId;
          if (p.shippingAddress) input.shippingAddress = p.shippingAddress;
          if (p.billingAddress) input.billingAddress = p.billingAddress;
          if (p.note) input.note = p.note;
          if (p.tags) input.tags = p.tags;
          if (p.metafields) input.metafields = p.metafields;
          const res = await gql<{ draftOrderCreate: { draftOrder: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:DraftOrderInput!){draftOrderCreate(input:$input){draftOrder{${DO_FULL}}userErrors{field message}}}`, { input });
          check(res.data?.draftOrderCreate?.userErrors, "draftOrderCreate");
          return text(res.data?.draftOrderCreate?.draftOrder);
        }
        case "update": {
          if (!p.id) return fail("id required");
          const input: Record<string, unknown> = {};
          if (p.lineItems) input.lineItems = p.lineItems;
          if (p.note !== undefined) input.note = p.note;
          if (p.tags) input.tags = p.tags;
          if (p.shippingAddress) input.shippingAddress = p.shippingAddress;
          const res = await gql<{ draftOrderUpdate: { draftOrder: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$input:DraftOrderInput!){draftOrderUpdate(id:$id,input:$input){draftOrder{${DO_FULL}}userErrors{field message}}}`, { id: p.id, input });
          check(res.data?.draftOrderUpdate?.userErrors, "draftOrderUpdate");
          return text(res.data?.draftOrderUpdate?.draftOrder);
        }
        case "complete": {
          if (!p.id) return fail("id required");
          const res = await gql<{ draftOrderComplete: { draftOrder: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$paymentPending:Boolean){draftOrderComplete(id:$id,paymentPending:$paymentPending){draftOrder{id name status order{id name}}userErrors{field message}}}`,
            { id: p.id, paymentPending: p.paymentPending ?? false });
          check(res.data?.draftOrderComplete?.userErrors, "draftOrderComplete");
          return text(res.data?.draftOrderComplete?.draftOrder);
        }
        case "delete": {
          if (!p.id) return fail("id required");
          const res = await gql<{ draftOrderDelete: { deletedId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($input:DraftOrderDeleteInput!){draftOrderDelete(input:$input){deletedId userErrors{field message}}}`, { input: { id: p.id } });
          check(res.data?.draftOrderDelete?.userErrors, "draftOrderDelete");
          return text("Draft order deleted.");
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}

// ============================================================
// METAOBJECTS
// ============================================================

export function registerMetaobjectGateway(server: McpServer): void {
  server.tool(
    "shopify_metaobjects",
    `Manage metaobject definitions and entries. Actions:
DEFINITIONS:
- list_definitions: List definitions (params: first?)
- get_definition: Get definition by ID or type (params: id?, type?)
- create_definition: Create definition (params: definition{type, name, fieldDefinitions[{key, name, type}], access?, capabilities?})
- update_definition: Update definition (params: id, definition)
- delete_definition: Delete definition (params: id)
ENTRIES:
- list: List metaobjects by type (params: type, first?, after?, query?, sortKey?, reverse?)
- get: Get metaobject by ID or handle+type (params: id?, handle?, type?)
- create: Create metaobject (params: metaobject{type, handle?, fields[{key, value}], capabilities?})
- update: Update metaobject (params: id, metaobject{handle?, fields[{key, value}]})
- delete: Delete metaobject (params: id)`,
    {
      action: z.enum(["list_definitions", "get_definition", "create_definition", "update_definition", "delete_definition", "list", "get", "create", "update", "delete"]),
      id: z.string().optional(),
      type: z.string().optional(),
      handle: z.string().optional(),
      query: z.string().optional(),
      first: z.number().optional(),
      after: z.string().optional(),
      sortKey: z.string().optional(),
      reverse: z.boolean().optional(),
      definition: z.record(z.string(), z.unknown()).optional(),
      metaobject: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ action, ...p }) => {
      const DEF_FIELDS = `id type name fieldDefinitions{key name type{name}}`;
      const MO_FIELDS = `id type handle displayName fields{key value type}`;

      switch (action) {
        case "list_definitions": {
          const res = await gql(`query($first:Int!){metaobjectDefinitions(first:$first){edges{node{${DEF_FIELDS}}}}}`, { first: p.first ?? 50 });
          return text(res.data);
        }
        case "get_definition": {
          if (p.id) { const res = await gql(`query($id:ID!){metaobjectDefinition(id:$id){${DEF_FIELDS}}}`, { id: p.id }); return text(res.data); }
          if (p.type) { const res = await gql(`query($type:String!){metaobjectDefinitionByType(type:$type){${DEF_FIELDS}}}`, { type: p.type }); return text(res.data); }
          return fail("id or type required");
        }
        case "create_definition": {
          if (!p.definition) return fail("definition required");
          const res = await gql<{ metaobjectDefinitionCreate: { metaobjectDefinition: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($definition:MetaobjectDefinitionCreateInput!){metaobjectDefinitionCreate(definition:$definition){metaobjectDefinition{${DEF_FIELDS}}userErrors{field message}}}`, { definition: p.definition });
          check(res.data?.metaobjectDefinitionCreate?.userErrors, "metaobjectDefinitionCreate");
          return text(res.data?.metaobjectDefinitionCreate?.metaobjectDefinition);
        }
        case "update_definition": {
          if (!p.id || !p.definition) return fail("id and definition required");
          const res = await gql<{ metaobjectDefinitionUpdate: { metaobjectDefinition: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$definition:MetaobjectDefinitionUpdateInput!){metaobjectDefinitionUpdate(id:$id,definition:$definition){metaobjectDefinition{${DEF_FIELDS}}userErrors{field message}}}`, { id: p.id, definition: p.definition });
          check(res.data?.metaobjectDefinitionUpdate?.userErrors, "metaobjectDefinitionUpdate");
          return text(res.data?.metaobjectDefinitionUpdate?.metaobjectDefinition);
        }
        case "delete_definition": {
          if (!p.id) return fail("id required");
          const res = await gql<{ metaobjectDefinitionDelete: { deletedId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){metaobjectDefinitionDelete(id:$id){deletedId userErrors{field message}}}`, { id: p.id });
          check(res.data?.metaobjectDefinitionDelete?.userErrors, "metaobjectDefinitionDelete");
          return text("Definition deleted.");
        }
        case "list": {
          if (!p.type) return fail("type required");
          const res = await gql(`query($type:String!,$first:Int!,$after:String,$reverse:Boolean){metaobjects(type:$type,first:$first,after:$after,reverse:$reverse){edges{cursor node{${MO_FIELDS}}}pageInfo{hasNextPage endCursor}}}`,
            { type: p.type, first: p.first ?? 25, after: p.after, reverse: p.reverse ?? false });
          return text(res.data);
        }
        case "get": {
          if (p.id) { const res = await gql(`query($id:ID!){metaobject(id:$id){${MO_FIELDS}}}`, { id: p.id }); return text(res.data); }
          if (p.handle && p.type) { const res = await gql(`query($handle:MetaobjectHandleInput!){metaobjectByHandle(handle:$handle){${MO_FIELDS}}}`, { handle: { handle: p.handle, type: p.type } }); return text(res.data); }
          return fail("id, or handle+type required");
        }
        case "create": {
          if (!p.metaobject) return fail("metaobject required");
          const res = await gql<{ metaobjectCreate: { metaobject: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($metaobject:MetaobjectCreateInput!){metaobjectCreate(metaobject:$metaobject){metaobject{${MO_FIELDS}}userErrors{field message}}}`, { metaobject: p.metaobject });
          check(res.data?.metaobjectCreate?.userErrors, "metaobjectCreate");
          return text(res.data?.metaobjectCreate?.metaobject);
        }
        case "update": {
          if (!p.id || !p.metaobject) return fail("id and metaobject required");
          const res = await gql<{ metaobjectUpdate: { metaobject: unknown; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!,$metaobject:MetaobjectUpdateInput!){metaobjectUpdate(id:$id,metaobject:$metaobject){metaobject{${MO_FIELDS}}userErrors{field message}}}`, { id: p.id, metaobject: p.metaobject });
          check(res.data?.metaobjectUpdate?.userErrors, "metaobjectUpdate");
          return text(res.data?.metaobjectUpdate?.metaobject);
        }
        case "delete": {
          if (!p.id) return fail("id required");
          const res = await gql<{ metaobjectDelete: { deletedId: string; userErrors: Array<{ field: string[]; message: string }> } }>(
            `mutation($id:ID!){metaobjectDelete(id:$id){deletedId userErrors{field message}}}`, { id: p.id });
          check(res.data?.metaobjectDelete?.userErrors, "metaobjectDelete");
          return text("Metaobject deleted.");
        }
        default: return fail(`Unknown action: ${action}`);
      }
    },
  );
}
