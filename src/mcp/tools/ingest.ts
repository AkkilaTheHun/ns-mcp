import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { listFolderImages, downloadFile, getFolderMeta, listSubfolders, type DriveFile } from "../../google/drive.js";
import { listSharedFolderImages, listSharedSubfolders, getSharedLinkMetadata, downloadSharedFile, listOwnFolderImages, listOwnSubfolders, downloadOwnFile } from "../../dropbox/client.js";
import { isDropboxSource, toDropboxPath } from "../../dropbox/source.js";
import type { ImageAnalysis } from "../../google/vision.js";
import { analyzeWithRetry, type VisionProvider } from "../../vision/analyze.js";
import type { PromptContext } from "../../vision/schema.js";
import { buildPixelIndex, snapAnalysis, type SnapReport } from "../../vision/snap.js";
import { parseColor, rgbToLab, deltaE76 } from "../../util/color.js";

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
  snapReport?: SnapReport;
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
interface PreviewBuffers {
  fileId: string;
  filename: string;
  full: { base64: string; sizeKB: number };
  crop?: { base64: string; sizeKB: number };
}

/**
 * Crop centered on the weighted centroid of pixels matching `targetColor`.
 * Samples at low resolution for speed, computes per-pixel LAB Delta-E, and
 * weights matches inversely with distance. Returns null when the match score
 * is too weak (caller should fall back to attention-based crop).
 */
async function colorTargetedCrop(
  rotated: sharp.Sharp,
  targetColor: string,
  cropSize: number,
): Promise<{ buffer: Buffer; matchStrength: number } | null> {
  const SAMPLE = 200;
  const MATCH_THRESHOLD = 30; // Delta-E distances above this contribute zero weight
  const MIN_TOTAL_WEIGHT = 200; // below this, we treat the match as insufficient

  const targetLab = parseColor(targetColor);

  const fullMeta = await rotated.clone().metadata();
  const fullW = fullMeta.width;
  const fullH = fullMeta.height;
  if (!fullW || !fullH) return null;

  const { data, info } = await rotated.clone()
    .resize(SAMPLE, SAMPLE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Center-bias: each pixel's contribution is multiplied by a falloff that
  // prefers the central ~40% of the frame. Floors at 0.3 so edge pixels still
  // count — we just don't let a large edge-mounted bottle dominate the centroid.
  // This works for both flake polishes and opaque cremes (no texture assumption).
  let totalWeight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels;
      const lab = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
      const dist = deltaE76(lab, targetLab);
      const colorScore = Math.max(0, MATCH_THRESHOLD - dist);
      if (colorScore > 0) {
        const cxRel = x / info.width - 0.5;
        const cyRel = y / info.height - 0.5;
        const radial = Math.sqrt(cxRel * cxRel + cyRel * cyRel);
        const centerWeight = Math.max(0.3, 1 - Math.min(1, radial * 1.5));
        const weight = colorScore * centerWeight;
        totalWeight += weight;
        sumX += x * weight;
        sumY += y * weight;
      }
    }
  }

  if (totalWeight < MIN_TOTAL_WEIGHT) return null;

  const cxSampled = sumX / totalWeight;
  const cySampled = sumY / totalWeight;
  const cx = (cxSampled / info.width) * fullW;
  const cy = (cySampled / info.height) * fullH;

  const cropW = Math.min(cropSize, fullW);
  const cropH = Math.min(cropSize, fullH);
  const left = Math.max(0, Math.min(fullW - cropW, Math.round(cx - cropW / 2)));
  const top = Math.max(0, Math.min(fullH - cropH, Math.round(cy - cropH / 2)));

  const buffer = await rotated.clone()
    .extract({ left, top, width: cropW, height: cropH })
    .resize({ width: cropSize, height: cropSize, fit: "cover" })
    .jpeg({ quality: 92 })
    .toBuffer();

  return { buffer, matchStrength: totalWeight };
}

