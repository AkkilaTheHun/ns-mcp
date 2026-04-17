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

  // TODO: Validate HMAC signature for security

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

    // For now, log the token. In production, store this securely.
    console.log("=== SHOPIFY ACCESS TOKEN ===");
    console.log(`Shop: ${shop}`);
    console.log(`Token: ${data.access_token}`);
    console.log(`Scopes: ${data.scope}`);
    console.log("============================");
    console.log("Set SHOPIFY_ACCESS_TOKEN in your environment to this value.");

    res.send(
      `<h1>App Installed</h1>` +
      `<p>Shop: ${shop}</p>` +
      `<p>Scopes: ${data.scope}</p>` +
      `<p>Access token has been logged to the server console. Set it as SHOPIFY_ACCESS_TOKEN in your Render environment.</p>`,
    );
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth callback failed");
  }
}
