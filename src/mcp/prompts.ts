import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  // --- Store Audit ---
  server.prompt(
    "store_audit",
    "Run a comprehensive audit of the store — products, SEO, inventory, collections, and navigation.",
    {},
    async () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Run a full store audit. Check each area and report issues:

1. **Products**: Use shopify_products(action: "list") to get all products. For each, check:
   - Missing descriptions or images
   - Products stuck in DRAFT status that should be ACTIVE
   - Missing SEO title or meta description (use shopify_products(action: "get") for details)
   - Products with zero inventory

2. **Collections**: Use shopify_collections(action: "list") to review:
   - Empty collections (0 products)
   - Collections missing descriptions or images
   - Smart collection rules that might be too broad or narrow

3. **Navigation**: Use shopify_navigation(action: "list_menus") to check:
   - Menu items pointing to empty or missing collections
   - Main menu structure and completeness

4. **Inventory**: Use shopify_inventory(action: "list_locations") and check stock levels for key products

5. **SEO**: Flag products and collections missing SEO metadata

Provide a summary report with:
- Critical issues (broken links, empty collections in nav, out of stock best sellers)
- Warnings (missing SEO, draft products)
- Suggestions (collection improvements, navigation optimization)`,
        },
      }],
    }),
  );

  // --- Product Launch ---
  server.prompt(
    "product_launch",
    "Step-by-step workflow for launching a new product — create, set up variants, add to collections, and optimize SEO.",
    {
      productName: z.string().describe("Name of the product to launch"),
      productType: z.string().optional().describe("Product type (e.g. Gel Polish, Nail Art, Tools)"),
    },
    async ({ productName, productType }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Launch a new product: "${productName}"${productType ? ` (type: ${productType})` : ""}.

Follow this workflow:

1. **Create the product** using shopify_products(action: "create"):
   - Title: "${productName}"
   - Status: DRAFT (we'll activate after everything is set up)
   - Product type: ${productType ?? "ask me"}
   - Write a compelling description with HTML formatting
   - Generate SEO title (under 60 chars) and meta description (under 160 chars)
   - Add relevant tags for discoverability

2. **Set up variants** if applicable using shopify_variants(action: "create"):
   - Ask me about sizes, colors, or other options
   - Set pricing for each variant
   - Include SKUs via inventoryItem

3. **Add to collections** using shopify_collections:
   - Check existing collections and suggest which ones this product fits
   - Ask me before adding

4. **Set metafields** for any custom data (ingredients, cure time, etc.) using shopify_metafields(action: "set")

5. **Review** — show me a summary of everything set up, then ask if I want to activate it

Don't proceed to the next step without confirming with me.`,
        },
      }],
    }),
  );

  // --- SEO Optimizer ---
  server.prompt(
    "seo_optimizer",
    "Analyze and optimize SEO across all products and collections — titles, descriptions, handles.",
    {},
    async () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Analyze SEO across the store and suggest improvements.

1. **Fetch all products** using shopify_products(action: "list", first: 250)
2. **Fetch all collections** using shopify_collections(action: "list", first: 250)

For each product, check:
- SEO title exists and is under 60 characters
- SEO description exists and is under 160 characters
- Handle is clean and keyword-rich (not auto-generated gibberish)
- Product description exists and is substantial

For each collection:
- SEO title and description exist
- Handle is clean

Create a table showing:
| Resource | Type | Issue | Current Value | Suggested Fix |

Then ask me which fixes to apply. Use shopify_products(action: "update") or shopify_collections(action: "update") to apply approved changes.

Focus on nail industry keywords — gel polish, nail art, nail care, manicure, etc.`,
        },
      }],
    }),
  );

  // --- Inventory Check ---
  server.prompt(
    "inventory_check",
    "Check stock levels across all products and locations. Flag low stock and out-of-stock items.",
    {
      lowStockThreshold: z.number().optional().describe("Threshold for low stock warning (default: 5)"),
    },
    async ({ lowStockThreshold }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Run an inventory check across the store.

1. **Get all locations** using shopify_inventory(action: "list_locations")
2. **Get all active products** using shopify_products(action: "list", query: "status:active", first: 250)
3. For products with low totalInventory, get detailed variant-level inventory

Report:
- **Out of Stock** (0 or negative inventory) — these need immediate attention
- **Low Stock** (under ${lowStockThreshold ?? 5} units) — reorder soon
- **Healthy Stock** — summary count

Format as a clear table:
| Product | Variant | SKU | Location | Available | Status |

Highlight any products that are ACTIVE but completely out of stock — these are visible to customers but can't be purchased.`,
        },
      }],
    }),
  );

  // --- Collection Organizer ---
  server.prompt(
    "collection_organizer",
    "Review and optimize collection structure — suggest new collections, clean up empty ones, improve smart collection rules.",
    {},
    async () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Review the store's collection structure and suggest improvements.

1. **List all collections** using shopify_collections(action: "list", first: 250)
2. **Get details** on each collection including product count and rules
3. **List all products** to understand the full catalog

Analyze:
- **Empty collections** — should they be deleted or populated?
- **Product coverage** — are there products not in any collection?
- **Smart collection rules** — are they effective? Could they be improved?
- **Missing collections** — based on product types, tags, and vendors, suggest new collections
- **Navigation alignment** — check if collections in the nav menu are the right ones

For a nail stuff store, consider collections like:
- By type: Gel Polish, Nail Art, Tools & Accessories, Nail Care
- By style: Glitter, Shimmer, Matte, Chrome
- By occasion: Spring Collection, Summer Vibes, Holiday
- By feature: New Arrivals, Best Sellers, On Sale

Present your recommendations and ask before making changes.`,
        },
      }],
    }),
  );

  // --- Customer Segments ---
  server.prompt(
    "customer_insights",
    "Analyze customer base — spending patterns, segments, tag opportunities.",
    {},
    async () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Analyze the customer base and provide insights.

1. **Get customer count** using shopify_customers(action: "count")
2. **List top customers** using shopify_customers(action: "list", sortKey: "ORDERS_COUNT", reverse: true, first: 20)
3. **Check customer tags** — what tags are in use?
4. **Segment analysis**:
   - Customers with orders vs no orders
   - High-value customers (top spenders)
   - Recent vs dormant customers
   - Email marketing subscribers vs non-subscribers

Suggest:
- Customer tags to add for better segmentation (e.g. "vip", "wholesale", "repeat-buyer")
- Which customers might benefit from targeted outreach
- Any data quality issues (missing emails, unverified accounts)

Present findings and ask before applying any tag changes.`,
        },
      }],
    }),
  );

  // --- Bulk Price Update ---
  server.prompt(
    "bulk_price_update",
    "Update prices across products — percentage increase/decrease or set new prices.",
    {
      scope: z.string().optional().describe("What to update: 'all', a collection handle, a vendor name, or a tag"),
      adjustment: z.string().optional().describe("e.g. '+10%', '-5%', 'set 19.99'"),
    },
    async ({ scope, adjustment }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Help me update prices across products.

Scope: ${scope ?? "Ask me which products to update (all, by collection, vendor, or tag)"}
Adjustment: ${adjustment ?? "Ask me how to adjust (percentage increase/decrease or fixed price)"}

Workflow:
1. Find the matching products using shopify_products(action: "search" or "list")
2. For each product, get its variants using shopify_products(action: "get")
3. Calculate new prices
4. Show me a preview table BEFORE making changes:
   | Product | Variant | Current Price | New Price | Change |
5. Ask for confirmation
6. Apply changes using shopify_variants(action: "update") — update in batches per product

Important:
- If setting compareAtPrice, it must be higher than the new price
- Round prices to 2 decimal places
- Never set a price to $0 unless explicitly asked`,
        },
      }],
    }),
  );
}
