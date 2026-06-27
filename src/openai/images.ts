import OpenAI from "openai";
import sharp from "sharp";

let cachedClient: OpenAI | undefined;

function getClient(): OpenAI {
  if (!cachedClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY env var not set");
    cachedClient = new OpenAI({ apiKey });
  }
  return cachedClient;
}

export interface GeneratedImage {
  base64: string;      // raw base64 PNG bytes (no data: prefix)
  mimeType: string;    // always image/png for gpt-image-* models
}

export interface GenerateImageOptions {
  prompt: string;
  size?: string;       // e.g. "1024x1024", "1024x1536", "1536x1024", "auto"
  quality?: string;    // gpt-image-* quality: "low" | "medium" | "high" | "auto"
  n?: number;
  model?: string;
}

/**
 * Generate one or more images with OpenAI's gpt-image models.
 *
 * gpt-image-* models always return base64 (`b64_json`) — there is no URL
 * response option — so callers decode and write the bytes themselves.
 */
/** True when OPENAI_IMAGE_MOCK is set to a truthy value — skips real billed calls. */
export function isMockMode(): boolean {
  const v = process.env.OPENAI_IMAGE_MOCK?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Render a free local placeholder PNG (no OpenAI call) so the full tool path
 * can be exercised in dev without burning credits.
 */
async function mockImage(prompt: string, size: string, index: number): Promise<GeneratedImage> {
  const [w, h] = size === "auto" ? [1024, 1024] : size.split("x").map((n) => parseInt(n, 10) || 1024);
  const escaped = prompt.slice(0, 70).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] ?? c));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#2b2b3d"/>
    <text x="50%" y="42%" fill="#ffffff" font-size="36" font-family="sans-serif" text-anchor="middle">MOCK IMAGE #${index + 1}</text>
    <text x="50%" y="52%" fill="#9aa0b4" font-size="20" font-family="sans-serif" text-anchor="middle">${escaped}</text>
    <text x="50%" y="60%" fill="#6b7088" font-size="16" font-family="sans-serif" text-anchor="middle">${w}x${h} · no credits used</text>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { base64: buf.toString("base64"), mimeType: "image/png" };
}

export async function generateImages(opts: GenerateImageOptions): Promise<GeneratedImage[]> {
  const size = opts.size ?? "1024x1024";
  const count = opts.n ?? 1;

  // Dev mode: return local placeholders, never touch the OpenAI API.
  if (isMockMode()) {
    return Promise.all(Array.from({ length: count }, (_, i) => mockImage(opts.prompt, size, i)));
  }

  const client = getClient();

  const res = await client.images.generate({
    model: opts.model ?? "gpt-image-2",
    prompt: opts.prompt,
    n: opts.n ?? 1,
    ...(opts.size ? { size: opts.size as never } : {}),
    ...(opts.quality ? { quality: opts.quality as never } : {}),
  });

  const data = res.data ?? [];
  return data
    .map((d): string | undefined => d.b64_json)
    .filter((b): b is string => Boolean(b))
    .map((b64): GeneratedImage => ({ base64: b64, mimeType: "image/png" }));
}
