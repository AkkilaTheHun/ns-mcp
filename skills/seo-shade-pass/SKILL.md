---
name: NailStuff Shade Analysis + Indexing
description: When doing image analysis on NailStuff nail polish photos for ANY reason — SEO/alt text on existing storefront products, OR fresh ingestion of new brand releases where shades are unknown — every analyze_images call must be paired with shade_index add_image to populate the pgvector shade catalog. Two distinct modes apply: (Mode A) the shade is already known from product context; (Mode B) the shade is unknown and must be inferred from the image against a candidate catalog.
---

# NailStuff Shade Analysis + Indexing

This skill covers TWO related workflows. They share the same vision/index plumbing but differ in how the shade name is determined.

## Core principle (both modes)

**Every `analyze_images` call on a NailStuff nail polish photo MUST be paired
with a `shade_index add_image` call.** The vision analysis already costs money;
indexing on top is free and opportunistically builds the searchable shade
catalog needed for user-photo identification.

The difference between modes is **where the shade name comes from**.

---

## Mode A — Known shade (storefront SEO / alt text refresh)

**You're here when**: the user asks for SEO / alt text updates on existing
products, brand audits, or any work where the shade name is the product title.
You always know which shade each photo represents up front.

### Tools used
- `shopify_products` — fetch product (vendor → brand, title → shade)
- `analyze_images` — vision analysis with full known context
- `shade_index` — write to catalog
- `shopify_products` (update) — write back better alt text

### Flow per product

1. **Get product context**:
   ```
   shopify_products(action: "get", id: <gid>)
   ```
   Capture: vendor, title, handle, all image URLs + existing alt text, collection.

2. **Run analyze_images with full context**:
   ```
   analyze_images(
     provider: "claude",
     model: "claude-sonnet-4-6",
     fullWidth: 1400,
     closeup: true,
     productName: <product title>,        # exact shade name
     brand: <vendor>,
     urls: [<image URLs>]
   )
   ```
   You don't need a `vendorHint` here unless you want to pin specific catalog
   spec into the alt text. The shade name is already authoritative.

3. **For each analyzed image, do BOTH:**
   - **Index to catalog** (use product title as the shadeName — authoritative):
     ```
     shade_index(
       action: "add_image",
       brand: <vendor>,
       shadeName: <product title>,
       collection: <collection metafield>,
       shopifyProductId: <gid>,
       shopifyHandle: <handle>,
       sourcePath: <image URL>,
       swatcherHandle: <extract from existing alt text "swatched by @X" pattern>,
       analysis: { ...analyze_images output for this photo... },
       visionProvider: "claude",
       visionModel: "claude-sonnet-4-6"
     )
     ```
   - **Update Shopify alt text** if the new alt text is meaningfully better.

### Bulk path for entire brand

For a complete brand backfill, USE THE CLI INSTEAD of running this in chat:
```bash
pnpm index-brand "Cadillacquer" "Take It Easy" --shop nailstuff-ca.myshopify.com
```
The CLI bypasses chat tokens entirely. Only use the in-chat flow above when
you're working on a small handful of products or doing exploratory analysis.

---

## Mode B — Unknown shade (fresh ingestion, mystery photos)

