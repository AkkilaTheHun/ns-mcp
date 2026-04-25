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
  listOwnFolderImages,
  listOwnSubfolders,
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

  // Determine access mode: shared link vs own folder
  // Try shared link first, fall back to own-folder path if restricted
  let folderName: string;
  let useOwnFolder = false;
  let ownPath = "";

  try {
    const meta = await getSharedLinkMetadata(sharedLink);
    folderName = meta.name;
  } catch (err) {
    // If shared link fails (restricted_content, etc.), try extracting a path
    // from the URL and accessing as own folder
    const pathMatch = sharedLink.match(/dropbox\.com\/home\/(.+?)(?:\?|$)/);
    if (pathMatch) {
      ownPath = "/" + decodeURIComponent(pathMatch[1]);
      folderName = ownPath.split("/").pop() ?? "Unknown";
      useOwnFolder = true;
    } else {
      throw err;
    }
  }

  // Helper functions that work for both modes
  const getImages = (subPath: string) =>
    useOwnFolder ? listOwnFolderImages(subPath || ownPath) : listSharedFolderImages(sharedLink, subPath);
  const getSubfolders = (subPath: string) =>
    useOwnFolder ? listOwnSubfolders(subPath || ownPath) : listSharedSubfolders(sharedLink, subPath);

  const allFiles: FolderFile[] = [];
  const productMap = new Map<string, { count: number; subfolders: Set<string> }>();
  const swatcherFolders: Array<{ name: string; path: string; url?: string; imageCount: number; hasSubfolders: boolean }> = [];
  let unclassifiedCount = 0;

  // Helper to build a Dropbox /home/ URL from a path
  const toDropboxUrl = (path: string) =>
    `https://www.dropbox.com/home/${encodeURIComponent(path.replace(/^\//, "")).replace(/%2F/g, "/")}`;

  // Direct images
  const directImages = await getImages("");
  const subfolders = await getSubfolders("");

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
    const subSubs = await getSubfolders(sub.path);
    const subImages = await getImages(sub.path);

    swatcherFolders.push({
      name: sub.name,
      path: sub.path,
      url: toDropboxUrl(sub.path),
      imageCount: subImages.length,
      hasSubfolders: subSubs.length > 0,
    });

    if (subSubs.length > 0) {
      for (const productFolder of subSubs) {
        const imgs = await getImages(productFolder.path);
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

  const allProducts = [...productMap.entries()]
    .map(([name, data]) => ({ name, imageCount: data.count }))
    .sort((a, b) => b.imageCount - a.imageCount);

  // If most "products" are unique (camera filenames), skip the list entirely
  const hasRealGroupings = allProducts.some((p) => p.imageCount > 2);
  const discoveredProducts = hasRealGroupings ? allProducts.slice(0, 30) : [];

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
    // files array omitted to save tokens — use analyze_images to get per-file details
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

  const allProducts = [...productMap.entries()]
    .map(([name, data]) => ({ name, imageCount: data.count }))
    .sort((a, b) => b.imageCount - a.imageCount);

  // If most "products" are unique (camera filenames), skip the list entirely
  const hasRealGroupings = allProducts.some((p) => p.imageCount > 2);
  const discoveredProducts = hasRealGroupings ? allProducts.slice(0, 30) : [];

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
    // files array omitted to save tokens — use analyze_images to get per-file details
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
