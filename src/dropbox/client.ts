/**
 * Dropbox API client for shared folder access.
 *
 * Uses the Dropbox HTTP API v2 to list shared folder contents
 * and download files. Requires DROPBOX_ACCESS_TOKEN env var.
 */

import { readFileSync } from "fs";

const DROPBOX_API = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT = "https://content.dropboxapi.com/2";

/**
 * Every Dropbox call goes through here so none of them can hang forever.
 *
 * Unbounded fetches took the whole ingest chain offline for ~9 minutes with no
 * log output when a malformed token made auth fail: undici's default
 * headersTimeout is 300s, and folder resolution issues two calls back to back.
 * A stalled network call must become a fast, named error, not silence.
 */
const API_TIMEOUT_MS = Number(process.env.DROPBOX_TIMEOUT_MS ?? "30000");
const CONTENT_TIMEOUT_MS = Number(process.env.DROPBOX_CONTENT_TIMEOUT_MS ?? "120000");

async function dbxFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number = API_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`Dropbox request timed out after ${timeoutMs}ms: ${url.replace(DROPBOX_API, "").replace(DROPBOX_CONTENT, "")}`);
    }
    throw err;
  }
}

let cachedToken: string | undefined;

/**
 * Accept both a bare token and an env-style `DROPBOX_ACCESS_TOKEN=...` line,
 * then sanity-check the result.
 *
 * The token file was once saved in env format. `.trim()` alone happily produced
 * a 1502-character "token" that was sent as a bearer credential, so every
 * Dropbox call failed auth for four hours before anyone noticed. A credential
 * that cannot possibly be valid must fail loudly at the source, not silently on
 * every downstream call.
 */
