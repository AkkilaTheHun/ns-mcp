import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProductTools } from "./tools/products.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerRedirectTools } from "./tools/redirects.js";
import { registerMenuTools } from "./tools/menus.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "nailstuff-mcp",
    version: "1.0.0",
  });

  // Register all tool groups
  registerProductTools(server);
  registerCollectionTools(server);
  registerRedirectTools(server);
  registerMenuTools(server);

  return server;
}
