---
name: SEO + Shade Indexing Pass
description: When doing SEO, alt text, or image-related updates on NailStuff storefront products, every analyze_images call must be paired with shade_index add_image to opportunistically populate the pgvector shade catalog. Use this any time you're touching storefront product images for any reason — alt text refresh, brand audit, new ingestion, or description updates.
---

# SEO + Shade Indexing Pass for NailStuff Products

## Core principle (always applies)

**Every `analyze_images` call on a NailStuff storefront product MUST be
paired with a `shade_index` `add_image` call for each analyzed photo.**

The vision analysis already costs money (~1¢ per photo on Sonnet).
Indexing on top is free and opportunistically builds the searchable
shade catalog needed for the future user-photo identification feature.

## When to use

Activate this workflow whenever the user asks for any of:

- SEO updates / improvements on NailStuff products
- Alt text generation, regeneration, or fixing
- Image analysis on storefront products (existing or new)
- Bulk product description updates that involve looking at images
- Brand-wide audits of product image quality, alt text, or shade information
- Mentions of "while you're at it, also..." in the context of product images
- New brand ingestion (the same pairing rule applies to fresh products)

## Skip indexing when

- Image is purely decorative (banner, lifestyle, background)
- Product isn't a single-shade item (gift sets, tools, polish remover,
  base coat, top coat, cuticle oil, etc.)

## Tools used

- `shopify_products` — fetch product details (vendor, title, images, GID, handle)
- `analyze_images` — vision analysis; use Sonnet (`provider: "claude"`) for indexing
- `shade_index` — write to pgvector catalog (Supabase project `ygrcbmtrhjnpqpccfarf`)
- `shopify_products` (update action) — write back the new alt text

## Standard workflow (per product)

1. **Pull product context** via `shopify_products(action: "get", id: <gid>)`
   or `shopify_products(action: "search", query: "vendor:Cadillacquer title:Just Breathe")`.

   Capture:
   - `vendor` → use as `brand`
   - `title` → use as `shadeName`
   - `productId` (GID) → for indexing + alt text update
   - `handle` → for indexing
   - `images` array → list of image URLs and their existing alt text
   - `collection`(s) it belongs to (optional but useful)

2. **Run vision analysis** on the product's images:

   ```
   analyze_images(
     provider: "claude",
     model: "claude-sonnet-4-6",       # default; calibrated confidence
     fullWidth: 1400,
     closeup: true,                     # 1400px full + attention crop
     productName: <shade title>,
     brand: <vendor>,
     urls: [<image URLs>]
     # OR folderId: <Drive/Dropbox folder URL> for fresh ingestion
   )
   ```

3. **For each analyzed image, do BOTH:**

   **a) Index to catalog:**
   ```
   shade_index(
     action: "add_image",
     brand: <vendor>,
     shadeName: <product title>,
     collection: <collection title>,
     shopifyProductId: <gid>,
     shopifyHandle: <handle>,
     sourcePath: <image URL or shopify file URL>,
     swatcherHandle: <if filename contains _swatcher-X pattern, X; else omit>,
     analysis: {
       dominantColors: <from analyze_images>,
       observedEffects: <from analyze_images>,
       altText: <from analyze_images>,
       confidence: <from analyze_images>,
       imageType: <from analyze_images>
     },
     visionProvider: "claude",
     visionModel: "claude-sonnet-4-6"
   )
   ```

   **b) Update Shopify alt text** if the new alt text is meaningfully better
   than the existing one. Use the `analyze_images` `altText` field, or
   refine it for SEO (include brand + shade + finish + key visual details).

4. **At the end of the brand's products**, optionally call
   `shade_index(action: "list_shades", brand: <vendor>)` to confirm all
   shades have meaningful `photo_count` values and the aggregates look right.

## Confidence handling

- Sonnet returns confidence 0.62–0.88 in practice. Calibrated.
- If confidence < 0.75: flag the product/photo for human review at the end
  of the pass. Do NOT skip indexing — index anyway, but note the
  uncertainty so the user can spot-check.
- Macro shots tend to be harder; lower confidence on those is expected.

## Brand rollout flow (full pass on a new brand)

1. List all products: `shopify_products(action: "search", query: "vendor:<brand>")`
2. For each product, run the per-product workflow above.
3. Index each product's images to the shade catalog.
4. Update alt text where improvements are warranted.
5. At the end, summarize: products processed, photos indexed, shades
   created vs. updated, low-confidence flags.

## What NOT to do

- Do NOT call `analyze_images` without also calling `shade_index add_image`
  for storefront products. The pairing is the point.
- Do NOT pass `cropTargetColor` for catalog indexing — it shifts the base
  color reading on the closeup and degrades accuracy on shades close to
  catalog neighbors. Plain attention crop is better.
- Do NOT use Gemini (Flash or Pro) for indexing. Its confidence is
  miscalibrated (0.95+ on wrong answers) which poisons the catalog. Use
  Sonnet 4.6.
- Do NOT index gift sets, tools, polish remover, or other non-single-shade
  products.

## Schema reference (Supabase pgvector)

Tables in project `ygrcbmtrhjnpqpccfarf` (database: NailStuff Shipping):

- `shade_signatures` — one row per (brand, shade_name); aggregate signature
- `image_signatures` — one row per analyzed photo, linked to shade
- `match_feedback` — user-confirmed shade matches (training data)

The `shade_index` MCP tool wraps all reads/writes to these tables. RLS is
disabled (server-side-only access via service_role key).

## The bigger picture

Once the catalog has ~100+ shades indexed:

1. User uploads a photo of their nails or a polish bottle to nailstuff.ca
2. Frontend calls a new endpoint that:
   - Runs `analyze_images` on the photo
   - Calls `shade_index(action: "identify", topK: 5)` against the catalog
   - Returns the top 5 candidates with similarity scores
3. User confirms which match is correct (or "none of these")
4. `shade_index(action: "feedback")` records the result for ongoing improvement

The SEO/alt text work happening today is what makes this future feature
possible. Every photo indexed during routine work brings the user-facing
identification feature closer to viable. Don't skip the indexing step.
