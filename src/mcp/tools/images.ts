import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { tmpdir } from "os";
import { join } from "path";
import { unlink, mkdir } from "fs/promises";

interface ProcessedImage {
  label: string;
  base64: string;
  width: number;
  height: number;
  originalSize: number;
  compressedSize: number;
  format: string;
}

async function compressBuffer(buffer: Buffer, label: string, jpegQuality: number, maxWidth?: number): Promise<ProcessedImage> {
  let pipeline = sharp(buffer);
  const meta = await pipeline.metadata();

  if (maxWidth && meta.width && meta.width > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  }

  const jpegBuffer = await pipeline
    .jpeg({ quality: jpegQuality, mozjpeg: true })
    .toBuffer();

  const outMeta = await sharp(jpegBuffer).metadata();

  return {
    label,
    base64: jpegBuffer.toString("base64"),
    width: outMeta.width ?? meta.width ?? 0,
    height: outMeta.height ?? meta.height ?? 0,
    originalSize: buffer.length,
    compressedSize: jpegBuffer.length,
    format: meta.format ?? "unknown",
  };
}

export function registerImageTools(server: McpServer): void {
  server.tool(
    "compress_images",
    `Compress images to JPEG and return native image blocks that Claude can see.
Accepts public URLs, base64 data, or a mix of both. Useful for vision analysis
(writing alt text, product descriptions) and preparing images for Shopify upload.
Supports: JPEG, PNG, WebP, AVIF, HEIC, TIFF, GIF.

Input options (provide at least one):
- urls: public HTTPS image URLs to download and compress
- images: array of {data, label?} for base64-encoded image data (e.g. from Google Drive download)

Set format: "data" to get raw base64 + metadata as JSON instead of viewable image blocks.`,
    {
      urls: z.array(z.string().url()).optional().describe("Public HTTPS image URLs to download and compress"),
      images: z.array(z.object({
        data: z.string().describe("Base64-encoded image data"),
        label: z.string().optional().describe("Label for this image (e.g. filename or source)"),
      })).optional().describe("Base64 image data to compress (e.g. from Google Drive MCP download)"),
      quality: z.number().min(1).max(100).default(80).optional().describe("JPEG quality 1-100 (default 80)"),
      maxWidth: z.number().optional().describe("Max width in px — images wider than this are resized proportionally"),
      format: z.enum(["image", "data"]).default("image").optional().describe("'image' (default) returns native image blocks Claude can see; 'data' returns JSON with raw base64 for uploading"),
    },
    async ({ urls, images, quality, maxWidth, format }) => {
      if (!urls?.length && !images?.length) {
        return { content: [{ type: "text" as const, text: "Error: provide at least one of 'urls' or 'images'" }], isError: true };
      }

      const jpegQuality = quality ?? 80;
      const workDir = join(tmpdir(), `mcp-images-${Date.now()}`);
      await mkdir(workDir, { recursive: true });

      const processed: ProcessedImage[] = [];
      const errors: Array<{ label: string; error: string }> = [];

      // Process URLs
      if (urls?.length) {
        await Promise.all(urls.map(async (url) => {
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            const contentType = res.headers.get("content-type") ?? "";
            if (contentType.includes("text/html")) {
              throw new Error(`Got HTML instead of image — URL likely requires authentication or is not a direct image link`);
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            processed.push(await compressBuffer(buffer, url, jpegQuality, maxWidth));
          } catch (err) {
            errors.push({ label: url, error: String(err) });
          }
        }));
      }

      // Process base64 images
      if (images?.length) {
        await Promise.all(images.map(async (img, i) => {
          const label = img.label ?? `image-${i + 1}`;
          try {
            const buffer = Buffer.from(img.data, "base64");
            processed.push(await compressBuffer(buffer, label, jpegQuality, maxWidth));
          } catch (err) {
            errors.push({ label, error: String(err) });
          }
        }));
      }

      await unlink(workDir).catch(() => {});

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      if (format === "data") {
        const results = processed.map(p => ({
          label: p.label,
          format: p.format,
          width: p.width,
          height: p.height,
          originalSizeBytes: p.originalSize,
          compressedSizeBytes: p.compressedSize,
          compressionRatio: `${((1 - p.compressedSize / p.originalSize) * 100).toFixed(1)}%`,
          base64: p.base64,
          mediaType: "image/jpeg",
        }));
        const output: Record<string, unknown> = { results };
        if (errors.length) output.errors = errors;
        content.push({ type: "text", text: JSON.stringify(output, null, 2) });
      } else {
        for (const p of processed) {
          content.push({
            type: "text",
            text: `${p.label} — ${p.width}x${p.height}, ${p.format} → jpeg, ${p.originalSize} → ${p.compressedSize} bytes (${((1 - p.compressedSize / p.originalSize) * 100).toFixed(1)}% reduction)`,
          });
          content.push({
            type: "image",
            data: p.base64,
            mimeType: "image/jpeg",
          });
        }
        if (errors.length) {
          content.push({ type: "text", text: `Errors:\n${errors.map(e => `  ${e.label}: ${e.error}`).join("\n")}` });
        }
      }

      return { content };
    },
  );
}