/**
 * Attention-located crop that extracts NATIVE pixels.
 *
 * The previous implementation used `.resize({fit:"cover", position:attention})`,
 * which scales the whole frame down to the crop size and only then cuts. On a
 * square source — which every swatcher shoot is — "cover" has nothing to cut,
 * so attention became a no-op and the "closeup" was just the full frame
 * downscaled to 800px: strictly less detail than the full image it was meant to
 * supplement. Measured on 1500x1500 and 2500x2500 frames, individual flakes and
 * glitter particles dissolved into an undifferentiated sparkle wash, which is
 * exactly the signal flakeColors/glitterColors/flakeSize are read from.
 *
 * Attention still picks WHERE to look (it has real offsets whenever the aspect
 * ratio is not square), but the pixels come from `.extract()` at 1:1.
 */
async function attentionNativeCrop(
  rotated: sharp.Sharp,
  cropSize: number,
  fullW: number,
  fullH: number,
): Promise<Buffer> {
  const cw = Math.min(cropSize, fullW);
  const ch = Math.min(cropSize, fullH);

  // Probe for the region attention would have chosen. cropOffset* are in the
  // scaled coordinate space, so map the centre back to full resolution.
  let cx = fullW / 2;
  let cy = fullH / 2;
  try {
    const scale = Math.max(cropSize / fullW, cropSize / fullH);
    const { info } = await rotated.clone()
      .resize({ width: cropSize, height: cropSize, fit: "cover", position: sharp.strategy.attention })
      .toBuffer({ resolveWithObject: true });
    cx = ((info.cropOffsetLeft ?? 0) * -1 + cropSize / 2) / scale;
    cy = ((info.cropOffsetTop ?? 0) * -1 + cropSize / 2) / scale;
  } catch {
    // Fall back to centre — these are centred product shots.
  }

  const left = Math.max(0, Math.min(fullW - cw, Math.round(cx - cw / 2)));
  const top = Math.max(0, Math.min(fullH - ch, Math.round(cy - ch / 2)));

  return rotated.clone()
    .extract({ left, top, width: cw, height: ch })
    .resize({ width: cropSize, height: cropSize, fit: "cover", withoutEnlargement: true })
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function processImage(
  file: DriveFile,
  context: PromptContext,
  provider: VisionProvider,
  model?: string,
  fullWidth: number = 1568,
  closeup: boolean = true,
  preview: boolean = false,
  cropTargetColor?: string,
  snapColors: boolean = true,
): Promise<{ result?: Omit<AnalyzedImage, "proposedFilename">; preview?: PreviewBuffers; error?: { fileId: string; filename: string; error: string } }> {
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

    // Sharp handles HEIC/HEIF/PNG/WebP natively. Quality 92 avoids compression
    // artifacts that wash out fine glitter/flakies. clone() because pipelines
    // are single-use.
    const rotated = sharp(raw, { failOn: "none" }).rotate();

    // Re-encoding a JPEG that is already within the size budget only discards
    // sparkle: measured on a 1500x1500 swatch, q92 cut 1683 KB to 507 KB at
    // identical pixel dimensions. Pass the original bytes through when nothing
    // would actually change — but only when no EXIF rotation is pending and the
    // source is already JPEG, since both are applied by the encode path.
    const srcMeta = await rotated.clone().metadata();
    const needsRotate = (srcMeta.orientation ?? 1) !== 1;
    const withinBudget = (srcMeta.width ?? 0) <= fullWidth && (srcMeta.height ?? 0) <= fullWidth;
    const ANALYSIS_BYTES_MAX = 4_500_000; // Anthropic caps images at 5 MB

    const analysisBuffer =
      srcMeta.format === "jpeg" && !needsRotate && withinBudget && raw.length <= ANALYSIS_BYTES_MAX
        ? raw
        : await rotated.clone()
            .resize({ width: fullWidth, withoutEnlargement: true })
            .jpeg({ quality: 92 })
            .toBuffer();

    let cropBuffer: Buffer | undefined;
    let cropStrategy: "color" | "attention" | undefined;
    if (closeup) {
      if (cropTargetColor) {
        const colorCrop = await colorTargetedCrop(rotated, cropTargetColor, 800);
        if (colorCrop) {
          cropBuffer = colorCrop.buffer;
          cropStrategy = "color";
          console.log(`[analyze] ${file.name}: color-targeted crop on "${cropTargetColor}" (match weight ${Math.round(colorCrop.matchStrength)})`);
        } else {
          console.log(`[analyze] ${file.name}: color match for "${cropTargetColor}" too weak — falling back to attention crop`);
        }
      }
      if (!cropBuffer) {
        // q95 inside the helper: the closeup exists to judge particle
        // morphology, which is precisely what JPEG artifacts destroy.
        // Anthropic's vision docs warn heavy compression is "detrimental to
        // model performance".
        const meta = await rotated.clone().metadata();
        cropBuffer = await attentionNativeCrop(rotated, 800, meta.width ?? 800, meta.height ?? 800);
        cropStrategy = "attention";
      }
    }

    console.log(`[analyze] Prepared ${file.name}: ${rawSizeKB} KB → ${Math.round(analysisBuffer.length / 1024)} KB${cropBuffer ? ` + ${Math.round(cropBuffer.length / 1024)} KB crop` : ""}`);

    if (preview) {
      return {
        preview: {
          fileId: file.id,
          filename: file.name,
          full: { base64: analysisBuffer.toString("base64"), sizeKB: Math.round(analysisBuffer.length / 1024) },
          crop: cropBuffer ? { base64: cropBuffer.toString("base64"), sizeKB: Math.round(cropBuffer.length / 1024) } : undefined,
        },
      };
    }

    const analysis = await analyzeWithRetry(
      analysisBuffer.toString("base64"),
      "image/jpeg",
      context,
      {
        provider,
        model,
        crop: cropBuffer ? { base64: cropBuffer.toString("base64"), mimeType: "image/jpeg" } : undefined,
        attempts: 2,
        onRetry: (attempt, reason) =>
          console.warn(`[analyze] RETRY ${file.name} (attempt ${attempt}): ${reason}`),
      },
    );

    console.log(`[analyze] Vision done [${provider}] ${file.name}: ${analysis.imageType} (quality: ${analysis.imageQuality}, id: ${analysis.identification})`);

    // Snap reported colours onto real pixel clusters. Without this the hexes
    // are the model's reconstruction rather than a measurement, and everything
    // downstream (embedding, ΔE match, clustering) consumes them as if they
    // had been sampled.
    let snapReport: SnapReport | undefined;
    if (!snapColors) {
      // caller opted out
    } else {
      try {
        const index = await buildPixelIndex(analysisBuffer);
        snapReport = snapAnalysis(index, analysis);
        if (snapReport.maxMovedDeltaE > 0) {
          console.log(`[analyze] Snapped ${file.name}: ${snapReport.snappedCount} colours, mean ${snapReport.meanMovedDeltaE} / max ${snapReport.maxMovedDeltaE} ΔE moved${snapReport.unsnappedCount ? `, ${snapReport.unsnappedCount} had no pixel support` : ""}`);
        }
      } catch (err) {
        console.warn(`[analyze] Snap failed for ${file.name}, keeping reported colours: ${err}`);
      }
    }

    return {
      result: {
        fileId: file.id,
        filename: file.name,
        parentFolderId: file.parentId,
        originalSizeBytes: file.size,
        analysis,
        snapReport,
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
      provider: z.enum(["gemini", "claude"]).optional().default("claude").describe("Vision provider. Defaults to 'claude' (Sonnet 4.6). Gemini's confidence is miscalibrated — it returns 1.0 on wrong answers and its run-to-run base-colour spread is ~2.5x Claude's on the same image — so it poisons the shade catalog. Use 'gemini' only for deliberate A/B comparison."),
      model: z.string().optional().describe("Override the default model for the chosen provider. Examples: 'gemini-2.5-pro', 'claude-opus-4-7'. Defaults: gemini='gemini-2.5-flash', claude='claude-sonnet-4-6'."),
      fullWidth: z.number().optional().default(1568).describe("Width in px to resize the full image to before sending (default 1568). 1568 is the standard-tier long-edge cap Claude downscales to, so anything smaller discards fidelity for free; Claude 4.7+ run a high-resolution tier at 2576. Measured: 900->1400 cut run-to-run base-colour spread from 5.1 to 3.0 deltaE."),
      closeup: z.boolean().optional().default(true).describe("Send a Sharp attention-cropped 800x800 close-up alongside the full image in the same call (default true). This is the ONLY config that resolves particle morphology: flakeSize and iridescence are returned as null/none without it, so componentFinish.flakeSize depends on it."),
      snapColors: z.boolean().optional().default(true).describe("Snap every reported colour onto the nearest real pixel cluster in the image via LAB mean-shift (default true). Vision models return colours that are approximately right in hue but reconstructed, not sampled: measured on a 257-image set, most reported hexes had under 1% of pixels within deltaE 10 of them. Downstream consumers treat these as measurements, so snapping is what makes them one. The audit trail (how far each colour moved) is returned as colorSnapping."),
      polishFinishes: z.array(z.enum(["glitter","shimmer","metallic","holographic","glossy","opaque","matte","reflective","duochrome","multichrome","flakies","flakes","chrome","foil"])).optional().describe("Operator ground truth for the polish type (from Shopify custom.nailstuff_polish_type). Switches the prompt to a type-specific measurement procedure, because what IDENTIFIES a polish differs by type: a magnetic is identified by its concentrated line colour (two magnetics often share a base and differ only in line colour), a thermal by its pair of states, a multichrome by its full travel range, a creme by base colour alone. Measured: with one generic prompt, magnetics fragmented into 13 clusters from 26 images while other types gave 3-4. Pass this whenever the type is known."),
      polishType: z.enum(["creme","crelly","jelly","sheer","topper","top-coat","magnetic","thermal","holo","uv","glow-in-the-dark","crackle"]).optional().describe("Operator ground truth for polish TYPE, from Shopify custom.nailstuff_polish_type or the vendor description. NOT inferred from the image: measured on a 10-shade collection, vision classification of type got 5 wrong, always reporting the loudest optical effect (both thermals read as glitter, a magnetic as multichrome, two clear-base toppers as holo). Switches the prompt to a type-specific procedure — telling the model a polish is magnetic and to read the base AWAY from the band cut frame-to-frame base disagreement from 81.0 to 6.7 deltaE.")
      , expectedFeatures: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe("What the vendor says this shade contains, e.g. {baseColor:'sheer red', magneticLineColor:'orange'}. Passed as expectations to VERIFY, never as answers to echo: it tells the model where to look without telling it what to conclude, and disagreements are reported rather than suppressed."),
      collectionMode: z.boolean().optional().default(false).describe("Set true when analyzing a folder containing MANY different shades. The model is told the shade is unknown, must describe features only, and must never name or guess a shade. Without this, passing a shade name (or a vendorHint listing a collection's shades) makes the model CHOOSE a shade and assert it at high confidence — measured: identification scores rose ~0.09 purely from being handed a name. Alt text is templated after the operator assigns the shade."),
      preview: z.boolean().optional().default(false).describe("Debug mode. When true, skip the vision API call entirely and return the prepared image buffers (full + crop if closeup=true) as renderable image blocks so you can inspect what would have been sent. Useful for verifying the attention crop isn't landing on a knuckle or bottle cap."),
      previewFormat: z.enum(["image", "data"]).optional().default("image").describe("Format for preview output. 'image' (default) returns inline image content blocks (rendered by Claude.ai). 'data' returns JSON with base64 strings — use this for Claude Code where inline image rendering doesn't work in most terminals; the agent can then decode to /tmp and open them with the OS image viewer."),
      cropTargetColor: z.string().optional().describe("Target color for the closeup crop. Accepts hex (e.g. '#a8c5e8') or a known name (pastel blue, pastel mint, pastel teal, pink, purple, lavender, periwinkle, grey, etc). When set, the crop is centered on the weighted centroid of pixels matching this color in LAB space — useful for swatcher folders where the catalog color is known and you want to avoid attention landing on bottle caps or skin. Falls back to attention crop if the color match is too weak."),
      structured: z.boolean().optional().default(true).describe("Return the FULL structured analysis (default true): separate bottleColors/nailColors, the discriminators block (baseColor, shiftColors, shimmerFlashColors, magneticLineColor, glitterColors, flakeColors, thermalCold/Warm), componentFinish, and split imageQuality/identification scores. The hex values are the most useful output and are required by shade_index add_image. Set false only for token-light label-only output to an LLM consumer."),
    },
    async ({ folderId, urls, productName, brand, vendorHint, recursive, maxImages, provider, model, fullWidth, closeup, collectionMode, polishType, polishFinishes, expectedFeatures, snapColors, preview, previewFormat, cropTargetColor, structured }) => {
      dropboxDownloader = undefined; // Reset per invocation

      if (!folderId && (!urls || urls.length === 0)) {
        return {
          content: [{ type: "text" as const, text: "Provide either folderId (Google Drive / Dropbox link) or urls (public image URLs), or both." }],
          isError: true,
        };
      }

      const isDropbox = folderId ? isDropboxSource(folderId) : false;

      // Collect all images (with subfolder path)
      interface TaggedFile extends DriveFile { subfolder: string | null }
      const allFiles: TaggedFile[] = [];
      let folderName = "(urls)";

      // Source 1a: Dropbox (shared link or own folder)
      if (folderId && isDropbox) {
        let useOwnFolder = false;
        let ownPath = "";

        // A path-shaped source ("/Folder/Sub", "dropbox:/...", a /home/ URL) is
        // addressable directly. Only genuine shared links (/scl/fo/, /s/) need
        // the sharing API, so don't spend a round trip probing for one.
        const directPath = toDropboxPath(folderId);
        if (directPath !== null) {
          ownPath = directPath.startsWith("/") || directPath.startsWith("ns:") ? directPath : "/" + directPath;
          folderName = ownPath.split("/").filter(Boolean).pop() ?? "Dropbox";
          useOwnFolder = true;
        } else {
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

      console.log(`[analyze] Starting: ${allFiles.length} images in "${folderName}" for ${brand} - ${productName} (recursive: ${recursive}, provider: ${provider}${model ? `, model: ${model}` : ""}, fullWidth: ${fullWidth}, closeup: ${closeup}${cropTargetColor ? `, cropTargetColor: "${cropTargetColor}"` : ""}${preview ? ", PREVIEW" : ""})`);
      const startTime = Date.now();

      const cap = maxImages ?? 50;
      const filesToProcess = allFiles.slice(0, cap);
      const skippedAfterCap = Math.max(0, allFiles.length - cap);
      const context: PromptContext = { productName, brand, vendorHint, collectionMode, polishType, polishFinishes, expectedFeatures };

      const concurrency = Number(process.env.IMAGE_CONCURRENCY ?? "8");
      const processed = await mapConcurrent(filesToProcess, concurrency, async (file, i) => {
        console.log(`[analyze] Processing ${i + 1}/${filesToProcess.length}: ${file.subfolder ? file.subfolder + "/" : ""}${file.name}`);
        return processImage(file, context, provider, model, fullWidth, closeup, preview, cropTargetColor, snapColors);
      });

      // Preview mode: return prepared image buffers as renderable blocks instead of vision analyses
      if (preview) {
        const previews = processed.filter((p) => p.preview).map((p) => p.preview!);
        const previewErrors = processed.filter((p) => p.error).map((p) => p.error!);

        if (previewFormat === "data") {
          // JSON output — for Claude Code where inline image blocks don't render
          const summary = {
            mode: "preview",
            fullWidth,
            closeup,
            cropTargetColor,
            totalPrepared: previews.length,
            note: "Decode each base64 to disk (e.g. echo \"$b64\" | base64 -d > file.jpg) to view.",
            images: previews.map((pv) => ({
              filename: pv.filename,
              full: { sizeKB: pv.full.sizeKB, base64: pv.full.base64 },
              ...(pv.crop ? { crop: { sizeKB: pv.crop.sizeKB, base64: pv.crop.base64 } } : {}),
            })),
            ...(previewErrors.length ? { errors: previewErrors } : {}),
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
        }

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        content.push({
          type: "text",
          text: `Preview mode: ${previews.length} images prepared (fullWidth=${fullWidth}, closeup=${closeup}). No vision API calls were made.`,
        });
        for (const pv of previews) {
          content.push({ type: "text", text: `=== ${pv.filename} — full (${pv.full.sizeKB} KB) ===` });
          content.push({ type: "image", data: pv.full.base64, mimeType: "image/jpeg" });
          if (pv.crop) {
            content.push({ type: "text", text: `--- ${pv.filename} — attention crop (${pv.crop.sizeKB} KB) ---` });
            content.push({ type: "image", data: pv.crop.base64, mimeType: "image/jpeg" });
          }
        }
        if (previewErrors.length) {
          content.push({ type: "text", text: `Errors:\n${previewErrors.map((e) => `  ${e.filename}: ${e.error}`).join("\n")}` });
        }
        return { content };
      }

      const results: Array<AnalyzedImage & { subfolder: string | null }> = [];
      const errors: Array<{ fileId: string; filename: string; subfolder: string | null; error: string }> = [];
      const lowConfidence: Array<{ fileId: string; filename: string; imageQuality: number; identification: number; reason: string }> = [];

      let position = 0;
      for (let i = 0; i < processed.length; i++) {
        const p = processed[i];
        const file = filesToProcess[i];
        if (p.result) {
          position++;
          const proposedFilename = toSeoFilename(brand, productName, p.result.analysis.imageType, position);
          results.push({ ...p.result, proposedFilename, subfolder: file.subfolder });
          // The two scores mean different things and route differently: a
          // blurry frame is a reshoot, an ambiguous shade needs an operator
          // decision. Flagging them under one number sent both to the same pile.
          const { imageQuality, identification } = p.result.analysis;
          if (imageQuality < 0.75 || identification < 0.75) {
            lowConfidence.push({
              fileId: p.result.fileId,
              filename: p.result.filename,
              imageQuality,
              identification,
              reason: p.result.analysis.parseFailed
                ? "Model reply did not parse after retry"
                : imageQuality < 0.75 && identification < 0.75
                  ? "Image is hard to read AND the shade is ambiguous"
                  : imageQuality < 0.75
                    ? "Image quality low (blur/exposure/framing) — candidate for reshoot"
                    : "Image is clear but the shade is ambiguous from this frame — needs operator assignment",
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
          // structured=true preserves {hex,label} (+ extra fields) for programmatic
          // callers (shade_index); default strips to label strings to save LLM tokens.
          dominantColors: structured
            ? (r.analysis.dominantColors ?? [])
            : (r.analysis.dominantColors ?? []).map((c) => (typeof c === "string" ? c : c?.label ?? "")).filter(Boolean),
          observedEffects: r.analysis.observedEffects ?? [],
          altText: r.analysis.altText,
          // proposedFilename was previously computed and then dropped from the
          // response, so callers never saw the SEO name and push_to_product fell
          // back to positional numbering. It carries the image type, which is
          // the part positional numbering cannot recover.
          proposedFilename: r.proposedFilename,
          ...(structured
            ? {
                // Never merged — a bottle reading and a nail reading of the same
                // polish are expected to differ (see vision/schema.ts).
                bottleColors: r.analysis.bottleColors,
                nailColors: r.analysis.nailColors,
                discriminators: r.analysis.discriminators,
                componentFinish: r.analysis.componentFinish,
                imageQuality: r.analysis.imageQuality,
                identification: r.analysis.identification,
                ...(r.snapReport
                  ? { colorSnapping: { snapped: r.snapReport.snappedCount, noPixelSupport: r.snapReport.unsnappedCount, meanMovedDeltaE: r.snapReport.meanMovedDeltaE, maxMovedDeltaE: r.snapReport.maxMovedDeltaE } }
                  : {}),
                lightingCondition: r.analysis.lightingCondition,
                skinTone: r.analysis.skinTone,
                nailCount: r.analysis.nailCount,
              }
            : { confidence: r.analysis.confidence }),
        })),
        ...(skippedAfterCap > 0 ? { skippedAfterCap } : {}),
        ...(lowConfidence.length > 0 ? { lowConfidence } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
  );
}
