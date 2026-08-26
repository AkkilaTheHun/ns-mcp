#!/usr/bin/env tsx
/**
 * Local image generation — the same gpt-image-2 calls the MCP makes, run
 * straight from your machine (no MCP transport, no proxy, no heartbeat).
 *
 * Reuses src/openai/images.ts, so reference-matching, JPEG transcode, and
 * downscaling behave exactly like the generate_image tool.
 *
 * Reads OPENAI_API_KEY from .env (same file the MCP uses). Set
 * OPENAI_IMAGE_MOCK=1 to render free local placeholders instead of billing.
 *
 * Usage:
 *   pnpm tsx scripts/gen-image.ts "a glossy holo polish bottle on marble"
 *   pnpm tsx scripts/gen-image.ts "..." --size 1024x1536 --quality high --n 2
 *   pnpm tsx scripts/gen-image.ts "..." --jpeg --max-dim 1024      # smaller files
 *   pnpm tsx scripts/gen-image.ts "..." --out ~/Desktop/renders
 *
 *   # Reference-matching (routes to the edits endpoint automatically):
 *   pnpm tsx scripts/gen-image.ts "three new shades in this same style" \
 *     --ref https://cdn.example.com/a.jpg --ref ./local/b.png
 *
 * Flags:
 *   --size <1024x1024|1024x1536|1536x1024|auto>   default 1024x1024
 *   --quality <low|medium|high|auto>              default auto
 *   --n <1-4>                                      default 1
 *   --out <dir>                                    default ./output/generated
 *   --ref <url-or-path>   (repeatable)             reference image(s)
 *   --jpeg                                         write .jpg instead of .png
 *   --jpeg-quality <1-100>                         default 80 (with --jpeg)
 *   --max-dim <px>                                 downscale longest side to this
 */
import "dotenv/config";
import { join, basename, extname, resolve } from "path";
import { mkdir, writeFile, readFile } from "fs/promises";
import sharp from "sharp";
import { generateImages, editImages, isMockMode, type ReferenceImage } from "../src/openai/images.js";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};
const mimeFromName = (name: string) => MIME_BY_EXT[extname(name).toLowerCase()] ?? "image/png";

// --- tiny arg parser: positional words = prompt; --flag [value] = options ---
function parseArgs(argv: string[]) {
  const opts: {
    prompt: string[]; refs: string[]; size?: string; quality?: string;
    n?: number; out?: string; jpeg: boolean; jpegQuality?: number; maxDim?: number;
  } = { prompt: [], refs: [], jpeg: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--ref": opts.refs.push(next()); break;
      case "--size": opts.size = next(); break;
      case "--quality": opts.quality = next(); break;
      case "--n": opts.n = parseInt(next(), 10); break;
      case "--out": opts.out = next(); break;
      case "--jpeg": opts.jpeg = true; break;
      case "--jpeg-quality": opts.jpegQuality = parseInt(next(), 10); break;
      case "--max-dim": opts.maxDim = parseInt(next(), 10); break;
      default: opts.prompt.push(a);
    }
  }
  return opts;
}

// Load a reference from an http(s) URL or a local file path.
async function loadRef(ref: string, idx: number): Promise<ReferenceImage> {
  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${ref}`);
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (ct.includes("text/html")) throw new Error(`got HTML, not an image: ${ref}`);
    const data = Buffer.from(await res.arrayBuffer());
    const filename = basename(new URL(ref).pathname) || `ref-${idx}.png`;
    return { data, filename, mimeType: ct || mimeFromName(filename) };
  }
  const data = await readFile(ref);
  const filename = basename(ref) || `ref-${idx}.png`;
  return { data, filename, mimeType: mimeFromName(filename) };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const prompt = o.prompt.join(" ").trim();
  if (!prompt) {
    console.error('No prompt. Usage: pnpm tsx scripts/gen-image.ts "your prompt" [--ref url|path] [--size ...] [--quality ...] [--n N] [--jpeg] [--out dir]');
    process.exit(1);
  }

  const size = o.size ?? "1024x1024";
  const quality = o.quality ?? "auto";
  const n = o.n ?? 1;
  const references = await Promise.all(o.refs.map((r, i) => loadRef(r, i)));

  console.log(`${isMockMode() ? "[MOCK] " : ""}Generating ${n} image(s) @ ${size} q=${quality}${references.length ? ` with ${references.length} reference(s)` : ""}`);
  console.log(`Prompt: "${prompt}"`);
  const t0 = Date.now();

  const genOpts = { prompt, size, quality, n };
  const images = references.length > 0
    ? await editImages({ ...genOpts, references })
    : await generateImages(genOpts);

  console.log(`Got ${images.length} image(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const outDir = o.out ? resolve(o.out.replace(/^~/, process.env.HOME ?? "~")) : join(process.cwd(), "output", "generated");
  await mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = o.jpeg ? "jpg" : "png";
  const maxDim = o.maxDim ?? 4096;

  for (let i = 0; i < images.length; i++) {
    let outB64 = images[i].base64;
    if (o.jpeg || maxDim < 4096) {
      let pipeline = sharp(Buffer.from(images[i].base64, "base64"));
      if (maxDim < 4096) pipeline = pipeline.resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true });
      if (o.jpeg) pipeline = pipeline.jpeg({ quality: o.jpegQuality ?? 80, mozjpeg: true });
      outB64 = (await pipeline.toBuffer()).toString("base64");
    }
    const path = join(outDir, `gen-${stamp}-${i + 1}.${ext}`);
    await writeFile(path, Buffer.from(outB64, "base64"));
    console.log(`Wrote ${path}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
