import "dotenv/config";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { generateImages } from "../src/openai/images.js";

// Quick smoke test for the gpt-image-2 integration.
// Usage: pnpm tsx scripts/test-image-gen.ts "your prompt here"
async function main() {
  const prompt =
    process.argv.slice(2).join(" ") ||
    "A glossy bottle of iridescent multichrome nail polish on a marble surface, soft studio lighting, product photography";

  console.log(`Generating: "${prompt}"`);
  const t0 = Date.now();
  const images = await generateImages({ prompt, size: "1024x1024", quality: "low", n: 1 });
  console.log(`Got ${images.length} image(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const outDir = join(process.cwd(), "output", "generated");
  await mkdir(outDir, { recursive: true });
  for (let i = 0; i < images.length; i++) {
    const path = join(outDir, `smoketest-${i + 1}.png`);
    await writeFile(path, Buffer.from(images[i].base64, "base64"));
    console.log(`Wrote ${path}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
