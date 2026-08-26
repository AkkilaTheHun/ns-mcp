/**
 * Per-shade alt text composer powered by Sonnet 4.6.
 *
 * Reads cached vision per image + canonical metadata, returns one alt
 * per image. The model uses canonical color/finish as the spine and
 * weaves in image-specific observations (state, shift, flake angle)
 * when vision saw something distinctive.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

let cachedClient: Anthropic | undefined;
function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

export interface ImageInput {
  idx: number;
  imageType: string | null;
  skinTone: string | null;
  nailCount: number | null;
  lightingCondition: string | null;
  dominantColors: Array<{ hex?: string; label: string }>;
  observedEffects: string[];
  visionAltText?: string;
}

export interface AltComposeInput {
  shade: string;
  brand: string;
  canonicalColor: string;        // e.g. "blue-purple" from color-pattern metafield refs
  canonicalFinish: string;       // e.g. "flakie UV" from cosmetic-finish + polish-type
  polishTypes: string[];         // displayName list, raw — used for state-aware judgment
  descriptionExcerpt?: string;   // stripped + truncated descriptionHtml
  images: ImageInput[];
}

export interface AltComposeOutput {
  idx: number;
  alt: string;
}

const SYSTEM_PROMPT = `You write image alt text for nail polish photos on NailStuff (a Shopify store, market: Canada + United States). For each image of a polish, you output ONE alt-text line.

# Pattern (the Glitch Lacquer template — used catalog-wide)

  "{Shade} by {Brand}, {color + finish descriptor}, {image-role suffix}"

The descriptor for each image must:
- Lead with canonical color + finish words derived from the polish's metafields (the inputs include these).
- When vision saw something distinctive in THIS image (a UV-activated state, a multichrome angle shift, a magnetic pattern, a particular flake flash, a "resting state" vs "activated state"), weave that detail in. Use phrases like "in resting state", "in UV-activated state", "mid-shift from purple to copper", "with magnetic pattern", "showing the gold-to-pink flake shift".
- Do NOT repeat the same descriptor across every image of the polish — vary it where vision shows variation.
- Stay faithful to vendor copy and metafields. Don't invent finishes the vendor didn't claim.

# Image-role suffixes (use the imageType field)

  swatch_on_nails    "on a {skinTone} skin tone hand"
                     or omit skin tone clause if skinTone is null
  bottle_in_hand     "bottle held in a {skinTone} hand"
  bottle_standalone  "bottle standalone product shot"
  macro_detail       "macro close-up of {what's distinctive}"
  swatch_wheel       "swatch wheel"
  swatch_stick       "swatch stick"
  group_shot         "in collection group shot"
  layering_demo      "layering demo"
  lifestyle          "in lifestyle setting"
  unknown            "swatched on nails" (best guess from other fields)

# Hard rules

- No em dashes (—). Use commas, periods, or "with"/"showing".
- One alt per image, 80-160 characters typically.
- Output JSON ONLY via the \`write_alts\` tool, no prose.
- "{Shade} by {Brand}" prefix is mandatory.
- Don't include the word "Polish" twice (shade name may already contain "(UV Polish)").

# Examples

Shade: Fairies of the Air (UV Polish)
Brand: Chamaeleon Nails
canonicalColor: blue-purple   canonicalFinish: flakie UV
img 1 (swatch_on_nails, light-medium skin, dominantColors:[{label:"vivid purple jelly base"}], observedEffects:["resting state", "iridescent flakies"]):
  "Fairies of the Air (UV Polish) by Chamaeleon Nails, purple flakie UV in resting state, on a light-medium skin tone hand"
img 5 (swatch_on_nails, medium skin, dominantColors:[{label:"icy pale blue activated base"}], observedEffects:["UV-activated", "copper iridescent flakes"]):
  "Fairies of the Air (UV Polish) by Chamaeleon Nails, icy blue UV-activated state with copper iridescent flakies, on a medium skin tone hand"
img 12 (macro_detail, light skin, observedEffects:["mid-transition", "purple-to-blue shift"]):
  "Fairies of the Air (UV Polish) by Chamaeleon Nails, macro close-up of the purple-to-blue UV transition"

Shade: Sauron's Eye   Brand: Chamaeleon Nails
canonicalColor: orange   canonicalFinish: multichrome flakie jelly
img 1 (swatch_on_nails, light skin, dominantColors:[{label:"vivid orange-red jelly base"}, {label:"gold-amber flakes"}], observedEffects:["multichrome flakies", "iridescent shimmer"]):
  "Sauron's Eye by Chamaeleon Nails, vivid orange jelly with gold-amber multichrome flakes, on a light skin tone hand"
img 13 (macro_detail, observedEffects:["pink-to-gold flake shift", "ultrachrome shards"]):
  "Sauron's Eye by Chamaeleon Nails, macro close-up of pink-to-gold ultrachrome flake shift"
`;

const TOOL_SCHEMA = {
  name: "write_alts",
  description: "Output composed alt text for each image, one entry per input image (matched by idx).",
  input_schema: {
    type: "object",
    properties: {
      alts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            idx: { type: "integer", description: "Matches the input image idx" },
            alt: { type: "string", description: "Composed alt text for that image" },
          },
          required: ["idx", "alt"],
        },
      },
    },
    required: ["alts"],
  },
} as const;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function cachePath(brand: string, shade: string): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return resolve(import.meta.dirname ?? ".", "../../output/alt-composer-cache", safe(brand), `${safe(shade)}.json`);
}

interface CacheRecord {
  shade: string;
  brand: string;
  model: string;
  computedAt: string;
  alts: AltComposeOutput[];
  imageHash: string; // identifies the input set so we know when to bust
}

function hashImages(images: ImageInput[]): string {
  // Cheap hash: stringify the imageType + dominantColors[0].label + observedEffects per image
  const parts = images.map(i => `${i.idx}:${i.imageType}:${i.skinTone}:${(i.dominantColors?.[0]?.label ?? "").slice(0,40)}:${(i.observedEffects ?? []).slice(0,3).join("|")}`);
  // simple djb2
  let h = 5381;
  for (const ch of parts.join(";")) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(16);
}

async function loadCache(brand: string, shade: string, imageHash: string): Promise<AltComposeOutput[] | null> {
  const path = cachePath(brand, shade);
  if (!existsSync(path)) return null;
  try {
    const rec = JSON.parse(await readFile(path, "utf-8")) as CacheRecord;
    if (rec.imageHash !== imageHash) return null;  // input changed, recompute
    return rec.alts;
  } catch { return null; }
}

async function saveCache(brand: string, shade: string, imageHash: string, alts: AltComposeOutput[], model: string): Promise<void> {
  const path = cachePath(brand, shade);
  await mkdir(dirname(path), { recursive: true });
  const rec: CacheRecord = { shade, brand, model, computedAt: new Date().toISOString(), alts, imageHash };
  await writeFile(path, JSON.stringify(rec, null, 2));
}

// ---------------------------------------------------------------------------

export async function composeAltsForShade(
  input: AltComposeInput,
  model: string = "claude-sonnet-4-6",
  opts: { skipCache?: boolean } = {},
): Promise<AltComposeOutput[]> {
  const imageHash = hashImages(input.images);
  if (!opts.skipCache) {
    const cached = await loadCache(input.brand, input.shade, imageHash);
    if (cached) return cached;
  }

  const client = getClient();

  // Trim image payload size — Sonnet doesn't need the full dominantColors[],
  // just the top 3 with their labels.
  const slim = {
    shade: input.shade,
    brand: input.brand,
    canonicalColor: input.canonicalColor,
    canonicalFinish: input.canonicalFinish,
    polishTypes: input.polishTypes,
    descriptionExcerpt: input.descriptionExcerpt?.slice(0, 600),
    images: input.images.map(img => ({
      idx: img.idx,
      imageType: img.imageType,
      skinTone: img.skinTone,
      nailCount: img.nailCount,
      lightingCondition: img.lightingCondition,
      dominantColors: (img.dominantColors ?? []).slice(0, 3),
      observedEffects: (img.observedEffects ?? []).slice(0, 6),
      visionAltText: img.visionAltText?.slice(0, 300),
    })),
  };

  const resp = await client.messages.create({
    model,
    max_tokens: Math.max(2000, slim.images.length * 120),
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } } as any],
    tools: [TOOL_SCHEMA as any],
    tool_choice: { type: "tool", name: "write_alts" } as any,
    messages: [{ role: "user", content: JSON.stringify(slim, null, 2) }],
  });

  const toolUse = resp.content.find((b: any) => b.type === "tool_use") as any;
  if (!toolUse) {
    const text = resp.content.find((b: any) => b.type === "text") as any;
    throw new Error(`No tool_use in compose response. stop=${resp.stop_reason}, content_blocks=${resp.content.map((b:any)=>b.type).join(",")}, text=${text?.text?.slice(0,200) ?? "(none)"}`);
  }
  const out = toolUse.input as { alts?: AltComposeOutput[] };
  if (!out?.alts) {
    throw new Error(`Compose tool_use missing alts; got keys=${Object.keys(out ?? {}).join(",")}, raw=${JSON.stringify(out).slice(0,300)}`);
  }
  await saveCache(input.brand, input.shade, imageHash, out.alts, model);
  return out.alts;
}
