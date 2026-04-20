import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { listFolderImages, downloadFile, getFolderMeta, type DriveFile } from "../../google/drive.js";
import { analyzeImage, type ImageAnalysis } from "../../google/vision.js";

const HEIC_MIMETYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);

/** Lazy-load heic-convert only when needed (saves ~20MB on module load). */
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
  thumbnailBase64: string;
}

/** Generate an SEO-friendly filename from brand, product, image type, and position. */
function toSeoFilename(brand: string, productName: string, imageType: string, position: number): string {
  const kebab = (s: string) =>
    s.toLowerCase()
      .replace(/['']/g, "")           // remove apostrophes
      .replace(/[^a-z0-9]+/g, "-")    // non-alphanumeric → hyphen
      .replace(/^-+|-+$/g, "");       // trim leading/trailing hyphens

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
  thumbnailWidth: number,
  jpegQuality: number,
): Promise<{ result?: Omit<AnalyzedImage, "proposedFilename">; error?: { fileId: string; filename: string; error: string } }> {
  try {
    // Download from Drive
    let raw = await downloadFile(file.id);
    const rawSizeKB = Math.round(raw.length / 1024);
    console.log(`[analyze] Downloaded ${file.name} (${rawSizeKB} KB, ${file.mimeType})`);

    // Convert HEIC/HEIF to JPEG before Sharp — node:22-slim lacks libheif
    const isHeic = HEIC_MIMETYPES.has(file.mimeType) || /\.heic$/i.test(file.name);
    if (isHeic) {
      console.log(`[analyze] Converting HEIC → JPEG: ${file.name}`);
      raw = await convertHeic(raw);
      console.log(`[analyze] HEIC converted: ${rawSizeKB} KB → ${Math.round(raw.length / 1024)} KB`);
    }

    // Resize to 900px JPEG for analysis
    const analysisBuffer = await sharp(raw, { failOn: "none" })
      .rotate()
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();

    // Thumbnail derived from the 900px buffer (already decoded, fast resize)
    const thumbBuffer = await sharp(analysisBuffer)
      .resize({ width: thumbnailWidth, withoutEnlargement: true })
      .jpeg({ quality: jpegQuality, mozjpeg: true })
      .toBuffer();

    console.log(`[analyze] Compressed ${file.name}: ${rawSizeKB} KB → ${Math.round(analysisBuffer.length / 1024)} KB analysis, ${Math.round(thumbBuffer.length / 1024)} KB thumb`);

    // Send to Gemini for analysis
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
        thumbnailBase64: thumbBuffer.toString("base64"),
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

      console.log(`[analyze] Starting: ${allFiles.length} images in "${folderName}" for ${brand} - ${productName}`);
      const startTime = Date.now();

      const cap = maxImages ?? 50;
      const context = { productName, brand, vendorHint };

      // Concurrency tuned for deployment environment:
      // - Render Starter (512MB): use 1
      // - Home server (8GB+): use 8-10
      // Bottleneck is Gemini API latency (~10s/image), not CPU/RAM.
      const concurrency = Number(process.env.IMAGE_CONCURRENCY ?? "8");
      const processed = await mapConcurrent(allFiles, concurrency, async (file, i) => {
        console.log(`[analyze] Processing ${i + 1}/${allFiles.length}: ${file.name}`);
        return processImage(file, context, 80, 60);
      });

      const results: AnalyzedImage[] = [];
      const errors: Array<{ fileId: string; filename: string; error: string }> = [];
      const lowConfidence: Array<{ fileId: string; filename: string; confidence: number; reason: string }> = [];
      let skippedAfterCap = 0;

      // Collect results and assign SEO filenames (position is 1-indexed)
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

      // Build summary JSON (without thumbnail base64 — those go as image blocks)
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
          thumbnailDataUrl: `data:image/jpeg;base64,${r.thumbnailBase64}`,
        })),
        ...(skippedAfterCap > 0 ? { skippedAfterCap } : {}),
        ...(lowConfidence.length > 0 ? { lowConfidence } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      };

      // Single JSON block with everything — thumbnails are in thumbnailDataUrl fields
      content.push({ type: "text", text: JSON.stringify(summary, null, 2) });

      return { content };
    },
  );
}
