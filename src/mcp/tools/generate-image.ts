import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join, basename, extname } from "path";
import { mkdir, writeFile, readFile } from "fs/promises";
import sharp from "sharp";
import { generateImages, editImages, isMockMode, type ReferenceImage } from "../../openai/images.js";

const OUTPUT_DIR = join(process.cwd(), "output", "generated");

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const mimeFromName = (name: string) => MIME_BY_EXT[extname(name).toLowerCase()] ?? "image/png";

// Load reference images from any mix of URLs, local paths, or base64.
async function loadReferences(input: {
  urls?: string[];
  paths?: string[];
  images?: Array<{ data: string; filename?: string }>;
}): Promise<{ references: ReferenceImage[]; errors: string[] }> {
  const references: ReferenceImage[] = [];
  const errors: string[] = [];
  let idx = 0;

  for (const url of input.urls ?? []) {
    idx++;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (ct.includes("text/html")) throw new Error("got HTML, not an image — needs a direct image URL");
      const data = Buffer.from(await res.arrayBuffer());
      const filename = basename(new URL(url).pathname) || `ref-${idx}.png`;
      references.push({ data, filename, mimeType: ct || mimeFromName(filename) });
    } catch (e) {
      errors.push(`url ${url}: ${String(e)}`);
    }
  }

  for (const p of input.paths ?? []) {
    idx++;
    try {
      const data = await readFile(p);
      const filename = basename(p) || `ref-${idx}.png`;
      references.push({ data, filename, mimeType: mimeFromName(filename) });
    } catch (e) {
      errors.push(`path ${p}: ${String(e)}`);
    }
  }

  for (const im of input.images ?? []) {
    idx++;
    try {
      const data = Buffer.from(im.data, "base64");
      if (!data.length) throw new Error("empty or invalid base64");
      const filename = im.filename || `ref-${idx}.png`;
      references.push({ data, filename, mimeType: mimeFromName(filename) });
    } catch (e) {
      errors.push(`image ${im.filename ?? idx}: ${String(e)}`);
    }
  }

  return { references, errors };
}

// Some MCP clients stringify scalars ("true", "1"). Coerce those forms so calls
// don't fail validation, while still rejecting genuinely invalid input.
const flexBool = (def: boolean) =>
  z.preprocess((v) => {
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true") return true;
      if (s === "false") return false;
    }
    return v;
  }, z.boolean()).default(def).optional();

const flexInt = (min: number, max: number, def: number) =>
  z.preprocess((v) => {
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return v;
  }, z.number().int().min(min).max(max)).default(def).optional();

// Clients sometimes send an array param as a string — a single value, or a
// JSON-encoded array/object. Coerce those into an array before validation.
const coerceArray = (v: unknown) => {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s === "") return v;
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      /* not JSON — fall through to single-value wrap */
    }
  }
  return [s];
};
const flexArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(coerceArray, z.array(item)).optional();

