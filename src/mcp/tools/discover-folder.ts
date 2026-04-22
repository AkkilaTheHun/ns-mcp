/**
 * discover_folder — Scan a Drive folder and return its structure.
 *
 * Fast, no image analysis. Returns folder hierarchy, file lists,
 * product groupings by filename, and swatcher folder names.
 * Claude uses this to understand what it's working with before
 * deciding next steps.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listFolderImages, listSubfolders, getFolderMeta } from "../../google/drive.js";

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

/**
 * Extract product name from a filename.
 * Returns null only for truly unclassifiable patterns.
 */
function extractProductName(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, "");

  // Skip generic camera filenames
  if (/^(IMG|DSC|DSCN|DSCF|P\d|Screenshot|Photo)[\s_-]?\d/i.test(base)) {
    return null;
  }

  // Remove trailing number with separator: "Product Name_1" or "Product Name 1"
  const cleaned = base
    .replace(/[\s_-]+\d+\s*$/, "")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FolderFile {
  id: string;
  name: string;
  mimeType: string;
  sizeKB: number;
  subfolder: string | null;  // which subfolder this file lives in (null = top-level)
}

interface DiscoveredProduct {
  name: string;
  imageCount: number;
  subfolders: string[];      // which swatcher folders have images for this product
}

// ---------------------------------------------------------------------------
// MCP Tool Registration
// ---------------------------------------------------------------------------

export function registerDiscoverFolderTool(server: McpServer): void {
  server.tool(
    "discover_folder",
    `Scan a Google Drive folder and return its structure. Fast — no image analysis.

Returns: folder name, subfolder names (often swatcher names), all image files
with which subfolder they live in, and product groupings extracted from filenames.

Use this FIRST when a user provides a Drive folder. Review the structure, discuss
what you found, then decide which images to analyze and which products to ingest.

For collection folders with swatcher subfolders, the subfolder names are typically
swatcher names (e.g., "Yuliia : @yyulia_m", "Trusha", "Suzie").`,
    {
      folderId: z.string().describe("Google Drive folder ID to scan"),
    },
    async ({ folderId }) => {
      const startTime = Date.now();

      // Get folder metadata
      let folderName: string;
      let folderParents: string[];
      try {
        const meta = await getFolderMeta(folderId);
        folderName = meta.name;
        folderParents = meta.parents;
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error accessing folder ${folderId}: ${err}` }],
          isError: true,
        };
      }

      // List direct images
      const directImages = await listFolderImages(folderId);
      const subfolders = await listSubfolders(folderId);

      const allFiles: FolderFile[] = [];
      const productMap = new Map<string, { count: number; subfolders: Set<string> }>();
      const swatcherFolders: Array<{ name: string; id: string; imageCount: number; hasSubfolders: boolean }> = [];
      let unclassifiedCount = 0;

      // Add top-level images
      for (const img of directImages) {
        allFiles.push({
          id: img.id,
          name: img.name,
          mimeType: img.mimeType,
          sizeKB: Math.round(img.size / 1024),
          subfolder: null,
        });
        const productName = extractProductName(img.name);
        if (productName) {
          const entry = productMap.get(productName) ?? { count: 0, subfolders: new Set<string>() };
          entry.count++;
          entry.subfolders.add("(top-level)");
          productMap.set(productName, entry);
        } else {
          unclassifiedCount++;
        }
      }

      // Traverse subfolders
      for (const sub of subfolders) {
        const subSubs = await listSubfolders(sub.id);
        const subImages = await listFolderImages(sub.id);

        swatcherFolders.push({
          name: sub.name,
          id: sub.id,
          imageCount: subImages.length + (subSubs.length > 0 ? -1 : 0), // approximate
          hasSubfolders: subSubs.length > 0,
        });

        if (subSubs.length > 0) {
          // Per-product subfolders (e.g., Suzie/Blazing Evening Sky/)
          for (const productFolder of subSubs) {
            const imgs = await listFolderImages(productFolder.id);
            for (const img of imgs) {
              allFiles.push({
                id: img.id,
                name: img.name,
                mimeType: img.mimeType,
                sizeKB: Math.round(img.size / 1024),
                subfolder: `${sub.name}/${productFolder.name}`,
              });
            }
            const entry = productMap.get(productFolder.name.trim()) ?? { count: 0, subfolders: new Set<string>() };
            entry.count += imgs.length;
            entry.subfolders.add(sub.name);
            productMap.set(productFolder.name.trim(), entry);
          }
          // Update swatcher image count
          let totalInSub = 0;
          for (const ps of subSubs) {
            const psImgs = await listFolderImages(ps.id);
            totalInSub += psImgs.length;
          }
          const idx = swatcherFolders.findIndex((s) => s.id === sub.id);
          if (idx >= 0) swatcherFolders[idx].imageCount = totalInSub;
        } else {
          // Flat swatcher folder — group by filename
          for (const img of subImages) {
            allFiles.push({
              id: img.id,
              name: img.name,
              mimeType: img.mimeType,
              sizeKB: Math.round(img.size / 1024),
              subfolder: sub.name,
            });
            const productName = extractProductName(img.name);
            if (productName) {
              const entry = productMap.get(productName) ?? { count: 0, subfolders: new Set<string>() };
              entry.count++;
              entry.subfolders.add(sub.name);
              productMap.set(productName, entry);
            } else {
              unclassifiedCount++;
            }
          }
        }
      }

      // Build product list
      const discoveredProducts: DiscoveredProduct[] = [...productMap.entries()]
        .map(([name, data]) => ({
          name,
          imageCount: data.count,
          subfolders: [...data.subfolders],
        }))
        .sort((a, b) => b.imageCount - a.imageCount);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Determine structure type
      let structure: string;
      if (subfolders.length === 0) {
        structure = "flat";
      } else if (discoveredProducts.length > 1) {
        structure = "collection";
      } else {
        structure = "single-product-with-subfolders";
      }

      const result = {
        folderId,
        folderName,
        structure,
        totalFiles: allFiles.length,
        totalSubfolders: subfolders.length,

        // Swatcher folders (the subfolder names — often swatcher identifiers)
        swatcherFolders,

        // Discovered products (grouped by filename or subfolder name)
        discoveredProducts,

        // Unclassified files (IMG_####, etc.)
        unclassifiedImageCount: unclassifiedCount,

        // Full file list with subfolder tags
        files: allFiles,

        scanTimeSeconds: Number(elapsed),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
