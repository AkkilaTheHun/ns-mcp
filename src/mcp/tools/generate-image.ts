import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { generateImages, isMockMode } from "../../openai/images.js";

const OUTPUT_DIR = join(process.cwd(), "output", "generated");

export function registerGenerateImageTool(server: McpServer): void {
  server.tool(
    "generate_image",
    `Generate images from a text prompt using OpenAI's gpt-image-2 model.
Writes each PNG to output/generated/ and returns the file path(s) plus a
viewable image block.

Use for mockups, concept art, marketing visuals, or product imagery ideas.
Note: gpt-image-2 always returns PNG; size/quality control resolution and cost.`,
    {
      prompt: z.string().min(1).describe("Text description of the image to generate"),
      size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).default("1024x1024").optional()
        .describe("Output dimensions (default 1024x1024). 'auto' lets the model choose."),
      quality: z.enum(["low", "medium", "high", "auto"]).default("auto").optional()
        .describe("Render quality — higher costs more (default 'auto')"),
      n: z.number().int().min(1).max(4).default(1).optional()
        .describe("How many images to generate (1-4, default 1)"),
      preview: z.boolean().default(true).optional()
        .describe("If true (default), also return a viewable image block; set false to return only file paths"),
    },
    async ({ prompt, size, quality, n, preview }) => {
      try {
        const images = await generateImages({
          prompt,
          size: size ?? "1024x1024",
          quality: quality ?? "auto",
          n: n ?? 1,
        });

        if (!images.length) {
          return { content: [{ type: "text" as const, text: "Error: model returned no image data" }], isError: true };
        }

        await mkdir(OUTPUT_DIR, { recursive: true });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [];
        const paths: string[] = [];

        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const filename = `gpt-image-2-${stamp}-${i + 1}.png`;
          const filepath = join(OUTPUT_DIR, filename);
          await writeFile(filepath, Buffer.from(img.base64, "base64"));
          paths.push(filepath);

          if (preview !== false) {
            content.push({ type: "image", data: img.base64, mimeType: img.mimeType });
          }
        }

        content.unshift({
          type: "text",
          text: `${isMockMode() ? "[MOCK — no credits used] " : ""}Generated ${images.length} image(s) → ${paths.join(", ")}`,
        });

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