export function registerGenerateImageTool(server: McpServer): void {
  server.tool(
    "generate_image",
    `Generate images from a text prompt using OpenAI's gpt-image-2 model.
Returns a viewable image block and writes each PNG to disk.

IMPORTANT — files are written by the MACHINE RUNNING THE MCP. When this server
runs remotely (e.g. in Docker), the default output/generated/ path lives inside
the container and is NOT reachable by the caller. Two ways to get the file:
  • BEST: pass output_dir set to a path the MCP can write that you can also
    read (e.g. a shared/mounted volume). The PNG lands there directly — no
    base64, no size limits.
  • Fallback: pass return_base64:true to get the bytes inline (only viable for
    small images; a full 1024x1024 PNG can exceed token/output limits).

REFERENCE IMAGES: pass reference_urls / reference_paths / reference_images to
generate a NEW image that matches or combines existing pictures (e.g. "a bottle
in this exact shade", or composing several products into one scene). This routes
to gpt-image-2's edit endpoint. Reference inputs are processed at high fidelity,
so they add input-token cost.

Use for mockups, concept art, marketing visuals, or product imagery ideas.
Note: gpt-image-2 always returns PNG; size/quality control resolution and cost.`,
    {
      prompt: z.string().min(1).describe("Text description of the image to generate"),
      reference_urls: flexArray(z.string().url())
        .describe("HTTPS image URLs to use as visual references (e.g. an existing product photo to match a shade). Downloaded by the MCP and sent to gpt-image-2's edit endpoint. Accepts an array, a single URL string, or a JSON array string."),
      reference_paths: flexArray(z.string())
        .describe("Image file paths the MCP process can read (e.g. on a mounted/shared volume) to use as references. Accepts an array or a single string."),
      reference_images: flexArray(z.object({
        data: z.string().describe("Base64-encoded image bytes"),
        filename: z.string().optional().describe("Optional name; extension hints the format (png/jpeg/webp)"),
      }))
        .describe("Base64 reference images. Prefer reference_urls/reference_paths — large base64 inputs can exceed tool input limits."),
      output_dir: z.string().optional()
        .describe("Absolute directory the MCP should write the PNG(s) into, instead of the default container path. Use a path the MCP process can write AND you can read (e.g. a mounted/shared volume) to receive the file directly without base64. Created if it doesn't exist."),
      size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).default("1024x1024").optional()
        .describe("Output dimensions (default 1024x1024). 'auto' lets the model choose."),
      quality: z.enum(["low", "medium", "high", "auto"]).default("auto").optional()
        .describe("Render quality — higher costs more (default 'auto')"),
      n: flexInt(1, 4, 1)
        .describe("How many images to generate (1-4, default 1)"),
      preview: flexBool(true)
        .describe("If true (default), also return a viewable image block; set false to return only file paths"),
      format: z.enum(["png", "jpeg"]).default("png").optional()
        .describe("Output file format (default png). 'jpeg' is much smaller — use it to keep saved files light and to make return_base64 fit within output/token limits."),
      jpeg_quality: flexInt(1, 100, 80)
        .describe("JPEG quality 1-100 (default 80), only used when format=jpeg. Lower = smaller file."),
      max_dimension: flexInt(64, 4096, 4096)
        .describe("If set below the generated size, the image is downscaled so its longest side is at most this many px (preserving aspect ratio). Handy with format=jpeg to shrink base64 enough to fit output limits. Default 4096 (effectively no downscale)."),
      return_base64: flexBool(false)
        .describe("If true, append a JSON text block with each image's base64 ({filename, mimeType, base64}) so the caller can decode and save the file itself. For remote MCPs prefer output_dir; if you must use base64, combine format=jpeg + a smaller max_dimension so it fits output/token limits. Accepts true/false (boolean or string)."),
    },
    async ({ prompt, size, quality, n, preview, return_base64, output_dir, format, jpeg_quality, max_dimension, reference_urls, reference_paths, reference_images }) => {
      try {
        const refsRequested = (reference_urls?.length ?? 0) + (reference_paths?.length ?? 0) + (reference_images?.length ?? 0) > 0;
        const { references, errors: refErrors } = refsRequested
          ? await loadReferences({ urls: reference_urls, paths: reference_paths, images: reference_images })
          : { references: [], errors: [] };

        if (refsRequested && references.length === 0) {
          return {
            content: [{ type: "text" as const, text: `Could not load any reference image(s):\n${refErrors.join("\n")}` }],
            isError: true,
          };
        }

        const genOpts = { prompt, size: size ?? "1024x1024", quality: quality ?? "auto", n: n ?? 1 };
        const images = references.length > 0
          ? await editImages({ ...genOpts, references })
          : await generateImages(genOpts);

        if (!images.length) {
          return { content: [{ type: "text" as const, text: "Error: model returned no image data" }], isError: true };
        }

        const targetDir = output_dir?.trim() ? output_dir.trim() : OUTPUT_DIR;
        try {
          await mkdir(targetDir, { recursive: true });
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Could not create output_dir "${targetDir}": ${String(err)}. Pick a path the MCP process can write (e.g. a mounted volume), or omit output_dir and use return_base64 instead.` }],
            isError: true,
          };
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [];
        const paths: string[] = [];
        const dataItems: Array<{ filename: string; mimeType: string; base64: string }> = [];

        const asJpeg = format === "jpeg";
        const ext = asJpeg ? "jpg" : "png";
        const outMime = asJpeg ? "image/jpeg" : "image/png";
        const maxDim = max_dimension ?? 4096;

        for (let i = 0; i < images.length; i++) {
          const img = images[i];

          // Transcode/resize from the PNG the model returns when requested.
          let outB64 = img.base64;
          if (asJpeg || maxDim < 4096) {
            let pipeline = sharp(Buffer.from(img.base64, "base64"));
            if (maxDim < 4096) {
              pipeline = pipeline.resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true });
            }
            if (asJpeg) {
              pipeline = pipeline.jpeg({ quality: jpeg_quality ?? 80, mozjpeg: true });
            }
            outB64 = (await pipeline.toBuffer()).toString("base64");
          }

          const filename = `gpt-image-2-${stamp}-${i + 1}.${ext}`;
          const filepath = join(targetDir, filename);
          await writeFile(filepath, Buffer.from(outB64, "base64"));
          paths.push(filepath);

          if (preview !== false) {
            content.push({ type: "image", data: outB64, mimeType: outMime });
          }
          if (return_base64) {
            dataItems.push({ filename: basename(filepath), mimeType: outMime, base64: outB64 });
          }
        }

        if (return_base64) {
          content.push({ type: "text", text: JSON.stringify({ images: dataItems }, null, 2) });
        }

        const wroteToCustomDir = Boolean(output_dir?.trim());
        const locationNote = wroteToCustomDir
          ? " (written to the output_dir you specified)"
          : return_base64
            ? " (base64 included below for client-side saving)"
            : " — note: this path is on the machine running the MCP. If it's remote, pass output_dir (a shared/mounted path) or return_base64:true to retrieve the file";
        const refNote = references.length > 0 ? ` Matched ${references.length} reference image(s).` : "";
        content.unshift({
          type: "text",
          text: `${isMockMode() ? "[MOCK — no credits used] " : ""}Generated ${images.length} image(s).${refNote} Saved at: ${paths.join(", ")}${locationNote}`,
        });

        // Surface references that failed to load, when at least one succeeded.
        if (refErrors.length > 0 && references.length > 0) {
          content.push({ type: "text", text: `Note — ${refErrors.length} reference(s) were skipped:\n${refErrors.join("\n")}` });
        }

        return { content };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Image generation failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