function normalizeToken(raw: string, source: string): string {
  let t = raw.trim();

  // Strip an env-file assignment prefix and any surrounding quotes.
  const assigned = t.match(/^[A-Z_][A-Z0-9_]*\s*=\s*(.*)$/s);
  if (assigned) {
    t = assigned[1].trim();
    console.warn(`[dropbox] ${source} contained an env-style assignment; using the value after "=". Store only the bare token.`);
  }
  t = t.replace(/^["']|["']$/g, "").trim();

  if (!t) throw new Error(`Dropbox token from ${source} is empty`);
  if (/\s/.test(t)) {
    throw new Error(`Dropbox token from ${source} contains whitespace (length ${t.length}) — it is not a bare token`);
  }
  if (!/^sl\.|^[A-Za-z0-9_-]{20,}$/.test(t)) {
    throw new Error(`Dropbox token from ${source} does not look like a Dropbox token (starts with "${t.slice(0, 8)}")`);
  }
  return t;
}

function getToken(): string {
  if (cachedToken) return cachedToken;

  // Try env var first
  if (process.env.DROPBOX_ACCESS_TOKEN) {
    cachedToken = normalizeToken(process.env.DROPBOX_ACCESS_TOKEN, "DROPBOX_ACCESS_TOKEN");
    return cachedToken;
  }

  // Try file path (for long tokens that don't fit in TrueNAS env var fields)
  const tokenFile = process.env.DROPBOX_TOKEN_FILE;
  if (tokenFile) {
    let raw: string;
    const startedAt = Date.now();
    try {
      raw = readFileSync(tokenFile, "utf-8");
    } catch (err) {
      throw new Error(`Failed to read Dropbox token from ${tokenFile}: ${err}`);
    }
    const elapsed = Date.now() - startedAt;
    // This read is synchronous and blocks the entire event loop. On a cold
    // bind-mounted dataset it can take seconds, during which the process
    // answers nothing at all — which reads as a hang with no log output.
    // warmDropboxToken() moves it to startup; this warns if it ever happens
    // on a request path anyway.
    if (elapsed > 250) {
      console.warn(`[dropbox] Token read from ${tokenFile} blocked the event loop for ${elapsed}ms`);
    }
    cachedToken = normalizeToken(raw, tokenFile);
    return cachedToken;
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
  const res = await dbxFetch(`${DROPBOX_API}/files/list_folder`, {
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
    const contRes = await dbxFetch(`${DROPBOX_API}/files/list_folder/continue`, {
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
  const res = await dbxFetch(`${DROPBOX_API}/files/create_folder_v2`, {
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
  opts: { autorename?: boolean; retries?: number } = {},
): Promise<{ path: string; name: string; skipped?: boolean }> {
  // autorename defaults to FALSE so a re-run is idempotent: an existing target
  // means the copy already happened, not that we should make a second copy.
  const autorename = opts.autorename ?? false;
  const retries = opts.retries ?? 6;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await dbxFetch(`${DROPBOX_API}/files/copy_v2`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ from_path: fromPath, to_path: toPath, autorename }),
    });

    if (res.ok) {
      const data = (await res.json()) as { metadata: { path_display: string; name: string } };
      return { path: data.metadata.path_display, name: data.metadata.name };
    }

    const body = await res.text();

    // Already there — treat as done so reruns are safe.
    if (body.includes("to/conflict/file")) {
      return { path: toPath, name: toPath.split("/").pop() ?? toPath, skipped: true };
    }

    // Dropbox rate-limits writes aggressively and returns two distinct 429s:
    // `too_many_requests` carries a retry_after in seconds, while
    // `too_many_write_operations` is namespace lock contention with
    // retry_after 0 and needs a short backoff of our own choosing.
    if (res.status === 429) {
      if (attempt === retries) throw new Error(`Dropbox copy rate-limited after ${retries} retries: ${body.slice(0, 200)}`);
      let waitMs = 500 * 2 ** attempt;
      try {
        const parsed = JSON.parse(body) as { error?: { retry_after?: number } };
        const ra = parsed.error?.retry_after;
        if (typeof ra === "number" && ra > 0) waitMs = ra * 1000;
      } catch { /* use the backoff */ }
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    throw new Error(`Dropbox copy failed (${res.status}): ${body.slice(0, 300)}`);
  }

  throw new Error("unreachable");
}

/**
 * Delete a file or folder in the user's own Dropbox.
 *
 * Dropbox moves the item to the account's "Deleted files" area rather than
 * destroying it, so this is recoverable from the Dropbox UI.
 */
export async function deleteDropboxFile(path: string): Promise<{ path: string }> {
  const res = await dbxFetch(`${DROPBOX_API}/files/delete_v2`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Already gone is success for our purposes.
    if (body.includes("path_lookup/not_found")) return { path };
    throw new Error(`Dropbox delete failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return { path };
}

/**
 * Move a file within the user's own Dropbox.
 */
export async function moveDropboxFile(
  fromPath: string,
  toPath: string,
): Promise<{ path: string; name: string }> {
  const res = await dbxFetch(`${DROPBOX_API}/files/move_v2`, {
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
  const res = await dbxFetch(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Dropbox-API-Arg": JSON.stringify({
        url: cleanSharedLink(sharedLink),
        path: filePath,
      }),
    },
  }, CONTENT_TIMEOUT_MS);

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
  const res = await dbxFetch(`${DROPBOX_API}/sharing/get_shared_link_metadata`, {
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

  const res = await dbxFetch(`${DROPBOX_API}/files/list_folder`, {
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
    const contRes = await dbxFetch(`${DROPBOX_API}/files/list_folder/continue`, {
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
  const res = await dbxFetch(`${DROPBOX_CONTENT}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  }, CONTENT_TIMEOUT_MS);

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


/**
 * Resolve and cache the Dropbox token at startup.
 *
 * getToken() is lazy, synchronous, and reads from a bind-mounted dataset. Left
 * to the first request, that read blocks the event loop mid-call: the first
 * Dropbox-touching request after a restart stalls with no log line, and a small
 * warm-up call "fixes" it by paying the cost early. Pay it at boot instead, and
 * surface a malformed token as a startup error rather than a runtime hang.
 */
export function warmDropboxToken(): void {
  if (!process.env.DROPBOX_ACCESS_TOKEN && !process.env.DROPBOX_TOKEN_FILE) {
    console.warn("[dropbox] No DROPBOX_ACCESS_TOKEN or DROPBOX_TOKEN_FILE set — Dropbox calls will fail");
    return;
  }
  const startedAt = Date.now();
  try {
    const t = getToken();
    console.log(`[dropbox] Token loaded at startup (${t.length} chars, ${Date.now() - startedAt}ms)`);
  } catch (err) {
    console.error(`[dropbox] FATAL: token unusable — Dropbox calls will fail: ${err}`);
  }
}
