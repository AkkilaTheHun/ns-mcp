#!/usr/bin/env tsx
/**
 * Mode B: analyze a folder of mystery nail polish photos against a candidate
 * shade catalog and emit a shade-grouping manifest.
 *
 * Use this when a brand drops a new collection and you have a folder of
 * photos but don't know which photo is which shade — only the catalog of
 * candidate shades.
 *
 * Usage:
 *   pnpm analyze-collection \
 *     --folder "https://www.dropbox.com/home/Take%20It%20Easy" \
 *     --brand "Cadillacquer" \
 *     --collection "Take It Easy" \
 *     --catalog ./catalogs/take-it-easy.md \
 *     --out ./take-it-easy-manifest.json \
 *     [--shop nailstuff-ca.myshopify.com] [--verbose]
 *
 * Catalog file format (markdown — easy to paste from a brand's product page):
 *   - Daydreaming: grey crelly with red/copper ULTRACHROME chameleon flakes (large) and pink IRIDESCENT flakes (small).
 *   - Don't Worry: purple crelly with pink/copper ULTRACHROME chameleon flakes (large) and green/gold IRIDESCENT flakes (small).
 *   - ...one line per candidate shade, "- Name: description"
 *
 * Add the `(large)` / `(small)` annotations after each flake type for best
 * accuracy — Sonnet uses these to disambiguate on the closeup crop.
 *
 * Output (JSON manifest):
 *   {
 *     "brand": "Cadillacquer",
 *     "collection": "Take It Easy",
 *     "folder": "<original URL>",
 *     "summary": { "total": 140, "byShade": { "Just Breathe": 22, ... }, "lowConfidence": 4 },
 *     "shadeAssignments": {
 *       "Just Breathe": [{ "fileId": "...", "swatcherHandle": "yyulia_m" }, ...],
 *       ...
 *     },
 *     "lowConfidence": [
 *       { "fileId": "...", "predictedShade": "Pastel Thoughts", "confidence": 0.62, "reason": "..." }
 *     ]
 *   }
 *
 * The `shadeAssignments` shape is exactly what `organize_images stage_all`
 * expects — pass it back in chat to stage the photos for review:
 *   organize_images(action: "stage_all", source: "<folder>",
 *                   collectionName: "<collection>", shadeAssignments: <paste>)
 *
 * No DB writes happen in this script. Indexing comes later via
 * `pnpm index-brand` once the products exist in Shopify.
 */
import "dotenv/config";
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import {
  listSharedFolderImages,
  listSharedSubfolders,
  listOwnFolderImages,
  listOwnSubfolders,
  downloadSharedFile,
  downloadOwnFile,
  getSharedLinkMetadata,
} from "../src/dropbox/client.js";
import {
  listFolderImages,
  listSubfolders,
  downloadFile as downloadDriveFile,
  getFolderMeta,
} from "../src/google/drive.js";
import { analyzeImage as analyzeImageClaude } from "../src/anthropic/vision.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatalogShade {
  name: string;
  description: string;
}

interface FolderImage {
  fileId: string;        // dropbox path or drive file id
  filename: string;
  source: "dropbox" | "drive";
  swatcherHandle?: string;
  subfolder: string | null;
}

interface VisionResult {
  imageType: string;
  lightingCondition?: string;
  nailCount?: number;
  skinTone?: string | null;
  dominantColors: Array<{ hex?: string; label: string }>;
  observedEffects: string[];
  altText: string;
  confidence: number;
}

interface AnalyzedImage {
  image: FolderImage;
  ok: true;
  predictedShade: string | null;     // matched catalog shade or null if unmatched
  confidence: number;
  analysis: VisionResult;
}

interface AnalysisError {
  image: FolderImage;
  ok: false;
  error: string;
}

