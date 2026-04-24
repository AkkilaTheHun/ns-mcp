/**
 * Dropbox API client for shared folder access.
 *
 * Uses the Dropbox HTTP API v2 to list shared folder contents
 * and download files. Requires DROPBOX_ACCESS_TOKEN env var.
 */

import { readFileSync } from "fs";

const DROPBOX_API = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT = "https://content.dropboxapi.com/2";

let cachedToken: string | undefined;

function getToken(): string {
  if (cachedToken) return cachedToken;

  // Try env var first
  if (process.env.DROPBOX_ACCESS_TOKEN) {
    cachedToken = process.env.DROPBOX_ACCESS_TOKEN.trim();
    return cachedToken;
  }

  // Try file path (for long tokens that don't fit in TrueNAS env var fields)
  const tokenFile = process.env.DROPBOX_TOKEN_FILE;
  if (tokenFile) {
    try {
      cachedToken = readFileSync(tokenFile, "utf-8").trim();
      return cachedToken;
    } catch (err) {
      throw new Error(`Failed to read Dropbox token from ${tokenFile}: ${err}`);
    }
  }

  throw new Error("Set DROPBOX_ACCESS_TOKEN env var or DROPBOX_TOKEN_FILE path");
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DropboxEntry {
  ".tag": "file" | "folder";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  size?: number;
  is_downloadable?: boolean;
  content_hash?: string;
}

export interface DropboxFile {
  id: string;
  name: string;
  path: string;
  size: number;
}

// ---------------------------------------------------------------------------
// Shared link folder listing
// ---------------------------------------------------------------------------

/**
 * List contents of a Dropbox shared folder link.
 * Returns files and subfolders at the given path within the shared link.
 */
export async function listSharedFolder(
  sharedLink: string,
  subPath = "",
): Promise<{ entries: DropboxEntry[]; hasMore: boolean; cursor?: string }> {
  const allEntries: DropboxEntry[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  // Initial request
  const res = await fetch(`${DROPBOX_API}/files/list_folder`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      path: subPath || "",
      shared_link: { url: cleanSharedLink(sharedLink) },
      limit: 2000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dropbox list_folder failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    entries: DropboxEntry[];
    cursor: string;
    has_more: boolean;
  };

  allEntries.push(...data.entries);
  hasMore = data.has_more;
  cursor = data.cursor;

  // Paginate if needed
  while (hasMore && cursor) {
    const contRes = await fetch(`${DROPBOX_API}/files/list_folder/continue`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ cursor }),
    });

    if (!contRes.ok) break;

    const contData = (await contRes.json()) as {
      entries: DropboxEntry[];
      cursor: string;
      has_more: boolean;
    };

    allEntries.push(...contData.entries);
    hasMore = contData.has_more;
    cursor = contData.cursor;
  }

  return { entries: allEntries, hasMore, cursor };
}

/**
 * List only image files in a shared folder (optionally at a sub-path).
 */
export async function listSharedFolderImages(
  sharedLink: string,
  subPath = "",
): Promise<DropboxFile[]> {
  const { entries } = await listSharedFolder(sharedLink, subPath);

  return entries
    .filter((e) => {
      if (e[".tag"] !== "file") return false;
      const ext = e.name.toLowerCase().split(".").pop() ?? "";
      return ["jpg", "jpeg", "png", "webp", "heic", "heif", "tiff", "gif", "avif"].includes(ext);
    })
    .map((e) => ({
      id: e.id,
      name: e.name,
      path: e.path_display,
      size: e.size ?? 0,
    }));
}

/**
 * List subfolders in a shared folder (optionally at a sub-path).
 */
export async function listSharedSubfolders(
  sharedLink: string,
  subPath = "",
): Promise<Array<{ name: string; path: string }>> {
  const { entries } = await listSharedFolder(sharedLink, subPath);

  return entries
    .filter((e) => e[".tag"] === "folder")
    .map((e) => ({
      name: e.name,
      path: e.path_display,
    }));
}

// ---------------------------------------------------------------------------
// Write operations (own folder only — requires files.content.write scope)
// ---------------------------------------------------------------------------

/**
 * Create a folder in the user's own Dropbox.
 * Creates parent folders automatically if they don't exist.
 */
