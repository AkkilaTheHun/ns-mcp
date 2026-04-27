import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { listFolderImages, downloadFile, getFolderMeta, listSubfolders, type DriveFile } from "../../google/drive.js";
import { listSharedFolderImages, listSharedSubfolders, getSharedLinkMetadata, downloadSharedFile, listOwnFolderImages, listOwnSubfolders, downloadOwnFile } from "../../dropbox/client.js";
import { analyzeImage as analyzeImageGemini, type ImageAnalysis } from "../../google/vision.js";
import { analyzeImage as analyzeImageClaude } from "../../anthropic/vision.js";

type VisionProvider = "gemini" | "claude";

/** Cache for URL-downloaded buffers so processImage can access them by "fileId" (which is the URL). */
const urlBufferCache = new Map<string, Buffer>();

/** Dropbox download function, set per-invocation by the analyze_images handler. */
let dropboxDownloader: ((path: string) => Promise<Buffer>) | undefined;

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
  provider: VisionProvider,
  model?: string,
): Promise<{ result?: Omit<AnalyzedImage, "proposedFilename">; error?: { fileId: string; filename: string; error: string } }> {
  try {
    // Resolve the image buffer: URL cache → Dropbox download → Drive download
    let raw: Buffer;
    if (urlBufferCache.has(file.id)) {
      raw = urlBufferCache.get(file.id)!;
      urlBufferCache.delete(file.id);
    } else if (file.id.startsWith("dropbox:") && dropboxDownloader) {
      const dropboxPath = file.id.replace("dropbox:", "");
      raw = await dropboxDownloader(dropboxPath);
    } else {
      raw = await downloadFile(file.id);
    }
    const rawSizeKB = Math.round(raw.length / 1024);
    console.log(`[analyze] Downloaded ${file.name} (${rawSizeKB} KB, ${file.mimeType})`);

    // Resize to 900px + high-quality JPEG for vision analysis.
    // Sharp handles HEIC/HEIF/PNG/WebP natively.
    // Quality 92 avoids compression artifacts that wash out fine glitter/flakies.
    const analysisBuffer = await sharp(raw, { failOn: "none" })
      .rotate()
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();

    console.log(`[analyze] Prepared ${file.name}: ${rawSizeKB} KB → ${Math.round(analysisBuffer.length / 1024)} KB`);

    const analyzeFn = provider === "claude" ? analyzeImageClaude : analyzeImageGemini;
    const analysis = await analyzeFn(
      analysisBuffer.toString("base64"),
      "image/jpeg",
      context,
      model,
    );

    console.log(`[analyze] Vision done [${provider}] ${file.name}: ${analysis.imageType} (confidence: ${analysis.confidence})`);

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
    `Analyze product images via AI vision (Gemini or Claude). Downloads, compresses via Sharp,
and returns structured analysis per image. Pass provider="claude" to use Anthropic Claude
Sonnet 4.6 instead of the default Gemini 2.5 Flash — useful for A/B comparing outputs on
the same image.

Accepts TWO input modes (provide one or both):
- folderId: Google Drive folder ID OR Dropbox URL. Supports recursive: true to traverse subfolders.
- urls: Array of public image URLs (CDN, vendor sites, Shopify, etc.)

ALL images are processed — nothing is filtered or skipped.

To analyze a SPECIFIC SUBFOLDER, pass its direct URL/ID as folderId.
For Dropbox, use the subfolder URL from discover_folder (e.g.,
"https://www.dropbox.com/home/Take%20It%20Easy/_always_polished_").
Do NOT pass the parent folder URL if you only want one subfolder's images.

Returns per-image: type, colors, effects, skin tone, lighting, alt text,
confidence score, original filename, subfolder path (Drive) or source URL.`,
    {
      folderId: z.string().optional().describe("Google Drive folder ID OR Dropbox URL (use subfolder URL from discover_folder to scope to a specific subfolder)"),
      urls: z.array(z.string()).optional().describe("Public image URLs to analyze (CDN, vendor sites, etc.)"),
      productName: z.string().describe("Product/shade name for vision context (e.g. 'Lavender Sunset')"),
      brand: z.string().describe("Brand name for vision context (e.g. 'Cadillacquer')"),
      vendorHint: z.string().optional().describe("Vendor's color/effect description to improve analysis accuracy"),
      recursive: z.boolean().optional().default(false).describe("Traverse subfolders (true for collection folders)"),
      maxImages: z.number().optional().default(50).describe("Max images to analyze (default 50)"),
      provider: z.enum(["gemini", "claude"]).optional().default("gemini").describe("Vision provider: 'gemini' (default, Gemini 2.5 Flash) or 'claude' (Claude Sonnet 4.6)"),
      model: z.string().optional().describe("Override the default model for the chosen provider. Examples: 'gemini-2.5-pro', 'claude-opus-4-7'. Defaults: gemini='gemini-2.5-flash', claude='claude-sonnet-4-6'."),
    },
    async ({ folderId, urls, productName, brand, vendorHint, recursive, maxImages, provider, model }) => {
      dropboxDownloader = undefined; // Reset per invocation

      if (!folderId && (!urls || urls.length === 0)) {
        return {
          content: [{ type: "text" as const, text: "Provide either folderId (Google Drive / Dropbox link) or urls (public image URLs), or both." }],
          isError: true,
        };
      }

      const isDropbox = folderId?.includes("dropbox.com/");

      // Collect all images (with subfolder path)
      interface TaggedFile extends DriveFile { subfolder: string | null }
      const allFiles: TaggedFile[] = [];
      let folderName = "(urls)";

      // Source 1a: Dropbox (shared link or own folder)
      if (folderId && isDropbox) {
        let useOwnFolder = false;
        let ownPath = "";

        try {
          const meta = await getSharedLinkMetadata(folderId);
          folderName = meta.name;
        } catch {
          // Shared link failed — try as own folder path
          const pathMatch = folderId.match(/dropbox\.com\/home\/(.+?)(?:\?|$)/);
          if (pathMatch) {
            ownPath = "/" + decodeURIComponent(pathMatch[1]);
            folderName = ownPath.split("/").pop() ?? "Dropbox";
            useOwnFolder = true;
          } else {
            // Not a /home/ path — retry shared link and let it throw
            try {
              const meta = await getSharedLinkMetadata(folderId);
              folderName = meta.name;
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error accessing Dropbox folder: ${err}` }],
                isError: true,
              };
            }
          }
        }

        const getImages = (subPath: string) =>
          useOwnFolder ? listOwnFolderImages(subPath || ownPath) : listSharedFolderImages(folderId, subPath);
        const getSubs = (subPath: string) =>
          useOwnFolder ? listOwnSubfolders(subPath || ownPath) : listSharedSubfolders(folderId, subPath);

        // Store download function for processImage to use later (parallel, not sequential)
        const dlFile = (filePath: string) =>
          useOwnFolder ? downloadOwnFile(filePath) : downloadSharedFile(folderId, filePath);
        dropboxDownloader = dlFile;

        const loadDropboxFolder = async (subPath: string, subfolder: string | null) => {
          const imgs = await getImages(subPath);
          for (const img of imgs) {
            // Don't download here — just register the file.
            // processImage will download in parallel via mapConcurrent.
            const syntheticId = `dropbox:${img.path}`;
            allFiles.push({
              id: syntheticId,
              name: img.name,
              mimeType: img.name.split(".").pop() ?? "image/jpeg",
              size: img.size,
              parentId: "(dropbox)",
              subfolder,
            });
          }
        };

        if (recursive) {
          await loadDropboxFolder("", null);
          const subs = await getSubs("");
          for (const sub of subs) {
            const subSubs = await getSubs(sub.path);
            if (subSubs.length > 0) {
              for (const ps of subSubs) {
                await loadDropboxFolder(ps.path, `${sub.name}/${ps.name}`);
              }
            } else {
              await loadDropboxFolder(sub.path, sub.name);
            }
          }
        } else {
          await loadDropboxFolder("", null);
        }
      }

      // Source 1b: Google Drive folder
      if (folderId && !isDropbox) {
        try {
          const meta = await getFolderMeta(folderId);
          folderName = meta.name;
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error accessing folder ${folderId}: ${err}` }],
            isError: true,
          };
        }

        if (recursive) {
          const subs = await listSubfolders(folderId);
          const directImgs = await listFolderImages(folderId);
          for (const f of directImgs) allFiles.push({ ...f, subfolder: null });

          for (const sub of subs) {
            const subSubs = await listSubfolders(sub.id);
            if (subSubs.length > 0) {
              for (const ps of subSubs) {
                const imgs = await listFolderImages(ps.id);
                for (const f of imgs) allFiles.push({ ...f, subfolder: `${sub.name}/${ps.name}` });
              }
            } else {
              const imgs = await listFolderImages(sub.id);
              for (const f of imgs) allFiles.push({ ...f, subfolder: sub.name });
            }
          }
        } else {
          const imgs = await listFolderImages(folderId);
          for (const f of imgs) allFiles.push({ ...f, subfolder: null });
        }
      }

      // Source 2: Public URLs — download and create synthetic DriveFile entries
      if (urls?.length) {
        for (const url of urls) {
          try {
            const filename = decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "image.jpg");
            const res = await fetch(url, {
              signal: AbortSignal.timeout(15000),
              headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              },
            });
            if (!res.ok) {
              console.error(`[analyze] URL fetch failed ${url}: HTTP ${res.status}`);
              continue;
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            const mimeType = res.headers.get("content-type") ?? "image/jpeg";

            // Store the buffer for processImage to use via downloadFile override
            // We use the URL as the fileId so it's traceable
            urlBufferCache.set(url, buffer);

            allFiles.push({
              id: url,
              name: filename,
              mimeType,
              size: buffer.length,
              parentId: "(url)",
              subfolder: null,
            });
          } catch (err) {
            console.error(`[analyze] URL fetch error ${url}: ${err}`);
          }
        }
      }

      if (allFiles.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No images found to analyze.` }],
          isError: true,
        };
      }

      console.log(`[analyze] Starting: ${allFiles.length} images in "${folderName}" for ${brand} - ${productName} (recursive: ${recursive}, provider: ${provider}${model ? `, model: ${model}` : ""})`);
      const startTime = Date.now();

      const cap = maxImages ?? 50;
      const filesToProcess = allFiles.slice(0, cap);
      const skippedAfterCap = Math.max(0, allFiles.length - cap);
      const context = { productName, brand, vendorHint };

      const concurrency = Number(process.env.IMAGE_CONCURRENCY ?? "8");
      const processed = await mapConcurrent(filesToProcess, concurrency, async (file, i) => {
        console.log(`[analyze] Processing ${i + 1}/${filesToProcess.length}: ${file.subfolder ? file.subfolder + "/" : ""}${file.name}`);
        return processImage(file, context, provider, model);
      });

      const results: Array<AnalyzedImage & { subfolder: string | null }> = [];
      const errors: Array<{ fileId: string; filename: string; subfolder: string | null; error: string }> = [];
      const lowConfidence: Array<{ fileId: string; filename: string; confidence: number; reason: string }> = [];

      let position = 0;
      for (let i = 0; i < processed.length; i++) {
        const p = processed[i];
        const file = filesToProcess[i];
        if (p.result) {
          position++;
          const proposedFilename = toSeoFilename(brand, productName, p.result.analysis.imageType, position);
          results.push({ ...p.result, proposedFilename, subfolder: file.subfolder });
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
        if (p.error) {
          errors.push({ ...p.error, subfolder: file.subfolder });
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[analyze] Complete: ${results.length} analyzed, ${errors.length} errors, ${elapsed}s elapsed`);

      const summary = {
        folderId,
        folderName,
        recursive,
        provider,
        productName,
        brand,
        totalImagesFound: allFiles.length,
        totalAnalyzed: results.length,
        processingTimeSeconds: Number(elapsed),
        images: results.map((r) => ({
          // Source identifier (one of these will be set)
          fileId: r.parentFolderId === "(url)" || r.parentFolderId === "(dropbox)" ? undefined : r.fileId,
          sourceUrl: r.parentFolderId === "(url)" ? r.fileId : undefined,
          dropboxPath: r.parentFolderId === "(dropbox)" ? r.fileId.replace("dropbox:", "") : undefined,
          // Core fields
          filename: r.filename,
          subfolder: r.subfolder,
          imageType: r.analysis.imageType,
          dominantColors: r.analysis.dominantColors.map((c) => c.label),
          observedEffects: r.analysis.observedEffects,
          altText: r.analysis.altText,
          confidence: r.analysis.confidence,
          // Omitted to save tokens: proposedFilename, lightingCondition, nailCount, skinTone, originalSizeKB, hex colors
        })),
        ...(skippedAfterCap > 0 ? { skippedAfterCap } : {}),
        ...(lowConfidence.length > 0 ? { lowConfidence } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
  );
}