interface Manifest {
  brand: string;
  collection: string;
  folder: string;
  generatedAt: string;
  candidates: string[];
  summary: {
    total: number;
    analyzed: number;
    errors: number;
    byShade: Record<string, number>;
    unmatched: number;
    lowConfidence: number;
  };
  shadeAssignments: Record<string, Array<{ fileId: string; swatcherHandle?: string; confidence: number; filename: string }>>;
  unmatched: Array<{ fileId: string; filename: string; alt: string; confidence: number }>;
  lowConfidence: Array<{ fileId: string; filename: string; predictedShade: string | null; confidence: number; reason: string }>;
  errors: Array<{ fileId: string; filename: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Catalog parsing
// ---------------------------------------------------------------------------

function parseCatalog(content: string): CatalogShade[] {
  const shades: CatalogShade[] = [];
  const lines = content.split("\n");
  for (const raw of lines) {
    // Match "- Name: description" or "* Name: description" or "Name: description"
    const m = raw.match(/^\s*[-*]?\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const desc = m[2].trim();
    // Skip headers like "Take It Easy Collection descriptions" or "PARTICLE SIZE GUIDANCE"
    if (/(collection|guidance|note|warning)/i.test(name)) continue;
    if (name.length > 60 || desc.length < 10) continue;
    shades.push({ name, desc });
  }
  return shades;
}

function buildVendorHint(collection: string, shades: CatalogShade[]): string {
  return `This is a swatcher folder for the ${collection} collection. Each image depicts ONE of these ${shades.length} shades — identify which by matching the base color and flake behaviour, and use that shade name in the alt text.

PARTICLE SIZE GUIDANCE (critical for telling shades apart):
- "ultrachrome chameleon flakes" = LARGER flakes, visible as individual irregular shards on the nail, strong color-shift from one angle to another.
- "iridescent flakes" = SMALLER particles, finer scatter, soft pearly shimmer rather than discrete shards.
If you see large discrete color-shifting shards → the shade contains ultrachrome flakes. If you see only fine pearly shimmer → the shade has iridescent flakes only.

Shades:
${shades.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// Folder enumeration (Dropbox or Drive)
// ---------------------------------------------------------------------------

function isDropbox(url: string): boolean {
  return url.includes("dropbox.com/") || url.startsWith("/");
}

async function enumerateDropbox(url: string): Promise<{ folderName: string; images: FolderImage[] }> {
  // Detect own-folder vs shared-link pattern
  let useOwnFolder = false;
  let ownPath = "";
  let folderName = "";

  try {
    const meta = await getSharedLinkMetadata(url);
    folderName = meta.name;
  } catch {
    // try own-folder pattern: dropbox.com/home/<encoded path>
    const m = url.match(/dropbox\.com\/home\/(.+?)(?:\?|$)/);
    if (m) {
      ownPath = "/" + decodeURIComponent(m[1]);
      folderName = ownPath.split("/").pop() ?? "Dropbox";
      useOwnFolder = true;
    } else {
      throw new Error(`Could not access Dropbox folder: ${url}`);
    }
  }

  const images: FolderImage[] = [];
  const getImages = async (subPath: string) =>
    useOwnFolder ? listOwnFolderImages(subPath || ownPath) : listSharedFolderImages(url, subPath);
  const getSubs = async (subPath: string) =>
    useOwnFolder ? listOwnSubfolders(subPath || ownPath) : listSharedSubfolders(url, subPath);

  const loadFolder = async (subPath: string, subfolder: string | null, swatcher?: string) => {
    const imgs = await getImages(subPath);
    for (const img of imgs) {
      images.push({
        fileId: img.path,
        filename: img.name,
        source: "dropbox",
        swatcherHandle: swatcher,
        subfolder,
      });
    }
  };

  // Recursive: scan top level + one level deep, treating subfolder names as swatcher handles
  await loadFolder("", null);
  const subs = await getSubs("");
  for (const sub of subs) {
    const subSubs = await getSubs(sub.path);
    if (subSubs.length > 0) {
      for (const ps of subSubs) {
        await loadFolder(ps.path, `${sub.name}/${ps.name}`, sub.name);
      }
    } else {
      await loadFolder(sub.path, sub.name, sub.name);
    }
  }

  return { folderName, images };
}

async function enumerateDrive(folderId: string): Promise<{ folderName: string; images: FolderImage[] }> {
  const meta = await getFolderMeta(folderId);
  const images: FolderImage[] = [];
  const subs = await listSubfolders(folderId);
  const top = await listFolderImages(folderId);
  for (const f of top) {
    images.push({
      fileId: f.id,
      filename: f.name,
      source: "drive",
      swatcherHandle: undefined,
      subfolder: null,
    });
  }
  for (const sub of subs) {
    const imgs = await listFolderImages(sub.id);
    for (const f of imgs) {
      images.push({
        fileId: f.id,
        filename: f.name,
        source: "drive",
        swatcherHandle: sub.name,
        subfolder: sub.name,
      });
    }
  }
  return { folderName: meta.name, images };
}

async function downloadImage(img: FolderImage): Promise<Buffer> {
  return img.source === "dropbox" ? downloadOwnFile(img.fileId) : downloadDriveFile(img.fileId);
}

// ---------------------------------------------------------------------------
// Vision pipeline
// ---------------------------------------------------------------------------

async function analyzeOne(img: FolderImage, productName: string, brand: string, vendorHint: string): Promise<VisionResult> {
  const raw = await downloadImage(img);
  const rotated = sharp(raw, { failOn: "none" }).rotate();
  const full = await rotated.clone().resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  const crop = await rotated.clone().resize({ width: 800, height: 800, fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 92 }).toBuffer();
  return (await analyzeImageClaude(
    full.toString("base64"),
    "image/jpeg",
    { productName, brand, vendorHint },
    "claude-sonnet-4-6",
    { base64: crop.toString("base64"), mimeType: "image/jpeg" },
  )) as VisionResult;
}

function extractShadeFromAltText(altText: string, candidateNames: string[]): string | null {
  // Sonnet's altText follows: "{effect} {brand} nail polish in {ShadeName}, {what's shown}, ..."
  const m = altText.match(/nail polish in ([^,.;]+?)(?:[,.;]|$)/i);
  if (!m) return null;
  const guess = m[1].trim().replace(/['"`]+$/, "").replace(/^['"`]+/, "");

  // Exact match first
  const exact = candidateNames.find((c) => c.toLowerCase() === guess.toLowerCase());
  if (exact) return exact;

  // Fallback: substring match (handles "Just Breathe" vs "Just Breathe™" etc)
  const partial = candidateNames.find((c) =>
    guess.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(guess.toLowerCase()),
  );
  return partial ?? null;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  folder: string;
  brand: string;
  collection: string;
  catalog: string;
  out?: string;
  shop?: string;
  verbose: boolean;
  lowConfidenceThreshold: number;
}

function parseArgs(argv: string[]): Args {
  let folder: string | undefined;
  let brand: string | undefined;
  let collection: string | undefined;
  let catalog: string | undefined;
  let out: string | undefined;
  let shop: string | undefined;
  let verbose = false;
  let lowConfidenceThreshold = 0.8;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--folder") folder = argv[++i];
    else if (a === "--brand") brand = argv[++i];
    else if (a === "--collection") collection = argv[++i];
    else if (a === "--catalog") catalog = argv[++i];
    else if (a === "--out") out = argv[++i];
    else if (a === "--shop") shop = argv[++i];
    else if (a === "--verbose" || a === "-v") verbose = true;
    else if (a === "--low-conf") lowConfidenceThreshold = Number(argv[++i]);
  }

  if (!folder || !brand || !collection || !catalog) {
    console.error(
      "Usage: pnpm analyze-collection --folder <url> --brand <name> --collection <name> --catalog <path> [--out <path>] [--shop <domain>] [--verbose] [--low-conf 0.8]",
    );
    process.exit(1);
  }
  return { folder, brand, collection, catalog, out, shop, verbose, lowConfidenceThreshold };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`\n=== Analyzing collection: ${args.brand} / ${args.collection} ===`);
  console.log(`Folder: ${args.folder}`);
  console.log(`Catalog: ${args.catalog}`);

  // Load + parse catalog
  const catalogContent = await readFile(args.catalog, "utf8");
  const shades = parseCatalog(catalogContent);
  if (!shades.length) {
    console.error(`No shades parsed from catalog file. Expected lines like "- Name: description".`);
    process.exit(1);
  }
  console.log(`Loaded ${shades.length} candidate shades: ${shades.map((s) => s.name).join(", ")}`);

  const candidateNames = shades.map((s) => s.name);
  const vendorHint = buildVendorHint(args.collection, shades);

  // Enumerate folder
  console.log(`\nEnumerating folder...`);
  const { folderName, images } = isDropbox(args.folder)
    ? await enumerateDropbox(args.folder)
    : await enumerateDrive(args.folder);
  console.log(`Found ${images.length} images in "${folderName}"`);

  if (!images.length) {
    console.log("Nothing to analyze.");
    return;
  }

  console.log(`Estimated cost: ~$${(images.length * 0.02).toFixed(2)} on Sonnet (closeup mode)\n`);

  // Analyze concurrent (6-wide)
  console.log(`Analyzing...`);
  const results = await mapConcurrent(images, 6, async (img, i) => {
    try {
      const analysis = await analyzeOne(img, args.collection, args.brand, vendorHint);
      const predictedShade = extractShadeFromAltText(analysis.altText, candidateNames);
      const result: AnalyzedImage = {
        image: img,
        ok: true,
        predictedShade,
        confidence: analysis.confidence,
        analysis,
      };
      if (args.verbose) {
        const flag = analysis.confidence < args.lowConfidenceThreshold ? " ⚠" : "";
        console.log(`  [${i + 1}/${images.length}] ${img.filename} → ${predictedShade ?? "UNMATCHED"} (${analysis.confidence.toFixed(2)})${flag}`);
      } else {
        process.stdout.write(`.`);
      }
      return result;
    } catch (err) {
      const result: AnalysisError = { image: img, ok: false, error: String(err) };
      if (args.verbose) {
        console.log(`  [${i + 1}/${images.length}] ${img.filename} → ERROR ${String(err).slice(0, 80)}`);
      } else {
        process.stdout.write(`x`);
      }
      return result;
    }
  });
  if (!args.verbose) console.log(""); // newline after progress dots

  // Build manifest
  const manifest: Manifest = {
    brand: args.brand,
    collection: args.collection,
    folder: args.folder,
    generatedAt: new Date().toISOString(),
    candidates: candidateNames,
    summary: { total: images.length, analyzed: 0, errors: 0, byShade: {}, unmatched: 0, lowConfidence: 0 },
    shadeAssignments: {},
    unmatched: [],
    lowConfidence: [],
    errors: [],
  };

  for (const r of results) {
    if (!r.ok) {
      manifest.errors.push({ fileId: r.image.fileId, filename: r.image.filename, error: r.error });
      manifest.summary.errors++;
      continue;
    }
    manifest.summary.analyzed++;

    if (r.confidence < args.lowConfidenceThreshold) {
      manifest.lowConfidence.push({
        fileId: r.image.fileId,
        filename: r.image.filename,
        predictedShade: r.predictedShade,
        confidence: r.confidence,
        reason: r.predictedShade ? "Confidence below threshold — spot-check shade pick" : "Sonnet did not match a catalog shade",
      });
      manifest.summary.lowConfidence++;
    }

    if (!r.predictedShade) {
      manifest.unmatched.push({
        fileId: r.image.fileId,
        filename: r.image.filename,
        alt: r.analysis.altText,
        confidence: r.confidence,
      });
      manifest.summary.unmatched++;
      continue;
    }

    if (!manifest.shadeAssignments[r.predictedShade]) {
      manifest.shadeAssignments[r.predictedShade] = [];
    }
    manifest.shadeAssignments[r.predictedShade].push({
      fileId: r.image.fileId,
      filename: r.image.filename,
      swatcherHandle: r.image.swatcherHandle,
      confidence: r.confidence,
    });
    manifest.summary.byShade[r.predictedShade] = (manifest.summary.byShade[r.predictedShade] ?? 0) + 1;
  }

  // Print summary
  console.log(`\n=== Analysis complete ===`);
  console.log(`Analyzed: ${manifest.summary.analyzed} / ${manifest.summary.total}`);
  console.log(`Errors:   ${manifest.summary.errors}`);
  console.log(`\nPredicted shade counts:`);
  const byShadeSorted = Object.entries(manifest.summary.byShade).sort((a, b) => b[1] - a[1]);
  for (const [shade, count] of byShadeSorted) {
    console.log(`  ${shade.padEnd(20)} ${count}`);
  }
  if (manifest.summary.unmatched > 0) console.log(`  ${"UNMATCHED".padEnd(20)} ${manifest.summary.unmatched}`);
  if (manifest.summary.lowConfidence > 0) console.log(`\nLow-confidence calls (<${args.lowConfidenceThreshold}): ${manifest.summary.lowConfidence}`);

  // Write manifest
  const outPath = args.out ?? `./${args.collection.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-manifest.json`;
  await writeFile(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to ${outPath}`);

  // Print copy-paste-ready next step
  console.log(`\nNext step — review the manifest, then in chat:`);
  console.log(`  organize_images(`);
  console.log(`    action: "stage_all",`);
  console.log(`    source: "${args.folder}",`);
  console.log(`    collectionName: "${args.collection}",`);
  console.log(`    shadeAssignments: <paste shadeAssignments object from ${outPath}>`);
  console.log(`  )`);
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});
