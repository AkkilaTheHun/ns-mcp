import Anthropic from "@anthropic-ai/sdk";
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  parseModelJson,
  type ImageAnalysis,
  type PromptContext,
} from "../vision/schema.js";

let cachedClient: Anthropic | undefined;

/**
 * A vision call on a prepared image runs ~12s. The SDK defaults — a 10-minute
 * timeout with 2 internal retries — wrapped in analyzeWithRetry's own 2 attempts
 * put the silent worst case near 40 minutes per image. Bound it: 90s is ~7x
 * headroom over a normal call, and one internal retry still absorbs transient
 * 429/5xx without letting a stall go unnoticed.
 */
const VISION_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS ?? "90000");
const VISION_MAX_RETRIES = Number(process.env.ANTHROPIC_MAX_RETRIES ?? "1");

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var not set");
    cachedClient = new Anthropic({
      apiKey,
      timeout: VISION_TIMEOUT_MS,
      maxRetries: VISION_MAX_RETRIES,
    });
  }
  return cachedClient;
}

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
  context: PromptContext,
  model: string = "claude-sonnet-4-6",
  crop?: { base64: string; mimeType: string },
): Promise<ImageAnalysis> {
  const client = getClient();

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "image",
      source: { type: "base64", media_type: normalizeMediaType(mimeType), data: imageBase64 },
    },
  ];
  if (crop) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: normalizeMediaType(crop.mimeType), data: crop.base64 },
    });
  }
  content.push({ type: "text", text: buildUserPrompt(context, !!crop) });

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return parseModelJson(textBlock?.text ?? "", context);
}
