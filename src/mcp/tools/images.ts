import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink, mkdir } from "fs/promises";

interface ImageResult {
  originalUrl: string;
  format: string;
  width: number;
  height: number;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  compressionRatio: string;
  base64: string;
  mediaType: "image/jpeg";
}

export function registerImageTools(server: McpServer): void {
  server.tool(
    "compress_images",
    `Download images from public URLs, compress to JPEG, and return structured results with base64 data.
Useful for preparing images before uploading to Shopify or for vision analysis.
Supports: JPEG, PNG, WebP, AVIF, HEIC, TIFF, GIF.

Returns for each image: { originalUrl, format, width, height, originalSizeBytes, compressedSizeBytes, compressionRatio, base64, mediaType }

Set format to "vision_content_block" to get results pre-wrapped as Claude vision blocks:
  { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "<base64>" } }`,
    {
      urls: z.array(z.string().url()).min(1).describe("Public HTTPS image URLs to download and compress"),
      quality: z.number().min(1).max(100).default(80).optional().describe("JPEG quality 1-100 (default 80)"),
      maxWidth: z.number().optional().describe("Max width in px — images wider than this are resized proportionally"),
      format: z.enum(["default", "vision_content_block"]).default("vision_content_block").optional().describe("Output format — 'default' returns raw base64 for uploading/processing, 'vision_content_block' (default) wraps each image as a ready-to-use Claude vision content block"),
    },
    async ({ urls, quality, maxWidth, format }) => {
      const jpegQuality = quality ?? 80;
      const workDir = join(tmpdir(), `mcp-images-${Date.now()}`);
      await mkdir(workDir, { recursive: true });

      const results: ImageResult[] = [];
      const errors: Array<{ url: string; error: string }> = [];

      await Promise.all(urls.map(async (url, i) => {
        const tmpPath = join(workDir, `img-${i}`);
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          const originalSizeBytes = buffer.length;

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

          results.push({
            originalUrl: url,
            format: meta.format ?? "unknown",
            width: outMeta.width ?? meta.width ?? 0,
            height: outMeta.height ?? meta.height ?? 0,
            originalSizeBytes,
            compressedSizeBytes: jpegBuffer.length,
            compressionRatio: `${((1 - jpegBuffer.length / originalSizeBytes) * 100).toFixed(1)}%`,
            base64: jpegBuffer.toString("base64"),
            mediaType: "image/jpeg",
          });
        } catch (err) {
          errors.push({ url, error: String(err) });
        } finally {
          await unlink(tmpPath).catch(() => {});
        }
      }));

      // Clean up work dir
      await unlink(workDir).catch(() => {});

      if (format === "vision_content_block") {
        const visionBlocks = results.map(r => ({
          originalUrl: r.originalUrl,
          width: r.width,
          height: r.height,
          compressedSizeBytes: r.compressedSizeBytes,
          content_block: {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg" as const, data: r.base64 },
          },
        }));
        const output: Record<string, unknown> = { results: visionBlocks };
        if (errors.length) output.errors = errors;
        return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
      }

      const output: Record<string, unknown> = { results };
      if (errors.length) output.errors = errors;

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      };
    },
  );
}
