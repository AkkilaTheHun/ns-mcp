/**
 * folder-sweep — run analyze_images over every shade folder in a staging
 * collection and write each folder's raw result to disk.
 *
 * Talks to the deployed MCP server over streamable HTTP rather than importing
 * the tools locally, because the deployed container holds a live Dropbox token
 * and this machine's DROPBOX_ACCESS_TOKEN is expired.
 *
 *   pnpm tsx scripts/folder-sweep.ts "/NailStuff Staging/Halloween 2026 - Staging"
 *
 * Results land in output/vision-ab/sweep/<folder>.json — feed them to
 * `vision-ab.ts cluster-sweep` to get the contamination report.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const HOST = process.env.MCP_HOST_OVERRIDE ?? "https://mcp.alphatec.co";
const TOKEN = process.env.MCP_AUTH_TOKEN;
if (!TOKEN) throw new Error("MCP_AUTH_TOKEN not set");

const OUT = join(process.cwd(), "output", "vision-ab", "sweep");
mkdirSync(OUT, { recursive: true });

let sessionId: string | undefined;
let rpcId = 0;

/** POST one JSON-RPC message; handles both plain-JSON and SSE-framed replies. */
async function rpc(method: string, params?: unknown, notify = false): Promise<any> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  if (!notify) body.id = ++rpcId;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(`${HOST}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (notify) return undefined;

  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text.slice(0, 400)}`);

  // Streamable HTTP may frame the reply as server-sent events.
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;

  const parsed = JSON.parse(payload);
  if (parsed.error) throw new Error(`${method} -> ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

async function connect() {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "folder-sweep", version: "1.0.0" },
  });
  await rpc("notifications/initialized", undefined, true);
  console.log(`[mcp] connected to ${HOST} (session ${sessionId?.slice(0, 8)}…)`);
}

/** Unwrap an MCP tool result into the JSON object the tool serialized. */
function unwrap(result: any): any {
  const text = result?.content?.find((c: any) => c.type === "text")?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * LOCAL=1 runs the analysis in-process against the working tree instead of the
 * deployed MCP server. Needed whenever the schema has changed locally but not
 * yet shipped — and it is faster, since there is no round-trip.
 */
async function runLocal(root: string, folders: string[]) {
  const [{ listOwnFolderImages, downloadOwnFile }, { analyzeWithRetry }, sharp] = await Promise.all([
    import("../src/dropbox/client.js"),
    import("../src/vision/analyze.js"),
    import("sharp").then((m) => m.default),
  ]);

  const CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY ?? 8);

  for (const name of folders) {
    const outFile = join(OUT, `${name.replace(/[^\w'\- ]/g, "_")}.json`);
    if (existsSync(outFile) && !process.env.FORCE) { console.log(`  skip (cached)  ${name}`); continue; }

    const t0 = Date.now();
    const files = await listOwnFolderImages(`${root}/${name}`);
    const images: unknown[] = new Array(files.length);
    let next = 0;
    let retries = 0;

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
      while (next < files.length) {
        const i = next++;
        const f = files[i];
        try {
          const raw = await downloadOwnFile(f.path);
          const rot = sharp(raw, { failOn: "none" }).rotate();
          const full = await rot.clone().resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
          const crop = await rot.clone().resize({ width: 800, height: 800, fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 92 }).toBuffer();
          const a = await analyzeWithRetry(full.toString("base64"), "image/jpeg",
            // Collection mode: the folder label is exactly the assumption under audit.
            { productName: "unknown shade", brand: "Cadillacquer", collectionMode: true },
            { provider: "claude", crop: { base64: crop.toString("base64"), mimeType: "image/jpeg" },
              attempts: 2, onRetry: () => { retries++; } });
          if (!process.env.NO_SNAP) {
            const { buildPixelIndex, snapAnalysis } = await import("../src/vision/snap.js");
            const idx = await buildPixelIndex(full);
            (a as any)._snap = snapAnalysis(idx, a);
          }
          images[i] = { filename: f.name, ...a };
        } catch (err) {
          images[i] = { filename: f.name, error: String(err) };
        }
      }
    }));

    writeFileSync(outFile, JSON.stringify({ folder: name, totalAnalyzed: files.length, images }, null, 2));
    console.log(`  ok  ${String(files.length).padStart(3)} images  ${((Date.now() - t0) / 1000).toFixed(0)}s${retries ? `  (${retries} retried)` : ""}  ${name}`);
  }
}

const root = process.argv[2] ?? "/NailStuff Staging/Halloween 2026 - Staging";
const dbxUrl = (path: string) =>
  "https://www.dropbox.com/home/" + path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

if (process.env.LOCAL) {
  const folders = (process.env.FOLDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!folders.length) throw new Error("LOCAL=1 requires FOLDERS=a,b,c");
  console.log(`[local] ${folders.length} folders under ${root}`);
  await runLocal(root, folders);
  console.log(`\nWrote ${OUT}`);
  process.exit(0);
}

await connect();

// Discover the shade folders. "_" prefixed folders (_Group Shots, _Needs Review)
// are intentionally included — they are exactly where strays end up.
const listing = unwrap(await rpc("tools/call", {
  name: "discover_folder",
  arguments: { folderId: dbxUrl(root) },
}));

const subfolders: string[] = (listing.subfolders ?? listing.swatcherFolders ?? [])
  .map((s: any) => (typeof s === "string" ? s : s.name));

if (!subfolders.length) {
  console.log("discover_folder returned no subfolders; pass folder names via FOLDERS env (comma-separated)");
}
const folders = process.env.FOLDERS ? process.env.FOLDERS.split(",").map((s) => s.trim()) : subfolders;

console.log(`[sweep] ${folders.length} folders under ${root}`);

for (const name of folders) {
  const outFile = join(OUT, `${name.replace(/[^\w'\- ]/g, "_")}.json`);
  if (existsSync(outFile) && !process.env.FORCE) {
    console.log(`  skip (cached)  ${name}`);
    continue;
  }
  const t0 = Date.now();
  try {
    const res = unwrap(await rpc("tools/call", {
      name: "analyze_images",
      arguments: {
        folderId: dbxUrl(`${root}/${name}`),
        // Deliberately withheld: passing the real shade name inflates the
        // model's confidence and biases the reading toward the folder label,
        // which is precisely what we are trying to audit.
        productName: "unknown shade",
        brand: "Cadillacquer",
        provider: "claude",
        fullWidth: 1400,
        closeup: true,
        structured: true,
        maxImages: 60,
      },
    }));
    writeFileSync(outFile, JSON.stringify({ folder: name, ...res }, null, 2));
    console.log(`  ok  ${String(res.totalAnalyzed ?? 0).padStart(3)} images  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err}`);
  }
}

console.log(`\nWrote ${OUT}`);
