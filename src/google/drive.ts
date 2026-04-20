import { google, type drive_v3 } from "googleapis";
import { getServiceAccountKey } from "./auth.js";
import { GoogleAuth } from "googleapis-common";

let cachedDriveAuth: GoogleAuth | undefined;
let cachedDrive: drive_v3.Drive | undefined;

const SUBJECT = "admin@nailstuff.co";

function getDriveAuth(): GoogleAuth {
  if (!cachedDriveAuth) {
    cachedDriveAuth = new GoogleAuth({
      credentials: getServiceAccountKey(),
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      clientOptions: { subject: SUBJECT },
    });
  }
  return cachedDriveAuth;
}

function getDrive(): drive_v3.Drive {
  if (!cachedDrive) {
    cachedDrive = google.drive({ version: "v3", auth: getDriveAuth() });
  }
  return cachedDrive;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  parentId: string;
}

/** List image files in a Drive folder. */
export async function listFolderImages(folderId: string): Promise<DriveFile[]> {
  const drive = getDrive();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      pageSize: 100,
      fields: "nextPageToken, files(id, name, mimeType, size, parents)",
      pageToken,
    });

    for (const f of res.data.files ?? []) {
      // Enforce §12a product↔folder binding: parent must match folderId
      const parentId = (f.parents ?? [])[0];
      if (parentId !== folderId) continue;

      files.push({
        id: f.id!,
        name: f.name!,
        mimeType: f.mimeType!,
        size: Number(f.size ?? 0),
        parentId,
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

/** Download a file's content as a Buffer. */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const drive = getDrive();
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

/** List immediate subfolders of a folder. */
export async function listSubfolders(folderId: string): Promise<Array<{ id: string; name: string }>> {
  const drive = getDrive();
  const folders: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      pageSize: 100,
      fields: "nextPageToken, files(id, name)",
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      folders.push({ id: f.id!, name: f.name! });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return folders;
}

/**
 * Recursively find all images under a folder, traversing subfolders.
 * Returns images tagged with their full folder path for grouping.
 */
export async function listAllImagesRecursive(
  folderId: string,
  folderPath = "",
): Promise<Array<DriveFile & { folderPath: string }>> {
  const images: Array<DriveFile & { folderPath: string }> = [];

  // Get direct images
  const directImages = await listFolderImages(folderId);
  for (const img of directImages) {
    images.push({ ...img, folderPath });
  }

  // Get subfolders and recurse
  const subfolders = await listSubfolders(folderId);
  for (const sub of subfolders) {
    const subPath = folderPath ? `${folderPath}/${sub.name}` : sub.name;
    const subImages = await listAllImagesRecursive(sub.id, subPath);
    images.push(...subImages);
  }

  return images;
}

/**
 * Discover product groupings in a folder structure.
 * Handles common vendor folder layouts:
 * - Flat: all product images directly in folder
 * - Per-product subfolders: Suzie/Blazing Evening Sky/img.jpg
 * - Mixed swatcher folders: Yuliia/Blazing Evening Sky_1.jpg
 */
export async function discoverProductImages(
  folderId: string,
): Promise<{
  collectionImages: DriveFile[];
  products: Map<string, DriveFile[]>;
  structure: string;
}> {
  const subfolders = await listSubfolders(folderId);
  const directImages = await listFolderImages(folderId);

  // Case 1: No subfolders — flat single-product folder
  if (subfolders.length === 0) {
    return {
      collectionImages: [],
      products: new Map([["_all", directImages]]),
      structure: "flat",
    };
  }

  // Case 2: Has subfolders — collection folder
  // Direct images are collection-level (collages, group shots)
  const collectionImages = directImages;
  const products = new Map<string, DriveFile[]>();

  for (const sub of subfolders) {
    const subSubfolders = await listSubfolders(sub.id);

    if (subSubfolders.length > 0) {
      // Sub has its own subfolders → per-product subfolders (e.g., Suzie/Blazing Evening Sky/)
      for (const productFolder of subSubfolders) {
        const imgs = await listFolderImages(productFolder.id);
        const name = productFolder.name.trim();
        const existing = products.get(name) ?? [];
        existing.push(...imgs);
        products.set(name, existing);
      }
    } else {
      // Sub has only images → mixed by filename (e.g., Yuliia/Blazing Evening Sky_1.jpg)
      const imgs = await listFolderImages(sub.id);
      for (const img of imgs) {
        const name = extractProductName(img.name);
        if (!name) continue; // skip unclassifiable (IMG_####.jpg etc.)
        const existing = products.get(name) ?? [];
        existing.push(img);
        products.set(name, existing);
      }
    }
  }

  return { collectionImages, products, structure: "collection" };
}

/**
 * Extract product name from a filename.
 * Handles patterns like:
 * - "Blazing Evening Sky_1.jpg" → "Blazing Evening Sky"
 * - "Blazing Evening Sky 1.jpeg" → "Blazing Evening Sky"
 * - "Pumpkin Fields_2.JPEG" → "Pumpkin Fields"
 * - "IMG_1234.jpg" → null (unclassifiable)
 */
function extractProductName(filename: string): string | null {
  // Strip extension
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

/** Get metadata for a folder (name, parents). */
export async function getFolderMeta(folderId: string): Promise<{ name: string; parents: string[] }> {
  const drive = getDrive();
  const res = await drive.files.get({
    fileId: folderId,
    fields: "name, parents, mimeType",
  });
  if (res.data.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error(`${folderId} is not a folder (got ${res.data.mimeType})`);
  }
  return {
    name: res.data.name!,
    parents: res.data.parents ?? [],
  };
}
