import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { listFolderImages, downloadFile, getFolderMeta, discoverProductImages, listSubfolders, type DriveFile } from "../../google/drive.js";
import { analyzeImage, type ImageAnalysis } from "../../google/vision.js";
import { getCurrentSessionId } from "../../context.js";
import { getSessionShop } from "../../session.js";
import { config } from "../../config.js";
import {
  lookupNextSku,
  checkDuplicates,
  getConfigReference,
  getStyleReference,
  findBrandMetaobject,
  listMetaobjectEntries,
  TAXONOMY_MAP,
} from "../../shopify/preflight.js";

const HEIC_MIMETYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);

/** Lazy-load heic-convert only when needed. */
let _heicConvert: ((opts: { buffer: Buffer; format: string; quality: number }) => Promise<ArrayBuffer>) | undefined;
async function convertHeic(buffer: Buffer): Promise<Buffer> {
  if (!_heicConvert) {
    // @ts-expect-error — heic-convert has no type declarations
    const mod = await import("heic-convert");
    _heicConvert = mod.default ?? mod;
  }
  const result = await _heicConvert!({ buffer, format: "JPEG", quality: 0.9 });
  return Buffer.from(result);
}

interface AnalyzedImage {
  fileId: string;
  filename: string;
  parentFolderId: string;
  originalSizeBytes: number;
  analysis: ImageAnalysis;
  proposedFilename: string;
}

