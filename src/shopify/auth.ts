import type { Request, Response } from "express";
import { config } from "../config.js";

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

/**
 * OAuth 2.0 token endpoint for MCP clients (ChatGPT, etc.).
 * Supports client_credentials grant type.
 */
export async function handleOAuthToken(req: Request, res: Response): Promise<void> {
  const grantType = req.body.grant_type;

  if (grantType !== "client_credentials") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

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

  if (
    !clientId || !clientSecret ||
    clientId !== config.oauthClientId ||
    clientSecret !== config.oauthClientSecret
  ) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  res.json({
    access_token: config.mcpAuthToken,
    token_type: "bearer",
    expires_in: 86400,
  });
}
