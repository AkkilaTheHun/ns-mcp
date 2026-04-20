import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { listFolderImages, downloadFile, getFolderMeta, type DriveFile } from "../../google/drive.js";
import { analyzeImage, type ImageAnalysis } from "../../google/vision.js";

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
}