export async function createDropboxFolder(path: string): Promise<{ path: string; name: string }> {
  const res = await fetch(`${DROPBOX_API}/files/create_folder_v2`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ path, autorename: false }),
  });

  if (!res.ok) {
    const body = await res.text();
    // Ignore "folder already exists" errors
    if (body.includes("path/conflict/folder")) {
      const name = path.split("/").pop() ?? path;
      return { path, name };
    }
    throw new Error(`Dropbox create_folder failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { metadata: { path_display: string; name: string } };
  return { path: data.metadata.path_display, name: data.metadata.name };
}

/**
 * Copy a file within the user's own Dropbox.
 * to_path must include the full path with filename.
 */
export async function copyDropboxFile(
  fromPath: string,
  toPath: string,
): Promise<{ path: string; name: string }> {
  const res = await fetch(`${DROPBOX_API}/files/copy_v2`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ from_path: fromPath, to_path: toPath, autorename: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dropbox copy failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { metadata: { path_display: string; name: string } };
  return { path: data.metadata.path_display, name: data.metadata.name };
}

/**
 * Move a file within the user's own Dropbox.
 */
export async function moveDropboxFile(
  fromPath: string,
  toPath: string,
): Promise<{ path: string; name: string }> {
  const res = await fetch(`${DROPBOX_API}/files/move_v2`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ from_path: fromPath, to_path: toPath, autorename: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dropbox move failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { metadata: { path_display: string; name: string } };
  return { path: data.metadata.path_display, name: data.metadata.name };
}

// ---------------------------------------------------------------------------
// File download
// ---------------------------------------------------------------------------

/**
 * Download a file from a Dropbox shared link.
 * Uses the path within the shared folder to identify the file.
 */
export async function downloadSharedFile(
  sharedLink: string,
  filePath: string,
): Promise<Buffer> {
  const res = await fetch(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Dropbox-API-Arg": JSON.stringify({
        url: cleanSharedLink(sharedLink),
        path: filePath,
      }),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dropbox download failed (${res.status}): ${body.slice(0, 300)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Get metadata for a shared link (folder name, etc.)
 */
export async function getSharedLinkMetadata(
  sharedLink: string,
): Promise<{ name: string; tag: string; path?: string }> {
  const res = await fetch(`${DROPBOX_API}/sharing/get_shared_link_metadata`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url: cleanSharedLink(sharedLink) }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dropbox metadata failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    name: string;
    ".tag": string;
    path_lower?: string;
  };

  return { name: data.name, tag: data[".tag"], path: data.path_lower };
}

// ---------------------------------------------------------------------------
// Own folder listing (not shared links — your own Dropbox)
// ---------------------------------------------------------------------------

/**
 * List contents of a folder in the authenticated user's own Dropbox.
 * Path should be like "" (root), "/Take It Easy", "/folder/subfolder", etc.
 */
export async function listOwnFolder(
  path: string,
): Promise<{ entries: DropboxEntry[]; hasMore: boolean }> {
  const allEntries: DropboxEntry[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  const res = await fetch(`${DROPBOX_API}/files/list_folder`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      path: path === "/" ? "" : path,
      limit: 2000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dropbox list_folder failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    entries: DropboxEntry[];
    cursor: string;
    has_more: boolean;
  };

  allEntries.push(...data.entries);
  hasMore = data.has_more;
  cursor = data.cursor;

  while (hasMore && cursor) {
    const contRes = await fetch(`${DROPBOX_API}/files/list_folder/continue`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ cursor }),
    });
    if (!contRes.ok) break;
    const contData = (await contRes.json()) as {
      entries: DropboxEntry[];
      cursor: string;
      has_more: boolean;
    };
    allEntries.push(...contData.entries);
    hasMore = contData.has_more;
    cursor = contData.cursor;
  }

  return { entries: allEntries, hasMore };
}

/**
 * List image files in the authenticated user's own Dropbox folder.
 */
export async function listOwnFolderImages(path: string): Promise<DropboxFile[]> {
  const { entries } = await listOwnFolder(path);
  return entries
    .filter((e) => {
      if (e[".tag"] !== "file") return false;
      const ext = e.name.toLowerCase().split(".").pop() ?? "";
      return ["jpg", "jpeg", "png", "webp", "heic", "heif", "tiff", "gif", "avif"].includes(ext);
    })
    .map((e) => ({ id: e.id, name: e.name, path: e.path_display, size: e.size ?? 0 }));
}

/**
 * List subfolders in the authenticated user's own Dropbox folder.
 */
export async function listOwnSubfolders(path: string): Promise<Array<{ name: string; path: string }>> {
  const { entries } = await listOwnFolder(path);
  return entries
    .filter((e) => e[".tag"] === "folder")
    .map((e) => ({ name: e.name, path: e.path_display }));
}

/**
 * Download a file from the authenticated user's own Dropbox.
 */
export async function downloadOwnFile(path: string): Promise<Buffer> {
  const res = await fetch(`${DROPBOX_CONTENT}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dropbox download failed (${res.status}): ${body.slice(0, 300)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clean a Dropbox shared link URL - strip query params that cause issues.
 * The API wants the base URL with rlkey but not dl/st/e params.
 */
function cleanSharedLink(url: string): string {
  const parsed = new URL(url);
  const rlkey = parsed.searchParams.get("rlkey");
  // Rebuild with just the essential params
  const clean = `${parsed.origin}${parsed.pathname}`;
  return rlkey ? `${clean}?rlkey=${rlkey}&dl=0` : `${clean}?dl=0`;
}
