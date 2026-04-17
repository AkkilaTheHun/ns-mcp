import type { Request, Response } from "express";
import { config } from "../config.js";

/**
 * Shared store for dynamically registered OAuth clients (RFC 7591).
 * Populated by the /oauth/register endpoint in index.ts.
 */
export const registeredOAuthClients = new Map<string, { clientSecret: string; clientName: string }>();

/**
 * OAuth install redirect — sends the merchant to Shopify's authorization page.
 */
export function handleAuthBegin(req: Request, res: Response): void {
  const shop = req.query.shop as string | undefined;
  if (!shop) {
    res.status(400).send("Missing shop parameter");
    return;
  }

  const scopes = [
    "read_products", "write_products",
    "read_orders", "write_orders",
    "read_customers", "write_customers",
    "read_content", "write_content",
    "read_themes", "write_themes",
    "read_inventory", "write_inventory",
    "read_discounts", "write_discounts",
    "read_metaobjects", "write_metaobjects",
    "read_publications", "write_publications",
    "read_files", "write_files",
    "read_online_store_navigation", "write_online_store_navigation",
    "read_draft_orders", "write_draft_orders",
    "read_locations",
  ].join(",");

  const redirectUri = `${config.hostUrl}/auth/callback`;
  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${config.shopifyApiKey}` +
    `&scope=${scopes}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(installUrl);
}

/**
 * OAuth callback — exchanges the authorization code for an offline access token.
 */
export async function handleAuthCallback(req: Request, res: Response): Promise<void> {
  const { shop, code } = req.query as { shop?: string; code?: string };

  if (!shop || !code) {
    res.status(400).send("Missing shop or code parameter");
    return;
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.shopifyApiKey,
        client_secret: config.shopifyApiSecret,
        code,
      }),
    });

    if (!tokenRes.ok) {
      res.status(500).send(`Token exchange failed: ${tokenRes.statusText}`);
      return;
    }

    const data = (await tokenRes.json()) as { access_token: string; scope: string };

    console.log("=== NEW SHOP INSTALLED ===");
    console.log(`Shop: ${shop}`);
    console.log(`Token: ${data.access_token}`);
    console.log(`Scopes: ${data.scope}`);
    console.log("");
    console.log("Add to your SHOPS env var:");
    console.log(`  "${shop}": "${data.access_token}"`);
    console.log("==========================");

    res.send(
      `<h1>App Installed</h1>` +
      `<p>Shop: ${shop}</p>` +
      `<p>Scopes: ${data.scope}</p>` +
      `<p>Add the following to your <code>SHOPS</code> environment variable on Render:</p>` +
      `<pre>"${shop}": "${data.access_token}"</pre>`,
    );
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth callback failed");
  }
}

// In-memory store for authorization codes (short-lived)
const authCodes = new Map<string, {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}>();

/**
 * OAuth 2.0 Authorization endpoint.
 * Supports both confidential clients (client_id/secret) and
 * public clients with PKCE (Claude Desktop, etc.).
 */
export function handleOAuthAuthorize(req: Request, res: Response): void {
  const {
    client_id,
    redirect_uri,
    response_type,
    state,
    code_challenge,
    code_challenge_method,
  } = req.query as Record<string, string>;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  if (!client_id || !redirect_uri) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing client_id or redirect_uri" });
    return;
  }

  // Auto-approve: generate code and redirect back immediately.
  const code = crypto.randomUUID();
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    expiresAt: Date.now() + 300_000, // 5 minute expiry
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  res.redirect(redirectUrl.toString());
}

/**
 * Verify PKCE code_verifier against stored code_challenge.
 */
async function verifyPKCE(codeVerifier: string, codeChallenge: string, method: string): Promise<boolean> {
  if (method === "plain") return codeVerifier === codeChallenge;
  // S256
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
  const base64 = Buffer.from(digest).toString("base64url");
  return base64 === codeChallenge;
}

/**
 * OAuth 2.0 Token endpoint.
 * Supports authorization_code (with optional PKCE) and client_credentials.
 */
export async function handleOAuthToken(req: Request, res: Response): Promise<void> {
  const grantType = req.body.grant_type;

  // Accept credentials from body or Basic auth header
  let clientId = req.body.client_id as string | undefined;
  let clientSecret = req.body.client_secret as string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const [id, secret] = decoded.split(":");
    clientId = clientId ?? id;
    clientSecret = clientSecret ?? secret;
  }

  if (grantType === "authorization_code") {
    const code = req.body.code as string | undefined;
    const codeVerifier = req.body.code_verifier as string | undefined;

    if (!code) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code" });
      return;
    }

    const stored = authCodes.get(code);
    if (!stored || stored.expiresAt < Date.now()) {
      authCodes.delete(code);
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // Verify client identity: either client_secret or PKCE code_verifier
    if (stored.codeChallenge) {
      // PKCE flow (public client like Claude Desktop)
      if (!codeVerifier) {
        res.status(400).json({ error: "invalid_request", error_description: "Missing code_verifier" });
        return;
      }
      const valid = await verifyPKCE(codeVerifier, stored.codeChallenge, stored.codeChallengeMethod ?? "S256");
      if (!valid) {
        authCodes.delete(code);
        res.status(400).json({ error: "invalid_grant", error_description: "Invalid code_verifier" });
        return;
      }
    } else {
      // Confidential client — verify client_secret (static or dynamically registered)
      const isStaticClient = clientId === config.oauthClientId && clientSecret === config.oauthClientSecret;
      const dynClient = registeredOAuthClients.get(clientId ?? "");
      const isDynClient = dynClient && dynClient.clientSecret === clientSecret;
      if (!isStaticClient && !isDynClient) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
    }

    authCodes.delete(code);

    res.json({
      access_token: config.mcpAuthToken,
      token_type: "bearer",
      expires_in: 86400,
    });
    return;
  }

  if (grantType === "client_credentials") {
    const isStaticClient = clientId === config.oauthClientId && clientSecret === config.oauthClientSecret;
    const dynClient2 = registeredOAuthClients.get(clientId ?? "");
    const isDynClient2 = dynClient2 && dynClient2.clientSecret === clientSecret;
    if (!isStaticClient && !isDynClient2) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    res.json({
      access_token: config.mcpAuthToken,
      token_type: "bearer",
      expires_in: 86400,
    });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
}
