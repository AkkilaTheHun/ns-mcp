/**
 * discover_folder — Scan a Drive or Dropbox folder and return its structure.
 *
 * Fast, no image analysis. Returns folder hierarchy, file lists,
 * product groupings by filename, and swatcher folder names.
 * Claude uses this to understand what it's working with before
 * deciding next steps.
 *
 * Auto-detects source: Dropbox shared links vs Google Drive folder IDs.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listFolderImages, listSubfolders, getFolderMeta } from "../../google/drive.js";
import {
  listSharedFolderImages,
  listSharedSubfolders,
  getSharedLinkMetadata,
  type DropboxFile,
} from "../../dropbox/client.js";

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

function extractProductName(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, "");
  if (/^(IMG|DSC|DSCN|DSCF|P\d|Screenshot|Photo)[\s_-]?\d/i.test(base)) {
    return null;
  }
  const cleaned = base.replace(/[\s_-]+\d+\s*$/, "").trim();
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
  subfolder: string | null;
}

interface DiscoveredProduct {
  name: string;
  imageCount: number;
  subfolders: string[];
}

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------

function isDropboxUrl(input: string): boolean {
  return input.includes("dropbox.com/") || input.includes("dropboxusercontent.com/");
}

// ---------------------------------------------------------------------------
// Dropbox scanning
// ---------------------------------------------------------------------------

async function scanDropbox(sharedLink: string) {
  const startTime = Date.now();

  const meta = await getSharedLinkMetadata(sharedLink);
  const folderName = meta.name;

  const allFiles: FolderFile[] = [];
  const productMap = new Map<string, { count: number; subfolders: Set<string> }>();
  const swatcherFolders: Array<{ name: string; path: string; imageCount: number; hasSubfolders: boolean }> = [];
  let unclassifiedCount = 0;

  // Direct images
  const directImages = await listSharedFolderImages(sharedLink);
  const subfolders = await listSharedSubfolders(sharedLink);

  for (const img of directImages) {
    allFiles.push({
      id: img.id,
      name: img.name,
      mimeType: img.name.split(".").pop() ?? "unknown",
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

  // Subfolders
  for (const sub of subfolders) {
    const subSubs = await listSharedSubfolders(sharedLink, sub.path);
    const subImages = await listSharedFolderImages(sharedLink, sub.path);

    swatcherFolders.push({
      name: sub.name,
      path: sub.path,
      imageCount: subImages.length,
      hasSubfolders: subSubs.length > 0,
    });

    if (subSubs.length > 0) {
      for (const productFolder of subSubs) {
        const imgs = await listSharedFolderImages(sharedLink, productFolder.path);
        for (const img of imgs) {
          allFiles.push({
            id: img.id,
            name: img.name,
            mimeType: img.name.split(".").pop() ?? "unknown",
            sizeKB: Math.round(img.size / 1024),
            subfolder: `${sub.name}/${productFolder.name}`,
          });
        }
        const entry = productMap.get(productFolder.name.trim()) ?? { count: 0, subfolders: new Set<string>() };
        entry.count += imgs.length;
        entry.subfolders.add(sub.name);
        productMap.set(productFolder.name.trim(), entry);
      }
    } else {
      for (const img of subImages) {
        allFiles.push({
          id: img.id,
          name: img.name,
          mimeType: img.name.split(".").pop() ?? "unknown",
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

  const discoveredProducts: DiscoveredProduct[] = [...productMap.entries()]
    .map(([name, data]) => ({ name, imageCount: data.count, subfolders: [...data.subfolders] }))
    .sort((a, b) => b.imageCount - a.imageCount);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  let structure = "flat";
  if (subfolders.length > 0 && discoveredProducts.length > 1) structure = "collection";
  else if (subfolders.length > 0) structure = "single-product-with-subfolders";

  return {
    source: "dropbox",
    sharedLink,
    folderName,
    structure,
    totalFiles: allFiles.length,
    totalSubfolders: subfolders.length,
    swatcherFolders,
    discoveredProducts,
    unclassifiedImageCount: unclassifiedCount,
    files: allFiles,
    scanTimeSeconds: Number(elapsed),
  };
}

// ---------------------------------------------------------------------------
// Google Drive scanning
// ---------------------------------------------------------------------------

async function scanDrive(folderId: string) {
  const startTime = Date.now();

  const meta = await getFolderMeta(folderId);
  const folderName = meta.name;

  const allFiles: FolderFile[] = [];
  const productMap = new Map<string, { count: number; subfolders: Set<string> }>();
  const swatcherFolders: Array<{ name: string; id: string; imageCount: number; hasSubfolders: boolean }> = [];
  let unclassifiedCount = 0;

  const directImages = await listFolderImages(folderId);
  const subfolders = await listSubfolders(folderId);

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

  for (const sub of subfolders) {
    const subSubs = await listSubfolders(sub.id);
    const subImages = await listFolderImages(sub.id);

    swatcherFolders.push({
      name: sub.name,
      id: sub.id,
      imageCount: subImages.length + (subSubs.length > 0 ? -1 : 0),
      hasSubfolders: subSubs.length > 0,
    });

    if (subSubs.length > 0) {
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
      let totalInSub = 0;
      for (const ps of subSubs) {
        const psImgs = await listFolderImages(ps.id);
        totalInSub += psImgs.length;
      }
      const idx = swatcherFolders.findIndex((s) => s.id === sub.id);
      if (idx >= 0) swatcherFolders[idx].imageCount = totalInSub;
    } else {
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

  const discoveredProducts: DiscoveredProduct[] = [...productMap.entries()]
    .map(([name, data]) => ({ name, imageCount: data.count, subfolders: [...data.subfolders] }))
    .sort((a, b) => b.imageCount - a.imageCount);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  let structure = "flat";
  if (subfolders.length > 0 && discoveredProducts.length > 1) structure = "collection";
  else if (subfolders.length > 0) structure = "single-product-with-subfolders";

  return {
    source: "google_drive",
    folderId,
    folderName,
    structure,
    totalFiles: allFiles.length,
    totalSubfolders: subfolders.length,
    swatcherFolders,
    discoveredProducts,
    unclassifiedImageCount: unclassifiedCount,
    files: allFiles,
    scanTimeSeconds: Number(elapsed),
  };
}

// ---------------------------------------------------------------------------
// MCP Tool Registration
// ---------------------------------------------------------------------------

export function registerDiscoverFolderTool(server: McpServer): void {
  server.tool(
    "discover_folder",
    `Scan a Google Drive or Dropbox folder and return its structure. Fast, no image analysis.

Accepts either:
- A Google Drive folder ID (e.g., "1eKr3XlG3sbRxZYg3Pd0-sgDBRgakEItz")
- A Dropbox shared link URL (e.g., "https://www.dropbox.com/scl/fo/...")

Auto-detects the source. Returns: folder name, subfolder names (often swatcher names),
all image files with subfolder tags, and product groupings extracted from filenames.

Use this FIRST when a user provides a folder link. Review the structure, discuss
what you found, then decide which images to analyze and which products to ingest.`,
    {
      folderId: z.string().describe("Google Drive folder ID or Dropbox shared link URL"),
    },
    async ({ folderId }) => {
      try {
        const result = isDropboxUrl(folderId)
          ? await scanDropbox(folderId)
          : await scanDrive(folderId);

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error scanning folder: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
