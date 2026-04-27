import Anthropic from "@anthropic-ai/sdk";
import type { ImageAnalysis } from "../google/vision.js";

let cachedClient: Anthropic | undefined;

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var not set");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

const SYSTEM_PROMPT = `You are an expert image analyst for NailStuff, a Canadian indie nail polish e-commerce store. You analyze product images to generate structured metadata and accessibility-focused alt text.

Your analysis must be precise about:
- Image type classification
- Color accuracy (hex values should closely match what's visible)
- Nail polish effects and finishes (shimmer, holo, magnetic, flakies, creme, jelly, glitter, multichrome, thermal, reflective, etc.)
- Skin tone when hands/skin are visible (use inclusive descriptors: fair, light, light-medium, medium, medium-deep, deep, rich)
- Nail shape when visible (stiletto, coffin, almond, oval, round, square, squoval, short natural)
- Lighting conditions that affect how the polish reads

Alt text format: "{Effect/finish} {brand} nail polish in {shade name}, {what's shown — e.g. 'held in hand showing bottle front' or 'swatched on four almond-shaped nails'}, {skin tone if visible}, {lighting note}"

Every image should have unique, descriptive alt text. A bottle shot and a swatch of the same polish deserve very different descriptions.`;

type SupportedMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function normalizeMediaType(mimeType: string): SupportedMediaType {
  const lower = mimeType.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  if (lower === "image/jpeg" || lower === "image/png" || lower === "image/gif" || lower === "image/webp") {
    return lower;
  }
  return "image/jpeg";
}

export async function analyzeImage(
  imageBase64: string,
  mimeType: string,
  context: { productName: string; brand: string; vendorHint?: string },
): Promise<ImageAnalysis> {
  const client = getClient();

  const contextLine = context.vendorHint
    ? `Product: "${context.productName}" by ${context.brand}. Vendor describes it as: "${context.vendorHint}".`
    : `Product: "${context.productName}" by ${context.brand}.`;

  const userText = `${contextLine}

Analyze this image and return a JSON object with these exact fields:
- "imageType": one of "bottle_in_hand", "bottle_standalone", "swatch_on_nails", "swatch_wheel", "swatch_stick", "lifestyle", "layering_demo", "group_shot", "macro_detail", "unknown"
- "lightingCondition": one of "direct_flash", "bright_daylight", "indoor_warm", "dim", "studio"
- "nailCount": number of nails visible (0 if no nails shown)
- "skinTone": one of "fair", "light", "light-medium", "medium", "medium-deep", "deep", "rich", or null if no skin visible
- "dominantColors": array of {"hex": string, "label": string} for the top 2-3 polish colors visible
- "observedEffects": array of effect strings visible in the polish
- "altText": alt text following the format above, using the brand name "${context.brand}" and shade name "${context.productName}"
- "confidence": 0.0-1.0 how confident you are in the analysis (lower if image is blurry, ambiguous, not clearly nail polish, unusual angle, etc.)

${context.vendorHint ? `The vendor describes the color/effect as "${context.vendorHint}". If what you observe contradicts this, trust your eyes and note the discrepancy in the alt text or by lowering confidence.` : ""}

Return ONLY the JSON object. No markdown fencing, no explanation.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: normalizeMediaType(mimeType), data: imageBase64 },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const text = textBlock?.text.trim() ?? "";

  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    return JSON.parse(cleaned) as ImageAnalysis;
  } catch {
    return {
      imageType: "unknown",
      lightingCondition: "unknown",
      nailCount: 0,
      skinTone: null,
      dominantColors: [],
      observedEffects: [],
      altText: `${context.brand} nail polish ${context.productName}`,
      confidence: 0.1,
    };
  }
}