/** Generate an SEO-friendly filename from brand, product, image type, and position. */
function toSeoFilename(brand: string, productName: string, imageType: string, position: number): string {
  const kebab = (s: string) =>
    s.toLowerCase()
      .replace(/['']/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const typeSuffix: Record<string, string> = {
    bottle_in_hand: "bottle",
    bottle_standalone: "bottle",
    swatch_on_nails: "swatch",
    swatch_wheel: "swatch-wheel",
    swatch_stick: "swatch-stick",
    lifestyle: "lifestyle",
    layering_demo: "layering",
    group_shot: "collection",
    macro_detail: "macro",
    unknown: "photo",
  };

  const suffix = typeSuffix[imageType] ?? "photo";
  return `${kebab(brand)}-${kebab(productName)}-${suffix}-${position}.jpg`;
}

/** Process images with concurrency limit. */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Download, compress, analyze a single image. */
async function processImage(
  file: DriveFile,
  context: { productName: string; brand: string; vendorHint?: string },
): Promise<{ result?: Omit<AnalyzedImage, "proposedFilename">; error?: { fileId: string; filename: string; error: string } }> {
  try {
    let raw = await downloadFile(file.id);
    const rawSizeKB = Math.round(raw.length / 1024);
    console.log(`[analyze] Downloaded ${file.name} (${rawSizeKB} KB, ${file.mimeType})`);

    // Convert HEIC/HEIF to JPEG before Sharp
    const isHeic = HEIC_MIMETYPES.has(file.mimeType) || /\.heic$/i.test(file.name);
    if (isHeic) {
      console.log(`[analyze] Converting HEIC → JPEG: ${file.name}`);
      raw = await convertHeic(raw);
      console.log(`[analyze] HEIC converted: ${rawSizeKB} KB → ${Math.round(raw.length / 1024)} KB`);
    }

    // Resize to 900px JPEG for Gemini analysis
    const analysisBuffer = await sharp(raw, { failOn: "none" })
      .rotate()
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();

    console.log(`[analyze] Compressed ${file.name}: ${rawSizeKB} KB → ${Math.round(analysisBuffer.length / 1024)} KB`);

    const analysis = await analyzeImage(
      analysisBuffer.toString("base64"),
      "image/jpeg",
      context,
    );

    console.log(`[analyze] Vision done ${file.name}: ${analysis.imageType} (confidence: ${analysis.confidence})`);

    return {
      result: {
        fileId: file.id,
        filename: file.name,
        parentFolderId: file.parentId,
        originalSizeBytes: file.size,
        analysis,
      },
    };
  } catch (err) {
    console.error(`[analyze] FAILED ${file.name}: ${err}`);
    return {
      error: { fileId: file.id, filename: file.name, error: String(err) },
    };
  }
}

export function registerIngestTools(server: McpServer): void {
  server.tool(
    "analyze_images",
    `Analyze product images from a Google Drive folder. Downloads all images,
compresses them, and runs AI vision analysis (image type, colors, effects,
skin tone, lighting, alt text). Returns structured analysis data as JSON.

Use this before writing product descriptions or building previews. The analysis
identifies bottle shots vs swatches, extracts dominant colors and polish effects,
notes skin tone for accessibility, and drafts alt text in NailStuff's format.

Images are bound to the folder ID — only files whose parent matches the given
folder are processed (prevents cross-product image mixups).`,
    {
      folderId: z.string().describe("Google Drive folder ID containing this product's images"),
      productName: z.string().describe("Product/shade name (e.g. 'Lavender Sunset')"),
      brand: z.string().describe("Brand name (e.g. 'Cadillacquer')"),
      vendorHint: z.string().optional().describe("Vendor's color/effect description to improve analysis accuracy"),
      maxImages: z.number().optional().default(50).describe("Max images to successfully analyze (default 50). Errors don't count against this cap."),
    },
    async ({ folderId, productName, brand, vendorHint, maxImages }) => {
      // Get folder metadata
      let folderName: string;
      try {
        const meta = await getFolderMeta(folderId);
        folderName = meta.name;
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error accessing folder ${folderId}: ${err}` }],
          isError: true,
        };
      }

      // List images in folder
      const allFiles = await listFolderImages(folderId);
      if (allFiles.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No images found in folder "${folderName}" (${folderId})` }],
          isError: true,
        };
      }

      console.log(`[analyze] Starting: ${allFiles.length} images in "${folderName}" for ${brand} - ${productName}`);
      const startTime = Date.now();

      const cap = maxImages ?? 50;
      const context = { productName, brand, vendorHint };

      const concurrency = Number(process.env.IMAGE_CONCURRENCY ?? "8");
      const processed = await mapConcurrent(allFiles, concurrency, async (file, i) => {
        console.log(`[analyze] Processing ${i + 1}/${allFiles.length}: ${file.name}`);
        return processImage(file, context);
      });

      const results: AnalyzedImage[] = [];
      const errors: Array<{ fileId: string; filename: string; error: string }> = [];
      const lowConfidence: Array<{ fileId: string; filename: string; confidence: number; reason: string }> = [];
      let skippedAfterCap = 0;

      let position = 0;
      for (const p of processed) {
        if (p.result) {
          if (results.length < cap) {
            position++;
            const proposedFilename = toSeoFilename(brand, productName, p.result.analysis.imageType, position);
            results.push({ ...p.result, proposedFilename });
            if (p.result.analysis.confidence < 0.75) {
              lowConfidence.push({
                fileId: p.result.fileId,
                filename: p.result.filename,
                confidence: p.result.analysis.confidence,
                reason: p.result.analysis.imageType === "unknown"
                  ? "Could not classify image type"
                  : `Low confidence on ${p.result.analysis.imageType} classification`,
              });
            }
          } else {
            skippedAfterCap++;
          }
        }
        if (p.error) {
          errors.push(p.error);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[analyze] Complete: ${results.length} analyzed, ${errors.length} errors, ${elapsed}s elapsed`);

      const summary = {
        folderId,
        folderName,
        productName,
        brand,
        totalImagesFound: allFiles.length,
        totalAnalyzed: results.length,
        processingTimeSeconds: Number(elapsed),
        images: results.map((r) => ({
          fileId: r.fileId,
          filename: r.filename,
          proposedFilename: r.proposedFilename,
          parentFolderId: r.parentFolderId,
          originalSizeKB: Math.round(r.originalSizeBytes / 1024),
          imageType: r.analysis.imageType,
          lightingCondition: r.analysis.lightingCondition,
          nailCount: r.analysis.nailCount,
          skinTone: r.analysis.skinTone,
          dominantColors: r.analysis.dominantColors,
          observedEffects: r.analysis.observedEffects,
          altText: r.analysis.altText,
          confidence: r.analysis.confidence,
        })),
        ...(skippedAfterCap > 0 ? { skippedAfterCap } : {}),
        ...(lowConfidence.length > 0 ? { lowConfidence } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
  );

  // ===========================================================================
  // ingest_product — parallel image analysis + Shopify preflight
  // ===========================================================================

  server.tool(
    "ingest_product",
    `Full product ingestion preflight. Runs image analysis AND Shopify lookups
in parallel server-side, returning everything needed to write descriptions,
build SEO, and present a preview. One call replaces ~15 individual tool calls.

HANDLES COLLECTION FOLDERS: If folderId points to a collection folder with
swatcher subfolders (e.g., Yuliia/, Trusha/, Suzie/), the tool automatically
traverses all subfolders and finds images matching the product title by filename
(e.g., "Blazing Evening Sky_1.jpg"). You do NOT need to reorganize the folder
or create per-product folders. Just pass the collection folder ID + the product
title and the tool finds the right images across all subfolders.

Returns: image analysis (only for matching images), next SKU, duplicate check,
config + style references, brand metaobject, available colors/finishes/polish-types,
pricing, taxonomy, folder structure type (flat vs collection).

After receiving the result, write descriptions + SEO, present preview to user
for approval, then call create_product to execute.`,
    {
      folderId: z.string().describe("Google Drive folder ID containing product images"),
      vendor: z.string().describe("Brand/vendor name (e.g. 'Cadillacquer')"),
      title: z.string().describe("Product/shade name (e.g. 'Lavender Sunset')"),
      stockType: z.enum(["preorder", "in-stock"]).describe("Preorder or in-stock — determines template and required metafields"),
      preorderDates: z.object({
        startDate: z.string().describe("ISO date for preorder start (e.g. '2026-04-28')"),
        endDate: z.string().describe("ISO date for last intended preorder day"),
        shipDate: z.string().optional().describe("ISO date for expected ship date"),
      }).optional().describe("Required when stockType is 'preorder'"),
      priceOverride: z.string().optional().describe("Override brand default pricing (e.g. '18.00')"),
      vendorHint: z.string().optional().describe("Vendor's color/effect description to improve analysis accuracy"),
      maxImages: z.number().optional().default(50).describe("Max images to analyze (default 50)"),
    },
    async ({ folderId, vendor, title, stockType, preorderDates, priceOverride, vendorHint, maxImages }, extra) => {
      const startTime = Date.now();
      const warnings: string[] = [];
      const progress: string[] = [];

      // Progress helper — sends MCP notification if client supports it, always logs
      const progressToken = extra?._meta?.progressToken;
      let progressStep = 0;
      const totalSteps = 10; // approximate
      async function reportProgress(message: string) {
        progressStep++;
        progress.push(message);
        console.log(`[ingest] ${message}`);
        if (progressToken && extra?.sendNotification) {
          try {
            await extra.sendNotification({
              method: "notifications/progress" as const,
              params: { progressToken, progress: progressStep, total: totalSteps, message },
            });
          } catch { /* client may not support progress */ }
        }
      }

      // Validate preorder dates
      if (stockType === "preorder" && !preorderDates) {
        return {
          content: [{ type: "text" as const, text: "stockType is 'preorder' but preorderDates not provided. Include startDate and endDate." }],
          isError: true,
        };
      }

      // Get folder metadata first (fast, needed for logging)
      let folderName: string;
      try {
        const meta = await getFolderMeta(folderId);
        folderName = meta.name;
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error accessing folder ${folderId}: ${err}` }],
          isError: true,
        };
      }

      await reportProgress(`Starting preflight: "${title}" by ${vendor} (${stockType})`);

      // Resolve shop domain for Shopify queries.
      // NEVER silently fall back to a dev store — error if ambiguous.
      let shop: string | undefined;
      const sessionId = getCurrentSessionId();
      if (sessionId) shop = getSessionShop(sessionId);
      if (!shop) {
        const shopDomains = [...config.shops.keys()];
        if (shopDomains.length === 1) {
          shop = shopDomains[0];
        } else if (shopDomains.length > 1) {
          // Multiple shops: pick the non-dev one if there's exactly one
          const prodShops = shopDomains.filter((d) => !d.includes("-dev"));
          if (prodShops.length === 1) {
            shop = prodShops[0];
          } else {
            const available = shopDomains.join(", ");
            return {
              content: [{ type: "text" as const, text: `Multiple shops available (${available}). Use shopify_shop(action: 'select') to choose one first.` }],
              isError: true,
            };
          }
        }
      }
      if (!shop) {
        return {
          content: [{ type: "text" as const, text: "No shop configured. Check SHOPS environment variable." }],
          isError: true,
        };
      }

      // ---------------------------------------------------------------
      // Discover images — handles flat folders and collection structures
      // ---------------------------------------------------------------
      await reportProgress(`Scanning folder "${folderName}" for images...`);

      let productFiles: DriveFile[] = [];
      let folderStructure = "flat";

      // Check for subfolders first
      const subfolders = await listSubfolders(folderId);

      if (subfolders.length === 0) {
        // Flat folder — all images are direct children (single product)
        productFiles = await listFolderImages(folderId);
        folderStructure = "flat";
        await reportProgress(`Flat folder: found ${productFiles.length} images`);
      } else {
        // Has subfolders — collection structure. Traverse and find images for this product.
        folderStructure = "collection";
        await reportProgress(`Collection folder: ${subfolders.length} subfolder(s) found. Searching for "${title}" images...`);

        const titleLower = title.toLowerCase().trim();
        const discoveredProducts = new Set<string>(); // Track all product names found

        for (const sub of subfolders) {
          // Check if subfolder has its own subfolders (per-product folders like Suzie/Blazing Evening Sky/)
          const subSubs = await listSubfolders(sub.id);

          if (subSubs.length > 0) {
            // Record all product folder names for discovery
            for (const ss of subSubs) discoveredProducts.add(ss.name.trim());

            // Look for a subfolder matching the product title
            const match = subSubs.find((ss) =>
              ss.name.toLowerCase().trim() === titleLower ||
              ss.name.toLowerCase().trim().includes(titleLower) ||
              titleLower.includes(ss.name.toLowerCase().trim()),
            );
            if (match) {
              const imgs = await listFolderImages(match.id);
              productFiles.push(...imgs);
            }
          } else {
            // Flat swatcher folder — match by filename prefix
            const imgs = await listFolderImages(sub.id);
            for (const img of imgs) {
              const base = img.name.replace(/\.[^.]+$/, "")
                .replace(/[\s_-]+\d+\s*$/, "")
                .trim();

              // Record product name for discovery
              if (base && !/^(IMG|DSC|DSCN|DSCF|P\d|Screenshot|Photo)/i.test(base)) {
                discoveredProducts.add(base);
              }

              if (base.toLowerCase() === titleLower ||
                  base.toLowerCase().includes(titleLower) ||
                  titleLower.includes(base.toLowerCase())) {
                productFiles.push(img);
              }
            }
          }
        }

        // If no product-specific images found, return discovery info instead of fallback
        if (productFiles.length === 0) {
          if (discoveredProducts.size > 0) {
            const productList = [...discoveredProducts].sort();
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: "collection_folder",
                  message: `"${title}" doesn't match any product in this folder. This appears to be a collection folder containing ${productList.length} product(s).`,
                  discoveredProducts: productList,
                  folderName,
                  instruction: `Call ingest_product once per product using the exact names above. Use the same folderId — the tool will find each product's images across the swatcher subfolders.`,
                }, null, 2),
              }],
              isError: true,
            };
          }

          // Truly empty — no products found anywhere
          return {
            content: [{ type: "text" as const, text: `No images found for "${title}" in folder "${folderName}" (${folderId}). Checked ${subfolders.length} subfolder(s).` }],
            isError: true,
          };
        }

        await reportProgress(`Found ${productFiles.length} images for "${title}" across ${subfolders.length} subfolder(s)`);
      }

      if (productFiles.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No images found for "${title}" in folder "${folderName}" (${folderId}). Checked ${subfolders.length} subfolder(s).` }],
          isError: true,
        };
      }

      // ---------------------------------------------------------------
      // Run image analysis + Shopify preflight in parallel
      // ---------------------------------------------------------------
      await reportProgress(`Analyzing ${productFiles.length} images + running Shopify preflight...`);

      const [
        imageResult,
        skuResult,
        dedupResult,
        configRefResult,
        styleRefResult,
        brandResult,
        colorsResult,
        finishesResult,
        polishTypesResult,
      ] = await Promise.allSettled([
        // 1. Image analysis
        (async () => {
          const cap = maxImages ?? 50;
          const context = { productName: title, brand: vendor, vendorHint };
          const concurrency = Number(process.env.IMAGE_CONCURRENCY ?? "8");

          const processed = await mapConcurrent(productFiles, concurrency, async (file, i) => {
            console.log(`[ingest] Image ${i + 1}/${productFiles.length}: ${file.name}`);
            return processImage(file, context);
          });

          await reportProgress(`Image analysis complete: ${processed.filter((p) => p.result).length} succeeded`);

          const images: AnalyzedImage[] = [];
          const errors: Array<{ fileId: string; filename: string; error: string }> = [];
          const lowConfidence: Array<{ fileId: string; filename: string; confidence: number; reason: string }> = [];
          let position = 0;

          for (const p of processed) {
            if (p.result) {
              if (images.length < cap) {
                position++;
                const proposedFilename = toSeoFilename(vendor, title, p.result.analysis.imageType, position);
                images.push({ ...p.result, proposedFilename });
                if (p.result.analysis.confidence < 0.75) {
                  lowConfidence.push({
                    fileId: p.result.fileId,
                    filename: p.result.filename,
                    confidence: p.result.analysis.confidence,
                    reason: p.result.analysis.imageType === "unknown"
                      ? "Could not classify image type"
                      : `Low confidence on ${p.result.analysis.imageType} classification`,
                  });
                }
              }
            }
            if (p.error) errors.push(p.error);
          }

          return { images, errors, lowConfidence };
        })(),

        // 2. SKU lookup
        lookupNextSku(vendor, shop),

        // 3. Dedup sweep
        checkDuplicates(title, vendor, shop),

        // 4. Config reference
        getConfigReference(vendor, stockType, shop),

        // 5. Style reference
        getStyleReference(5, shop),

        // 6. Brand metaobject
        findBrandMetaobject(vendor, shop),

        // 7. Color metaobjects
        listMetaobjectEntries("color", shop),

        // 8. Finish metaobjects
        listMetaobjectEntries("cosmetic-finish", shop),

        // 9. Polish type metaobjects
        listMetaobjectEntries("nailstuff-polish-type", shop),
      ]);

      // ---------------------------------------------------------------
      // Unwrap results, collecting warnings for failures
      // ---------------------------------------------------------------
      function unwrap<T>(result: PromiseSettledResult<T>, label: string, fallback: T): T {
        if (result.status === "fulfilled") return result.value;
        warnings.push(`${label} failed: ${result.reason}`);
        console.error(`[ingest] ${label} failed:`, result.reason);
        return fallback;
      }

      const imageData = unwrap(imageResult, "Image analysis", { images: [], errors: [], lowConfidence: [] });
      const sku = unwrap(skuResult, "SKU lookup", { prefix: "???", currentMax: null, next: "NP-???-001" });
      const duplicates = unwrap(dedupResult, "Dedup check", { exact: [], fuzzy: [], catalogWide: [] });
      const configReference = unwrap(configRefResult, "Config reference", null);
      const styleReference = unwrap(styleRefResult, "Style reference", []);
      const brand = unwrap(brandResult, "Brand metaobject", null);
      const colors = unwrap(colorsResult, "Color metaobjects", []);
      const finishes = unwrap(finishesResult, "Finish metaobjects", []);
      const polishTypes = unwrap(polishTypesResult, "Polish type metaobjects", []);

      // Derive pricing from config reference or override
      let pricing: { price: string; compareAtPrice: string | null } | null = null;
      if (priceOverride) {
        pricing = { price: priceOverride, compareAtPrice: null };
      } else if (configReference?.variants?.[0]) {
        const v = configReference.variants[0];
        pricing = { price: v.price, compareAtPrice: v.compareAtPrice };
      }

      // Brand warning
      if (!brand) {
        warnings.push(`Brand metaobject not found for vendor "${vendor}". Check that a brand metaobject exists with a matching display name.`);
      }

      // Image warnings
      if (imageData.images.length === 0) {
        warnings.push("No images were successfully analyzed. Check folder contents.");
      }
      if (imageData.lowConfidence.length > 0) {
        warnings.push(`${imageData.lowConfidence.length} image(s) have low confidence — review recommended.`);
      }

      // Taxonomy (default to nail polish)
      const taxonomy = TAXONOMY_MAP["nail_polish"];

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      await reportProgress(`Preflight complete: ${imageData.images.length} images analyzed in ${elapsed}s`);

      const result = {
        folderId,
        folderName,
        folderStructure,
        title,
        vendor,
        stockType,
        ...(preorderDates ? { preorderDates } : {}),

        images: imageData.images.map((img) => ({
          fileId: img.fileId,
          filename: img.filename,
          proposedFilename: img.proposedFilename,
          parentFolderId: img.parentFolderId,
          originalSizeKB: Math.round(img.originalSizeBytes / 1024),
          imageType: img.analysis.imageType,
          lightingCondition: img.analysis.lightingCondition,
          nailCount: img.analysis.nailCount,
          skinTone: img.analysis.skinTone,
          dominantColors: img.analysis.dominantColors,
          observedEffects: img.analysis.observedEffects,
          altText: img.analysis.altText,
          confidence: img.analysis.confidence,
        })),
        ...(imageData.errors.length > 0 ? { imageErrors: imageData.errors } : {}),
        ...(imageData.lowConfidence.length > 0 ? { lowConfidenceImages: imageData.lowConfidence } : {}),

        sku,
        duplicates,
        configReference,
        styleReference,
        brand,

        availableMetaobjects: {
          colors,
          finishes,
          polishTypes,
        },

        pricing,
        taxonomy,
        processingTimeSeconds: Number(elapsed),
        progress,
        warnings,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
