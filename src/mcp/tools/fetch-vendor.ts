/**
 * fetch_vendor_page — Fetch product data from a vendor's website.
 *
 * Supports three strategies:
 * 1. Shopify stores: /products.json API (structured, richest data)
 * 2. Server-rendered HTML: strip tags, extract text + meta tags
 * 3. JS-rendered sites (Square, etc.): returns what's available (meta tags, sitemap)
 *
 * Claude uses this to get vendor descriptions, pricing, color details,
 * collection info, and image URLs before writing product descriptions.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// HTML text extraction
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const patterns: Array<[string, RegExp]> = [
    ["title", /<title[^>]*>([^<]+)/i],
    ["og:title", /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)/i],
    ["og:description", /<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']+)/i],
    ["og:image", /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)/i],
    ["description", /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i],
  ];
  for (const [key, regex] of patterns) {
    const match = html.match(regex);
    if (match) meta[key] = match[1].trim();
  }
  return meta;
}

function extractLinks(html: string, baseUrl: string): string[] {
  const matches = html.match(/href="([^"]+)"/g) || [];
  return matches
    .map((m) => m.replace(/href="([^"]+)"/, "$1"))
    .filter((href) => href.startsWith("/") || href.startsWith(baseUrl))
    .map((href) => (href.startsWith("/") ? new URL(href, baseUrl).href : href));
}

function extractImageUrls(html: string): string[] {
  const matches = html.match(/https?:\/\/[^"'\s]+\.(?:jpeg|jpg|png|webp)(?:\?[^"'\s]*)?/gi) || [];
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------
// Shopify strategy
// ---------------------------------------------------------------------------

interface ShopifyProduct {
  title: string;
  handle: string;
  vendor: string;
  product_type: string;
  tags: string | string[];
  body_html: string;
  variants: Array<{
    title: string;
    price: string;
    compare_at_price: string | null;
    sku: string | null;
    grams: number;
    available: boolean;
    inventory_quantity?: number;
  }>;
  images: Array<{ src: string; alt: string | null }>;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/json,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

async function shopifyFetch(url: string): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: BROWSER_HEADERS,
  });
}

async function tryShopify(
  baseUrl: string,
  query?: string,
): Promise<{ type: "shopify"; products: ShopifyProduct[] } | null> {
  try {
    const testRes = await shopifyFetch(`${baseUrl}/products.json?limit=1`);
    if (!testRes.ok) return null;

    // It's a Shopify store. Fetch products.
    if (query) {
      // Search for specific products — paginate with delay to avoid rate limits
      const allProducts: ShopifyProduct[] = [];
      let page = 1;
      while (true) {
        const res = await shopifyFetch(`${baseUrl}/products.json?limit=250&page=${page}`);
        if (!res.ok) {
          console.log(`[vendor] Shopify page ${page} returned ${res.status}, stopping pagination`);
          break;
        }
        const data = (await res.json()) as { products: ShopifyProduct[] };
        if (!data.products?.length) break;
        allProducts.push(...data.products);
        if (data.products.length < 250) break;
        page++;
        // Small delay between pages to avoid rate limiting
        if (page > 1) await new Promise((r) => setTimeout(r, 500));
      }

      const queryLower = query.toLowerCase();
      const matched = allProducts.filter((p) => {
        const text = `${p.title} ${p.handle} ${Array.isArray(p.tags) ? p.tags.join(" ") : p.tags} ${p.body_html}`.toLowerCase();
        return text.includes(queryLower);
      });

      return { type: "shopify", products: matched };
    } else {
      // Just return first page
      const res = await shopifyFetch(`${baseUrl}/products.json?limit=50`);
      const data = (await res.json()) as { products: ShopifyProduct[] };
      return { type: "shopify", products: data.products || [] };
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML strategy (server-rendered sites)
// ---------------------------------------------------------------------------

async function fetchHtml(
  url: string,
): Promise<{
  type: "html";
  url: string;
  meta: Record<string, string>;
  text: string;
  links: string[];
  images: string[];
}> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: BROWSER_HEADERS,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  const html = await res.text();
  const meta = extractMeta(html);
  const text = stripHtml(html);
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
  const links = extractLinks(html, new URL(url).origin);
  const images = extractImageUrls(html);

  // Check if the page is JS-rendered (very little visible text)
  const isJsRendered = lines.length < 10 && html.length > 10000;

  return {
    type: "html",
    url: res.url,
    meta,
    text: isJsRendered
      ? `[JS-rendered page - limited content available]\n${lines.join("\n")}`
      : lines.join("\n"),
    links,
    images,
  };
}

// ---------------------------------------------------------------------------
// MCP Tool Registration
// ---------------------------------------------------------------------------

export function registerFetchVendorTool(server: McpServer): void {
  server.tool(
    "fetch_vendor_page",
    `Fetch product data from a vendor's website. Use this to get vendor descriptions,
pricing, color details, collection info, and image URLs.

Automatically detects Shopify stores and returns structured product data (title,
description, price, variants, tags, images). For non-Shopify sites, returns
extracted text content and meta tags.

Pass a URL and optionally a search query to filter products.

Examples:
- fetch_vendor_page(url: "https://www.damnailpolish.com", query: "Advent 2024")
- fetch_vendor_page(url: "https://www.chamaeleon-nails.com/en/p/blazing-evening-sky")
- fetch_vendor_page(url: "https://www.damnailpolish.com/products/horse-blue-purple-magnetic.json")`,
    {
      url: z.string().describe("Vendor website URL (homepage, collection page, or product page)"),
      query: z.string().optional().describe("Search query to filter products (Shopify stores only). Searches title, tags, and description."),
    },
    async ({ url, query }) => {
      const startTime = Date.now();

      try {
        // Normalize URL
        const parsed = new URL(url);
        const baseUrl = `${parsed.protocol}//${parsed.host}`;

        // If the URL is already a .json endpoint, fetch it directly
        if (url.includes("/products.json") || url.endsWith(".json")) {
          const directRes = await shopifyFetch(url);
          if (directRes.ok) {
            const data = (await directRes.json()) as { products?: ShopifyProduct[]; product?: ShopifyProduct };
            let products: ShopifyProduct[] = [];
            if (data.products) products = data.products;
            else if (data.product) products = [data.product];

            if (query) {
              const queryLower = query.toLowerCase();
              products = products.filter((p) => {
                const text = `${p.title} ${p.handle} ${Array.isArray(p.tags) ? p.tags.join(" ") : p.tags} ${p.body_html}`.toLowerCase();
                return text.includes(queryLower);
              });
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const mapped = products.map((p) => ({
              title: p.title,
              handle: p.handle,
              vendor: p.vendor,
              productType: p.product_type,
              tags: p.tags,
              description: stripHtml(p.body_html || ""),
              price: p.variants?.[0]?.price,
              compareAtPrice: p.variants?.[0]?.compare_at_price,
              available: p.variants?.some((v) => v.available),
              variants: p.variants?.map((v) => ({
                title: v.title,
                price: v.price,
                compareAtPrice: v.compare_at_price,
                sku: v.sku,
                grams: v.grams,
                available: v.available,
              })),
              images: p.images?.map((i) => ({ src: i.src, alt: i.alt })),
            }));
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  platform: "shopify",
                  url,
                  query: query || null,
                  totalProducts: mapped.length,
                  products: mapped.slice(0, 25),
                  ...(mapped.length > 25 ? { note: `Showing 25 of ${mapped.length} matches. Narrow your query.` } : {}),
                  fetchTimeSeconds: Number(elapsed),
                }, null, 2),
              }],
            };
          }
        }

        // Strategy 1: Try Shopify detection (baseUrl/products.json)
        const shopifyResult = await tryShopify(baseUrl, query);
        if (shopifyResult) {
          const products = shopifyResult.products.map((p) => ({
            title: p.title,
            handle: p.handle,
            vendor: p.vendor,
            productType: p.product_type,
            tags: p.tags,
            description: stripHtml(p.body_html || ""),
            price: p.variants?.[0]?.price,
            compareAtPrice: p.variants?.[0]?.compare_at_price,
            available: p.variants?.some((v) => v.available),
            variants: p.variants?.map((v) => ({
              title: v.title,
              price: v.price,
              compareAtPrice: v.compare_at_price,
              sku: v.sku,
              grams: v.grams,
              available: v.available,
            })),
            images: p.images?.map((i) => ({
              src: i.src,
              alt: i.alt,
            })),
          }));

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                platform: "shopify",
                baseUrl,
                query: query || null,
                totalProducts: products.length,
                products: products.slice(0, 25), // Cap to avoid huge responses
                ...(products.length > 25 ? { note: `Showing 25 of ${products.length} matches. Narrow your query.` } : {}),
                fetchTimeSeconds: Number(elapsed),
              }, null, 2),
            }],
          };
        }

        // Strategy 2: Fetch as HTML
        // If the URL is a specific product/collection page, fetch it directly
        // If it's a homepage, fetch it and return links for further exploration
        const htmlResult = await fetchHtml(url);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Find product-related links for Claude to follow up on
        const productLinks = htmlResult.links.filter((l) =>
          /\/p\/|\/product|\/collection|\/shop|\/catalog/i.test(l),
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              platform: "html",
              url: htmlResult.url,
              meta: htmlResult.meta,
              text: htmlResult.text.slice(0, 5000), // Cap text length
              ...(htmlResult.text.length > 5000 ? { textTruncated: true, fullLength: htmlResult.text.length } : {}),
              productLinks: [...new Set(productLinks)].slice(0, 30),
              images: htmlResult.images.slice(0, 20),
              fetchTimeSeconds: Number(elapsed),
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: String(err),
              url,
              suggestion: "If this is a JS-rendered site (Square, Wix, etc.), server-side fetching may not work. Use Claude's built-in web browsing tools instead.",
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );
}
