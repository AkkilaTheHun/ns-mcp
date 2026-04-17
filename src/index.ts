import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp/server.js";
import { config } from "./config.js";
import { handleAuthBegin, handleAuthCallback, handleOAuthAuthorize, handleOAuthToken } from "./shopify/auth.js";

const app = express();
app.use(express.json());

// --- Health check ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

// --- Shopify OAuth routes ---
app.get("/auth", handleAuthBegin);
app.get("/auth/callback", handleAuthCallback);

// --- OAuth 2.0 endpoints (for ChatGPT and other MCP clients) ---
app.get("/oauth/authorize", handleOAuthAuthorize);
app.post("/oauth/token", handleOAuthToken);

// --- MCP endpoint ---
// Auth middleware for MCP clients
function mcpAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (config.mcpAuthToken) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${config.mcpAuthToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  next();
}

// Map to track active transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", mcpAuth, async (req, res) => {
  try {
    // Check for existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport for the session
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — create server + transport
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    await server.connect(transport);

    // Store transport by session ID after connection
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    await transport.handleRequest(req, res, req.body);

    // Store the transport after handling (session ID is now set)
    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
    }
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Handle GET for SSE stream (server-to-client notifications)
app.get("/mcp", mcpAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }

  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res, req.body);
});

// Handle DELETE for session cleanup
app.delete("/mcp", mcpAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }

  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res, req.body);
});

// --- Start server ---
app.listen(config.port, () => {
  console.log(`Nailstuff MCP server running on port ${config.port}`);
  console.log(`MCP endpoint: ${config.hostUrl}/mcp`);
  console.log(`OAuth token: ${config.hostUrl}/oauth/token`);
  console.log(`Health check: ${config.hostUrl}/health`);
  console.log(`Connected shops: ${[...config.shops.keys()].join(", ") || "none"}`);
  if (config.shops.size === 0) {
    console.log(`\nNo shops configured. Install the app: ${config.hostUrl}/auth?shop=YOUR-STORE.myshopify.com`);
  }
});