**You're here when**: the user dumps a folder/batch of photos from a brand
release and says "figure out which shade each photo is." You DON'T know which
photo is Sweet Nothing vs Daydreaming vs Just Breathe up front. You only know
the candidate catalog (the brand's collection spec).

This was exactly the situation when Cadillacquer's "Take It Easy" collection
arrived and we had 7 candidate shades and ~140 mixed photos.

### Tools used
- `discover_folder` — scan the folder structure, get image inventory
- `analyze_images` — with the full candidate catalog as `vendorHint`
- `shade_index` — once shade is identified per photo
- `organize_images stage_all` — sort matched photos into shade-named subfolders for human review

### Flow

1. **Get the candidate catalog from the user.** Ask if not provided. The
   format that works:
   ```
   - Daydreaming: grey crelly with red/copper ULTRACHROME chameleon flakes
     (large) and pink IRIDESCENT flakes (small).
   - Don't Worry: purple crelly with pink/copper ULTRACHROME chameleon flakes
     (large) and green/gold IRIDESCENT flakes (small).
   - Fresh Sheets: pastel mint crelly with gold and purple IRIDESCENT flakes
     (small only) and a dash of black to red flakes.
   - ... etc for all candidate shades
   ```
   Critical: include particle-size annotations (LARGE / small) for each flake
   type. Sonnet uses this to disambiguate ultrachrome vs iridescent in the
   closeup crop.

2. **Discover the folder**:
   ```
   discover_folder(folderId: <Drive ID or Dropbox URL>)
   ```
   Confirms image count, swatcher subfolder structure if any.

3. **Run analyze_images with the catalog as vendorHint**:
   ```
   analyze_images(
     folderId: <same folder>,
     productName: <collection name, e.g. "Take It Easy">,
     brand: <vendor>,
     provider: "claude",
     fullWidth: 1400,
     closeup: true,
     vendorHint: |
       This is a swatcher folder for the Take It Easy collection. Each image
       depicts ONE of these N shades — identify which by matching the base
       color and flake behaviour, and use that shade name in the alt text.

       PARTICLE SIZE GUIDANCE (critical for telling shades apart):
       - "ultrachrome chameleon flakes" = LARGER flakes, individual irregular
         shards on the nail, strong color-shift from one angle to another.
       - "iridescent flakes" = SMALLER particles, finer scatter, soft pearly
         shimmer rather than discrete shards.

       Shades:
       <paste the full catalog from step 1>
   )
   ```

4. **Sonnet returns analyses where each photo's `altText` names the matched
   shade.** Example: a photo it identifies as Just Breathe will have alt text
   like "...Cadillacquer nail polish in Just Breathe, ...". Extract this:
   - Regex `nail polish in (\w[\w '-]*?),` against altText, OR
   - Read it manually and trust Sonnet's pick (especially when confidence ≥ 0.85)

5. **Flag low-confidence calls for review.** Anything with `confidence < 0.80`
   on an unknown-shade workflow should NOT be auto-indexed without spot-check.
   Ambiguous photos go in a separate review queue.

6. **Group photos by inferred shade.** Build a shadeAssignments map:
   ```
   {
     "Just Breathe": [{fileId: "/path/foo.jpg", swatcherHandle: "yyulia_m"}, ...],
     "Don't Worry": [{...}, ...],
     ...
   }
   ```

7. **Stage for human review**:
   ```
   organize_images(
     action: "stage_all",
     source: <original folderId>,
     collectionName: <collection name>,
     shadeAssignments: <map from step 6>
   )
   ```
   This creates "Take It Easy - Staging" with one subfolder per shade,
   copies of photos sorted in. User reviews in Drive/Dropbox and drags any
   misidentified photos between subfolders.

8. **After human review, create products + index**: For each shade, call
   `create_product` to make the Shopify product (which adds the photos), then
   call `shade_index add_image` per photo using the now-confirmed shade name.

   Or simpler: once products exist, fall back to **Mode A's CLI**:
   ```
   pnpm index-brand "<brand>" "<collection>" --shop nailstuff-ca.myshopify.com
   ```
   Which bulk-indexes everything from the storefront.

### Why mode B works (the catalog-as-vendorHint trick)

When you put a catalog of N candidate shades in `vendorHint` with explicit
particle-size guidance, Sonnet's behavior shifts from "describe what I see"
to "match what I see against this list." The dual-image (full + closeup)
gives it both base-color anchor (image 1) and morphology evidence (image 2),
hitting ~90% accuracy on shade matching for distinct catalogs.

This trick **only works for catalogs of perceptually-distinct shades**. If
two shades in the candidate list differ by ±5 LAB or share base color +
finish, Sonnet will sometimes flip between them. Spot-check the matches.

### Cost

For an N-shade × M-photo unknown-shade pass: M × ~$0.02 on Sonnet at
fullWidth=1400 + closeup=true. The Take It Easy ingestion (~140 photos)
ran ~$2.80.

---

## Skip indexing when

- Image is purely decorative (banners, lifestyle shots not depicting polish on nails or in bottle)
- Product isn't a single-shade item (gift sets, tools, polish remover, base coat, top coat, cuticle oil)

## What NOT to do

- Do NOT call `analyze_images` for nail polish photos without also pairing with `shade_index add_image`. The pairing is the whole point.
- Do NOT pass `cropTargetColor` for catalog indexing — it shifts base color reads on the closeup. Plain attention crop is better.
- Do NOT use Gemini Flash for indexing. Its confidence is miscalibrated (0.95+ on wrong answers) which poisons the catalog. Use Sonnet 4.6.
- Do NOT auto-index unknown-shade photos with `confidence < 0.80` — those need human spot-check first.
- Do NOT skip the catalog-as-vendorHint pattern in Mode B. Without it Sonnet has no anchor for shade names and will use the collection name (e.g., "Take It Easy") as the shade in altText, which is useless for indexing.

## Schema reference (Supabase pgvector)

Project `ygrcbmtrhjnpqpccfarf`:
- `shade_signatures` — one row per (brand, shade_name); aggregate signature
- `image_signatures` — one row per analyzed photo; per-image fields include
  imageType, lightingCondition, skinTone, nailCount, dominantColors,
  observedEffects, confidence, base_color_lab, embedding (50-dim)
- `match_feedback` — user-confirmed shade matches (training data)

The `shade_index` MCP tool wraps reads/writes. RLS is disabled (server-side-
only access via service_role key).

## The bigger picture this enables

Once the catalog has ~100+ shades indexed, a user submits a photo of their
nails or a polish bottle and the system:
1. Runs `analyze_images` on the photo (no productName/brand — unknown)
2. Calls `shade_index identify topK: 5` against the catalog
3. Returns top 5 candidates with similarity scores

The SEO/alt text work happening today (Mode A) and the new-collection
ingestion work (Mode B) are what populate that catalog. Don't skip the
indexing step in either mode.
