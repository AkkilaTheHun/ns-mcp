/**
 * Per-image analysis cache.
 *
 * Vision calls cost money per image, so a run that is cancelled — or re-run
 * with a larger maxImages — should not pay twice for work already done.
 *
 * WHY PER-IMAGE AND NOT PER-FOLDER
 * --------------------------------
 * Folders get analysed partially all the time: a cap of 20 against a folder of
 * 29, or a run cancelled at 60 seconds. A per-folder cache misses on every one
 * of those and re-buys the whole folder. Keying per image means a re-run pays
 * only for images never analysed, and a cancelled run keeps whatever finished.
 *
 * WHY CONTENT HASH
 * ----------------
 * Dropbox exposes a hash of the file's BYTES in folder metadata, so an image
 * can be identified without downloading it — which is the point, since the
 * download is part of what we are trying to skip. It also behaves correctly
 * where a path or a timestamp does not: renaming or moving a file keeps the
 * hash, and editing it in place changes it.
 *
 * Sources without a content hash (Drive, URLs) fall back to the file id, which
 * is stable for a given file but will not notice an edit in place. Callers that
 * need edit-detection there should pass a hash of their own.
 *
 * SCOPE: IN-MEMORY, PROCESS-LIFETIME.
 * A restart or redeploy empties it. That is a deliberate limit rather than an
 * oversight — a durable cache needs somewhere to live and an invalidation story,
 * and the failure this exists to prevent (a 60-second timeout losing a whole
 * folder) happens inside one process lifetime. If it ever needs to survive
 * restarts, the key derivation here is what a persistent store would reuse.
 */
import { createHash } from "crypto";

/** Every parameter that changes what the vision call returns. */
export interface AnalysisCacheParams {
  provider: string;
  model?: string;
  fullWidth?: number;
  closeup?: boolean;
  snapColors?: boolean;
  structured?: boolean;
  collectionMode?: boolean;
  cropTargetColor?: string;
  polishType?: string;
  polishFinishes?: string[];
  vendorHint?: string;
  expectedFeatures?: unknown;
  productName?: string;
  brand?: string;
}

/**
 * Fingerprint of the parameters.
 *
 * Anything that alters the prompt, the image sent, or the post-processing must
 * be in here, or a changed setting would silently serve a stale analysis —
 * which is worse than a cache miss, because it looks like it worked.
 */
export function paramsFingerprint(p: AnalysisCacheParams): string {
  const canonical = JSON.stringify({
    provider: p.provider,
    model: p.model ?? null,
    fullWidth: p.fullWidth ?? null,
    closeup: p.closeup ?? null,
    snapColors: p.snapColors ?? null,
    structured: p.structured ?? null,
    collectionMode: p.collectionMode ?? null,
    cropTargetColor: p.cropTargetColor ?? null,
    polishType: p.polishType ?? null,
    // Order must not matter: the same finishes listed differently are the same
    // request, and treating them as different would miss every time.
    polishFinishes: [...(p.polishFinishes ?? [])].sort(),
    vendorHint: p.vendorHint ?? null,
    expectedFeatures: p.expectedFeatures ?? null,
    productName: p.productName ?? null,
    brand: p.brand ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export const cacheKey = (imageIdentity: string, fingerprint: string) => `${imageIdentity}|${fingerprint}`;

interface Entry<V> { value: V; at: number }

/**
 * Bounded so a long-lived server cannot grow without limit. Eviction is oldest
 * -first, which suits the access pattern: a folder is analysed, reviewed, and
 * not usually revisited days later.
 */
const MAX_ENTRIES = Number(process.env.ANALYSIS_CACHE_MAX ?? 2000);
const store = new Map<string, Entry<unknown>>();

export function cacheGet<V>(key: string): V | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  // Refresh recency so an actively reused entry is not evicted under pressure.
  store.delete(key);
  store.set(key, hit);
  return hit.value as V;
}

export function cacheSet<V>(key: string, value: V): void {
  if (store.has(key)) store.delete(key);
  store.set(key, { value, at: Date.now() });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export const cacheStats = () => ({ entries: store.size, max: MAX_ENTRIES });
