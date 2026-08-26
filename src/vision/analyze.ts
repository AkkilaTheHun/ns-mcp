/**
 * Provider-agnostic vision entry point with retry.
 *
 * Analyses intermittently come back as `imageType: "unknown"` with empty fields
 * and a 0.1 score — non-deterministic, the same image succeeding on one pass and
 * failing on the next. Those used to land in a manual review pile. Retry them.
 */
import { analyzeImage as analyzeGemini } from "../google/vision.js";
import { analyzeImage as analyzeClaude } from "../anthropic/vision.js";
import type { ImageAnalysis, PromptContext } from "./schema.js";
import type { PolishType, PolishFinish } from "./polish-types.js";

export type VisionProvider = "gemini" | "claude";

/**
 * First-pass polish-type classification.
 *
 * Only needed when the operator has not supplied the type. Deliberately a
 * separate small call at low resolution: type is a coarse judgement, and the
 * point is to pick WHICH measurement prompt to run — loading every type's
 * guidance into one prompt would dilute all of them.
 */
export async function classifyPolish(
  imageBase64: string,
  mimeType: string,
  brand: string,
  provider: VisionProvider = "claude",
  model?: string,
): Promise<{ polishType: PolishType | null; finishes: PolishFinish[]; confidence: number; reason: string }> {
  const { classifyPrompt, POLISH_TYPES, POLISH_FINISHES } = await import("./polish-types.js");
  const fn = provider === "claude" ? analyzeRawClaude : analyzeRawGemini;
  const text = await fn(imageBase64, mimeType, classifyPrompt(brand), model);

  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const j = JSON.parse(cleaned) as { polishType?: string; finishes?: string[]; confidence?: number; reason?: string };
    return {
      polishType: POLISH_TYPES.find((p: PolishType) => p === j.polishType) ?? null,
      finishes: (j.finishes ?? []).filter((f): f is PolishFinish => POLISH_FINISHES.includes(f as PolishFinish)),
      confidence: j.confidence ?? 0,
      reason: j.reason ?? "",
    };
  } catch {
    return { polishType: null, finishes: [], confidence: 0, reason: "unparseable" };
  }
}

export interface AnalyzeOptions {
  provider: VisionProvider;
  model?: string;
  crop?: { base64: string; mimeType: string };
  /** Total attempts including the first. */
  attempts?: number;
  onRetry?: (attempt: number, reason: string) => void;
}

/**
 * A result is unusable when the reply could not be parsed, or when it parsed
 * but carries no colour information at all — both are the same failure from
 * the caller's point of view, and both are worth one more try.
 */
function unusable(a: ImageAnalysis): string | null {
  if (a.parseFailed) return "model reply did not parse";
  const hasColor =
    !!a.discriminators?.baseColor ||
    (a.nailColors?.length ?? 0) > 0 ||
    (a.bottleColors?.length ?? 0) > 0 ||
    (a.dominantColors?.length ?? 0) > 0;
  if (!hasColor) return "no colour values returned";
  if (a.imageType === "unknown" && a.observedEffects.length === 0) return "unclassified with no effects";
  return null;
}

export async function analyzeWithRetry(
  imageBase64: string,
  mimeType: string,
  context: PromptContext,
  opts: AnalyzeOptions,
): Promise<ImageAnalysis> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const fn = opts.provider === "claude" ? analyzeClaude : analyzeGemini;

  let last: ImageAnalysis | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let result: ImageAnalysis;
    try {
      result = await fn(imageBase64, mimeType, context, opts.model, opts.crop);
    } catch (err) {
      // Transport/API errors are retryable too; rethrow only when out of tries.
      if (attempt === attempts) throw err;
      opts.onRetry?.(attempt, String(err));
      continue;
    }

    const reason = unusable(result);
    if (!reason) return result;

    last = result;
    if (attempt < attempts) opts.onRetry?.(attempt, reason);
  }

  // Every attempt was unusable — hand back the last one so the caller can
  // still see and report what came out.
  return last!;
}

// ---------------------------------------------------------------------------
// Raw single-turn text calls, used by the classifier. The main analyze path
// goes through the provider modules so it shares the structured prompt; the
// classifier needs a plain question with a tiny answer, so it talks directly.
// ---------------------------------------------------------------------------

async function analyzeRawClaude(
  imageBase64: string, mimeType: string, prompt: string, model?: string,
): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var not set");
  const client = new Anthropic({ apiKey });
  const media = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType.toLowerCase())
    ? (mimeType.toLowerCase() as "image/jpeg") : "image/jpeg";
  const res = await client.messages.create({
    model: model ?? "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: media, data: imageBase64 } },
        { type: "text", text: prompt },
      ],
    }],
  });
  const block = res.content.find((b) => b.type === "text");
  return block && "text" in block ? block.text : "";
}

async function analyzeRawGemini(
  imageBase64: string, mimeType: string, prompt: string, model?: string,
): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_AI_API_KEY env var not set");
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: model ?? "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: prompt }] }],
  });
  return res.text ?? "";
}
