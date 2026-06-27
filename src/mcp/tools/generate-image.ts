import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join, basename } from "path";
import { mkdir, writeFile } from "fs/promises";
import { generateImages, isMockMode } from "../../openai/images.js";

const OUTPUT_DIR = join(process.cwd(), "output", "generated");

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
  }, z.boolean()).default(def);

const flexInt = (min: number, max: number, def: number) =>
  z.preprocess((v) => {
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return v;
  }, z.number().int().min(min).max(max)).default(def);

export function registerGenerateImageTool(server: McpServer): void {
  server.tool(
    "generate_image",
    `Generate images from a text prompt using OpenAI's gpt-image-2 model.
Returns a viewable image block and writes each PNG to output/generated/.

IMPORTANT — file paths are on the MACHINE RUNNING THE MCP. When this server
runs remotely (e.g. in Docker), output/generated/ lives inside the container
and is NOT reachable by the caller. To save the file on your side, pass
return_base64: true and decode the base64 the tool returns.

Use for mockups, concept art, marketing visuals, or product imagery ideas.
Note: gpt-image-2 always returns PNG; size/quality control resolution and cost.`,
    {
      prompt: z.string().min(1).describe("Text description of the image to generate"),
      size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).default("1024x1024").optional()
        .describe("Output dimensions (default 1024x1024). 'auto' lets the model choose."),
      quality: z.enum(["low", "medium", "high", "auto"]).default("auto").optional()
        .describe("Render quality — higher costs more (default 'auto')"),
      n: flexInt(1, 4, 1)
        .describe("How many images to generate (1-4, default 1)"),
      preview: flexBool(true)
        .describe("If true (default), also return a viewable image block; set false to return only file paths"),
      return_base64: flexBool(false)
        .describe("If true, append a JSON text block with each image's raw base64 PNG ({filename, mimeType, base64}) so the caller can decode and save the file itself. Required to retrieve images when the MCP runs remotely (Docker) and its output/generated/ path isn't reachable. Default false to keep responses small. Accepts true/false (boolean or string)."),
    },
    async ({ prompt, size, quality, n, preview, return_base64 }) => {
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
        const dataItems: Array<{ filename: string; mimeType: string; base64: string }> = [];

        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const filename = `gpt-image-2-${stamp}-${i + 1}.png`;
          const filepath = join(OUTPUT_DIR, filename);
          await writeFile(filepath, Buffer.from(img.base64, "base64"));
          paths.push(filepath);

          if (preview !== false) {
            content.push({ type: "image", data: img.base64, mimeType: img.mimeType });
          }
          if (return_base64) {
            dataItems.push({ filename: basename(filepath), mimeType: img.mimeType, base64: img.base64 });
          }
        }

        if (return_base64) {
          content.push({ type: "text", text: JSON.stringify({ images: dataItems }, null, 2) });
        }

        content.unshift({
          type: "text",
          text: `${isMockMode() ? "[MOCK — no credits used] " : ""}Generated ${images.length} image(s). Saved on the MCP host at: ${paths.join(", ")}${return_base64 ? " (base64 included below for client-side saving)" : " — note: this path is on the machine running the MCP; pass return_base64:true to retrieve the bytes if the server is remote"}`,
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
