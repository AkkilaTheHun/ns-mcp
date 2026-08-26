#!/usr/bin/env tsx
// One-off masked inpaint: regenerate only the masked region of an image with gpt-image-2.
// Usage: pnpm tsx scripts/inpaint-map.ts <image.png> <mask.png> <out.png>
// Mask: transparent areas are regenerated, opaque areas are preserved.
import "dotenv/config";
import OpenAI, { toFile } from "openai";
import { readFile, writeFile } from "fs/promises";

const [imgPath, maskPath, outPath] = process.argv.slice(2);
if (!imgPath || !maskPath || !outPath) {
  console.error("Usage: inpaint-map.ts <image.png> <mask.png> <out.png>");
  process.exit(1);
}

const prompt =
  "This is a premium illustrated Turtle Island Sale banner. Inside the masked region, redraw the " +
  "North American continent as a HIGHLY DETAILED illustrated map on the sea-turtle's shell: crisp, " +
  "accurate coastlines of Canada, the United States, Mexico and Central America, the Great Lakes, " +
  "Florida, Baja and the Caribbean; defined mountain ranges (Rockies, Appalachians) as fine ridges; " +
  "dense little pine forests, rivers and lakes; rich but COOL greens, teal and soft ochre land over " +
  "deep blue shell-ocean, edged with fine gold coastlines. Match the surrounding cool navy-and-teal " +
  "turtle shell and its gold linework exactly, and blend seamlessly at the edges. Painterly, intricate, " +
  "sharp detail. Do not change anything outside the masked area.";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const image = await toFile(await readFile(imgPath), "image.png", { type: "image/png" });
const mask = await toFile(await readFile(maskPath), "mask.png", { type: "image/png" });

console.log("Inpainting masked region…");
const t0 = Date.now();
const res = await client.images.edit({
  model: "gpt-image-2",
  image,
  mask,
  prompt,
  size: "1536x1024" as never,
  quality: "high" as never,
});
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const b64 = res.data?.[0]?.b64_json;
if (!b64) throw new Error("model returned no image data");
await writeFile(outPath, Buffer.from(b64, "base64"));
console.log("Wrote", outPath);
