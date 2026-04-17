import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProductTools } from "./tools/products.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerRedirectTools } from "./tools/redirects.js";
import { registerMenuTools } from "./tools/menus.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerInventoryTools } from "./tools/inventory.js";
import { registerMetaobjectTools } from "./tools/metaobjects.js";
import { registerDiscountTools } from "./tools/discounts.js";
import { registerPageTools } from "./tools/pages.js";
import { registerFileTools } from "./tools/files.js";
import { registerDraftOrderTools } from "./tools/draft-orders.js";
import { registerShopTools } from "./tools/shop.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "nailstuff-mcp",
    version: "1.0.0",
  });

  // Register all tool groups
  registerShopTools(server);
  registerProductTools(server);
  registerCollectionTools(server);
  registerRedirectTools(server);
  registerMenuTools(server);
  registerCustomerTools(server);
  registerOrderTools(server);
  registerInventoryTools(server);
  registerMetaobjectTools(server);
  registerDiscountTools(server);
  registerPageTools(server);
  registerFileTools(server);
  registerDraftOrderTools(server);

  return server;
}
