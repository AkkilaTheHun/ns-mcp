import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink, mkdir } from "fs/promises";

export function registerImageTools(server: McpServer): void {
  server.tool(
    "compress_images",
    `Download images from public URLs, compress to JPEG, and return results.
Useful for preparing images before uploading to Shopify or for vision analysis.
Supports: JPEG, PNG, WebP, AVIF, HEIC, TIFF, GIF.

By default returns native image content blocks that Claude can see directly.
Set format: "data" to get raw base64 + metadata as JSON (for uploading/processing).`,
    {
      urls: z.array(z.string().url()).min(1).describe("Public HTTPS image URLs to download and compress"),
      quality: z.number().min(1).max(100).default(80).optional().describe("JPEG quality 1-100 (default 80)"),
      maxWidth: z.number().optional().describe("Max width in px — images wider than this are resized proportionally"),
      format: z.enum(["image", "data"]).default("image").optional().describe("'image' (default) returns native image blocks Claude can see; 'data' returns JSON with raw base64 for uploading"),
    },
    async ({ urls, quality, maxWidth, format }) => {
      const jpegQuality = quality ?? 80;
      const workDir = join(tmpdir(), `mcp-images-${Date.now()}`);
      await mkdir(workDir, { recursive: true });

      const processed: Array<{ url: string; base64: string; width: number; height: number; originalSize: number; compressedSize: number; format: string }> = [];
      const errors: Array<{ url: string; error: string }> = [];

      await Promise.all(urls.map(async (url, i) => {
        const tmpPath = join(workDir, `img-${i}`);
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          const buffer = Buffer.from(await res.arrayBuffer());

          await writeFile(tmpPath, buffer);

          let pipeline = sharp(buffer);
          const meta = await pipeline.metadata();

          if (maxWidth && meta.width && meta.width > maxWidth) {
            pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
          }

          const jpegBuffer = await pipeline
            .jpeg({ quality: jpegQuality, mozjpeg: true })
            .toBuffer();

          const outMeta = await sharp(jpegBuffer).metadata();

          processed.push({
            url,
            base64: jpegBuffer.toString("base64"),
            width: outMeta.width ?? meta.width ?? 0,
            height: outMeta.height ?? meta.height ?? 0,
            originalSize: buffer.length,
            compressedSize: jpegBuffer.length,
            format: meta.format ?? "unknown",
          });
        } catch (err) {
          errors.push({ url, error: String(err) });
        } finally {
          await unlink(tmpPath).catch(() => {});
        }
      }));

      await unlink(workDir).catch(() => {});

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      if (format === "data") {
        const results = processed.map(p => ({
          originalUrl: p.url,
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
        // Native image blocks — interleave text metadata with viewable images
        for (const p of processed) {
          content.push({
            type: "text",
            text: `${p.url} — ${p.width}x${p.height}, ${p.format} → jpeg, ${p.originalSize} → ${p.compressedSize} bytes (${((1 - p.compressedSize / p.originalSize) * 100).toFixed(1)}% reduction)`,
          });
          content.push({
            type: "image",
            data: p.base64,
            mimeType: "image/jpeg",
          });
        }
        if (errors.length) {
          content.push({ type: "text", text: `Errors:\n${errors.map(e => `  ${e.url}: ${e.error}`).join("\n")}` });
        }
      }

      return { content };
    },
  );
}
