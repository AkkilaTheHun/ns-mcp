import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCurrentSessionId } from "../context.js";
import {
  registerShopGateway,
  registerGraphQLGateway,
  registerTranslationGateway,
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
import { registerPrompts } from "./prompts.js";

/**
 * Wraps server.tool() to log every tool call with session, params, and outcome.
 */
function withAuditLog(server: McpServer): McpServer {
  const originalTool = server.tool.bind(server);

  server.tool = ((...args: unknown[]) => {
    // server.tool has multiple overloads; the handler is always last
    const handler = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
    const toolName = args[0] as string;

    args[args.length - 1] = async (params: Record<string, unknown>, extra: unknown) => {
      const sessionId = getCurrentSessionId() ?? "unknown";
      const action = params.action ?? "";
      const ts = new Date().toISOString();

      // Log params but redact large fields (query bodies, descriptionHtml, etc.)
      const logParams = { ...params };
      for (const [k, v] of Object.entries(logParams)) {
        if (typeof v === "string" && v.length > 200) {
          logParams[k] = `[${v.length} chars]`;
        }
      }

      console.log(JSON.stringify({
        audit: "tool_call",
        ts,
        sessionId,
        tool: toolName,
        action,
        params: logParams,
      }));

      try {
        const result = await handler(params, extra);
        const res = result as { isError?: boolean; content?: Array<{ text?: string }> };
        const responseSize = res.content?.[0]?.text?.length ?? 0;

        console.log(JSON.stringify({
          audit: "tool_result",
          ts: new Date().toISOString(),
          sessionId,
          tool: toolName,
          action,
          ok: !res.isError,
          responseBytes: responseSize,
        }));

        return result;
      } catch (err) {
        console.log(JSON.stringify({
          audit: "tool_error",
          ts: new Date().toISOString(),
          sessionId,
          tool: toolName,
          action,
          error: String(err),
        }));
        throw err;
      }
    };

    return (originalTool as (...a: unknown[]) => unknown)(...args);
  }) as typeof server.tool;

  return server;
}

export function createMcpServer(): McpServer {
  const server = withAuditLog(new McpServer({
    name: "nailstuff-mcp",
    version: "1.0.0",
  }));

  // Gateway tools
  registerShopGateway(server);         // list, select, info
  registerGraphQLGateway(server);      // raw GraphQL for full API access
  registerTranslationGateway(server);  // translations for any resource
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

  // Prompts (pre-built workflows)
  registerPrompts(server);

  return server;
}
