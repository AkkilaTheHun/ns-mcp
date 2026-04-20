import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { listFolderImages, downloadFile, getFolderMeta, type DriveFile } from "../../google/drive.js";
import { analyzeImage, type ImageAnalysis } from "../../google/vision.js";

interface AnalyzedImage {
  fileId: string;
  filename: string;
  parentFolderId: string;
  originalSizeBytes: number;
  analysis: ImageAnalysis;
  thumbnailBase64: string;
}

/** Process images with concurrency limit. */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Convert raw image bytes to a baseline JPEG buffer. Handles HEIC, PNG, WebP, AVIF, etc. */
async function toJpegBuffer(raw: Buffer): Promise<Buffer> {
  // Sharp auto-detects format including HEIC/HEIF.
  // Convert to a full-size JPEG first, then derive smaller sizes from that.
  // This avoids decoding HEIC twice and works around platforms where
  // HEIC decoding is flaky but JPEG is always solid.
  return sharp(raw, { failOn: "none" })
    .rotate() // auto-orient from EXIF
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

/** Download, compress, analyze a single image. */
async function processImage(
  file: DriveFile,
  context: { productName: string; brand: string; vendorHint?: string },
  thumbnailWidth: number,
  jpegQuality: number,
): Promise<{ result?: AnalyzedImage; error?: { fileId: string; filename: string; error: string } }> {
  try {
    // Download from Drive
    const raw = await downloadFile(file.id);

    // Convert to JPEG once (handles HEIC, PNG, WebP, AVIF, etc.)
    const jpegFull = await toJpegBuffer(raw);

    // Derive analysis-size and thumbnail from the JPEG (no re-decoding of HEIC)
    const analysisBuffer = await sharp(jpegFull)
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();

    const thumbBuffer = await sharp(jpegFull)
      .resize({ width: thumbnailWidth, withoutEnlargement: true })
      .jpeg({ quality: jpegQuality, mozjpeg: true })
      .toBuffer();

    // Send to Gemini for analysis
    const analysis = await analyzeImage(
      analysisBuffer.toString("base64"),
      "image/jpeg",
      context,
    );

    return {
      result: {
        fileId: file.id,
        filename: file.name,
        parentFolderId: file.parentId,
        originalSizeBytes: file.size,
        analysis,
        thumbnailBase64: thumbBuffer.toString("base64"),
      },
    };
  } catch (err) {
    return {
      error: { fileId: file.id, filename: file.name, error: String(err) },
    };
  }
}

export function registerIngestTools(server: McpServer): void {
  server.tool(
    "analyze_images",
    `Analyze product images from a Google Drive folder. Downloads all images,
compresses them, runs AI vision analysis (image type, colors, effects, skin tone,
lighting), and generates alt text drafts. Returns structured analysis data plus
thumbnail image blocks that Claude can see for description writing.

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
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

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

      const cap = maxImages ?? 50;
      const context = { productName, brand, vendorHint };

      // Process ALL images (5 concurrent) — cap applies to successful results only
      const processed = await mapConcurrent(allFiles, 5, (file) =>
        processImage(file, context, 400, 65),
      );

      const results: AnalyzedImage[] = [];
      const errors: Array<{ fileId: string; filename: string; error: string }> = [];
      const lowConfidence: Array<{ fileId: string; filename: string; confidence: number; reason: string }> = [];
      let skippedAfterCap = 0;

      for (const p of processed) {
        if (p.result) {
          if (results.length < cap) {
            results.push(p.result);
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

      // Build summary JSON (without thumbnail base64 — those go as image blocks)
      const summary = {
        folderId,
        folderName,
        productName,
        brand,
        totalImagesFound: allFiles.length,
        totalAnalyzed: results.length,
        images: results.map((r) => ({
          fileId: r.fileId,
          filename: r.filename,
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

      // First block: structured analysis data
      content.push({ type: "text", text: JSON.stringify(summary, null, 2) });

      // Then: thumbnails as image blocks so Claude can see them
      for (const r of results) {
        content.push({
          type: "text",
          text: `\n--- ${r.filename} (${r.analysis.imageType}, confidence: ${r.analysis.confidence}) ---`,
        });
        content.push({
          type: "image",
          data: r.thumbnailBase64,
          mimeType: "image/jpeg",
        });
      }

      return { content };
    },
  );
}
