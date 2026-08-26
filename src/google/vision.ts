import { GoogleGenAI } from "@google/genai";
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  parseModelJson,
  type ImageAnalysis,
  type PromptContext,
} from "../vision/schema.js";

let cachedClient: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (!cachedClient) {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_AI_API_KEY env var not set");
    cachedClient = new GoogleGenAI({ apiKey });
  }
  return cachedClient;
}

// Re-exported for the many modules that import ImageAnalysis from here.
export type { ImageAnalysis } from "../vision/schema.js";

export async function analyzeImage(
  imageBase64: string,
  mimeType: string,
  context: PromptContext,
  model: string = "gemini-2.5-flash",
  crop?: { base64: string; mimeType: string },
): Promise<ImageAnalysis> {
  const ai = getClient();

  const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [
    { inlineData: { mimeType, data: imageBase64 } },
  ];
  if (crop) parts.push({ inlineData: { mimeType: crop.mimeType, data: crop.base64 } });
  parts.push({ text: `${SYSTEM_PROMPT}\n\n${buildUserPrompt(context, !!crop)}` });

  const result = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
  });

  return parseModelJson(result.text ?? "", context);
}
