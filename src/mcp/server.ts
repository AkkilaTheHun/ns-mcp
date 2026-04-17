import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerShopGateway,
  registerProductGateway,
  registerVariantGateway,
  registerCollectionGateway,
  registerMetafieldGateway,
  registerCustomerGateway,
} from "./gateway.js";
import {
  registerOrderGateway,
  registerInventoryGateway,
  registerDiscountGateway,
  registerNavigationGateway,
  registerContentGateway,
  registerFileGateway,
  registerDraftOrderGateway,
  registerMetaobjectGateway,
} from "./gateway2.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "nailstuff-mcp",
    version: "1.0.0",
  });

  // 15 gateway tools covering all 114 operations
  registerShopGateway(server);         // list, select, info
  registerProductGateway(server);      // list, get, search, count, create, update, delete, add_media
  registerVariantGateway(server);      // create, update, delete
  registerCollectionGateway(server);   // list, get, count, create, create_smart, update, delete, add/remove/list/reorder products
  registerMetafieldGateway(server);    // set, delete (shared across all resources)
  registerCustomerGateway(server);     // list, get, search, count, create, update, delete, tags, consent, activation
  registerOrderGateway(server);        // list, get, search, count, update, cancel, close, tags
  registerInventoryGateway(server);    // locations, items, levels, set/adjust, activate/deactivate
  registerDiscountGateway(server);     // list, get, create/delete code+automatic, activate/deactivate
  registerNavigationGateway(server);   // menus + redirects CRUD
  registerContentGateway(server);      // pages + blog/articles CRUD
  registerFileGateway(server);         // list, get, create, update, delete
  registerDraftOrderGateway(server);   // list, get, create, update, complete, delete
  registerMetaobjectGateway(server);   // definitions + entries CRUD

  return server;
}
