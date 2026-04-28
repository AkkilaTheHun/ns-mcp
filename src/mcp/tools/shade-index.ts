/**
 * shade_index — store and search nail polish shade signatures in Supabase pgvector.
 *
 * Actions:
 *   add_image        Index an analyzed image to a specific shade. Creates the shade
 *                    row on first sight, then upserts an image_signatures row.
 *   identify         Given a vision analysis (or features), return top-K nearest
 *                    catalog shades by cosine similarity.
 *   list_shades      Browse the catalog (paginated). Filter by brand if desired.
 *   get_shade        Fetch full attributes + image count for a single shade.
 *   feedback         Record a user-confirmed shade match (training data for tier 2).
 *   recompute_shade  Recompute aggregate shade_signatures fields from its image_signatures.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSupabase, isSupabaseConfigured } from "../../supabase/client.js";
import { recomputeShadeAggregate } from "../../supabase/recompute.js";
import {
  extractAndEmbed,
  type ImageAnalysisLike,
} from "../../util/feature-extract.js";

interface ShadeRow {
  id: number;
  brand: string;
  shade_name: string;
  collection: string | null;
  shopify_product_id: string | null;
  shopify_handle: string | null;
  base_color_hex: string | null;
  base_color_lab: number[] | null;
  finish_type: string | null;
  has_ultrachrome: boolean;
  has_iridescent: boolean;
  has_holographic: boolean;
  has_thermal: boolean;
  has_magnetic: boolean;
  flake_size: string | null;
  flake_colors_hex: string[] | null;
  attrs: Record<string, unknown> | null;
  embedding: number[] | string | null;
  photo_count: number;
  created_at: string;
  updated_at: string;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string, isError = true) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

/**
 * Find or create a shade_signatures row by (brand, shade_name).
 * Returns the row id and whether it was newly created.
 */
async function upsertShadeRow(params: {
  brand: string;
  shadeName: string;
  collection?: string;
  shopifyProductId?: string;
  shopifyHandle?: string;
}): Promise<{ id: number; created: boolean }> {
  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from("shade_signatures")
    .select("id")
    .eq("brand", params.brand)
    .eq("shade_name", params.shadeName)
    .maybeSingle();

  if (existing?.id) return { id: existing.id, created: false };

  const { data, error } = await supabase
    .from("shade_signatures")
    .insert({
      brand: params.brand,
      shade_name: params.shadeName,
      collection: params.collection ?? null,
      shopify_product_id: params.shopifyProductId ?? null,
      shopify_handle: params.shopifyHandle ?? null,
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Failed to create shade row: ${error?.message ?? "unknown"}`);
  return { id: data.id, created: true };
}

function parseEmbedding(raw: number[] | string | null): number[] | null {
  if (raw === null) return null;
  if (Array.isArray(raw)) return raw;
  // pgvector returns vectors as "[0.1,0.2,...]" strings via PostgREST
  try {
    return JSON.parse(raw) as number[];
  } catch {
    return null;
  }
}

export function registerShadeIndexTool(server: McpServer): void {
  server.tool(
    "shade_index",
    `Store and search nail polish shade signatures in pgvector.

Use this to build a searchable catalog of shades from analyze_images output, and
later identify shades from new user-submitted photos via nearest-neighbor lookup.

Actions:
- add_image: Index one analyzed image to a shade. Pass brand + shadeName + the
  ImageAnalysis output (dominantColors, observedEffects, altText, confidence).
  Creates the shade row on first sight, inserts an image_signatures row, and
  recomputes the shade aggregate. Optionally include shopify product info.
- identify: Given an analysis (or pre-built embedding), return the top-K nearest
  shades. Use this when a user submits a photo of nails or a bottle and you want
  to suggest possible matches. Returns each candidate with similarity score.
- list_shades: Browse catalog. Filter by brand. Paginated.
- get_shade: Full record + image_signatures count for one shade.
- recompute_shade: Force aggregate recomputation for one shade.
- feedback: Record user confirmation/correction of a predicted match.`,
    {
      action: z.enum(["add_image", "identify", "list_shades", "get_shade", "recompute_shade", "feedback"]),

      // add_image / identify shared
      brand: z.string().optional(),
      shadeName: z.string().optional().describe("Required for add_image; optional filter for list_shades"),
      collection: z.string().optional(),
      shopifyProductId: z.string().optional(),
      shopifyHandle: z.string().optional(),

      // image analysis input (analyze_images output)
      analysis: z.object({
        dominantColors: z.array(z.union([
          z.string(),
          z.object({ hex: z.string().optional(), label: z.string() }),
        ])),
        observedEffects: z.array(z.string()),
        altText: z.string().optional(),
        confidence: z.number().optional(),
        imageType: z.string().optional(),
        lightingCondition: z.string().optional(),
        skinTone: z.string().nullable().optional(),
        nailCount: z.number().optional(),
      }).optional(),

      // add_image extras
      sourcePath: z.string().optional().describe("dropbox path, shopify file URL, or external URL"),
      swatcherHandle: z.string().optional(),
      visionProvider: z.string().optional(),
      visionModel: z.string().optional(),

      // identify extras
      topK: z.number().optional().default(5),
      brandFilter: z.string().optional().describe("Limit identify results to this brand"),

      // list_shades
      limit: z.number().optional().default(50),
      offset: z.number().optional().default(0),

      // get_shade / recompute_shade / feedback
      shadeId: z.number().optional(),

      // feedback
      predictedShadeId: z.number().optional(),
      confirmedShadeId: z.number().optional(),
      similarityScore: z.number().optional(),
      userPhotoUrl: z.string().optional(),
      userId: z.string().optional(),
    },
    async (p) => {
      if (!isSupabaseConfigured()) {
        return fail("Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.");
      }
      const supabase = getSupabase();

      try {
        switch (p.action) {

          // ---------------------------------------------------------------
          case "add_image": {
            if (!p.brand || !p.shadeName || !p.analysis || !p.sourcePath) {
              return fail("add_image requires brand, shadeName, analysis, and sourcePath");
            }

            const features = extractAndEmbed(p.analysis as ImageAnalysisLike);
            const { id: shadeId, created } = await upsertShadeRow({
              brand: p.brand,
              shadeName: p.shadeName,
              collection: p.collection,
              shopifyProductId: p.shopifyProductId,
              shopifyHandle: p.shopifyHandle,
            });

            const { error: insertErr } = await supabase.from("image_signatures").insert({
              shade_id: shadeId,
              source_path: p.sourcePath,
              swatcher_handle: p.swatcherHandle ?? null,
              image_type: p.analysis.imageType ?? null,
              lighting_condition: p.analysis.lightingCondition ?? null,
              skin_tone: p.analysis.skinTone ?? null,
              nail_count: p.analysis.nailCount ?? null,
              dominant_colors: p.analysis.dominantColors,
              observed_effects: p.analysis.observedEffects,
              alt_text: p.analysis.altText ?? null,
              confidence: p.analysis.confidence ?? null,
              vision_provider: p.visionProvider ?? null,
              vision_model: p.visionModel ?? null,
              base_color_hex: features.baseColorHex ?? null,
              base_color_lab: features.baseColorLab,
              embedding: features.embedding,
            });
            if (insertErr) return fail(`Failed to insert image_signatures: ${insertErr.message}`);

            await recomputeShadeAggregate(shadeId);

            return ok({
              shadeId,
              shadeCreated: created,
              brand: p.brand,
              shadeName: p.shadeName,
              extractedAttrs: features.flake,
              baseColorHex: features.baseColorHex,
              embeddingDims: features.embedding.length,
            });
          }

          // ---------------------------------------------------------------
          case "identify": {
            if (!p.analysis) {
              return fail("identify requires analysis (the analyze_images output for the user photo)");
            }
            const features = extractAndEmbed(p.analysis as ImageAnalysisLike);
            const topK = p.topK ?? 5;

            // For POC scale (hundreds of shades) we fetch all candidate rows and
            // rank in-process. Once the catalog grows past a few thousand shades,
            // switch this to a Postgres RPC that uses the HNSW index directly via
            // the `<=>` operator.
            let q = supabase
              .from("shade_signatures")
              .select("id, brand, shade_name, collection, base_color_hex, finish_type, has_ultrachrome, has_iridescent, has_holographic, has_thermal, has_magnetic, flake_size, photo_count, embedding")
              .not("embedding", "is", null);
            if (p.brandFilter) q = q.eq("brand", p.brandFilter);

            const { data: shades, error } = await q;
            if (error) return fail(`Identify query failed: ${error.message}`);
            if (!shades || !shades.length) return ok({ matches: [], note: "No shade signatures indexed yet" });

            const userEmb = features.embedding;
            const ranked = shades
              .map((s) => {
                const e = parseEmbedding(s.embedding as number[] | string | null);
                if (!e || e.length !== userEmb.length) return null;
                const distance = cosineDistance(userEmb, e);
                return {
                  shadeId: s.id,
                  brand: s.brand,
                  shadeName: s.shade_name,
                  collection: s.collection,
                  baseColorHex: s.base_color_hex,
                  finishType: s.finish_type,
                  attrs: {
                    ultrachrome: s.has_ultrachrome,
                    iridescent: s.has_iridescent,
                    holographic: s.has_holographic,
                    thermal: s.has_thermal,
                    magnetic: s.has_magnetic,
                  },
                  flakeSize: s.flake_size,
                  photoCount: s.photo_count,
                  similarity: 1 - distance,
                  distance,
                };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null)
              .sort((a, b) => a.distance - b.distance)
              .slice(0, topK);

            return ok({
              query: {
                baseColorHex: features.baseColorHex,
                attrs: features.flake,
              },
              matches: ranked,
            });
          }

          // ---------------------------------------------------------------
          case "list_shades": {
            const limit = p.limit ?? 50;
            const offset = p.offset ?? 0;
            let q = supabase
              .from("shade_signatures")
              .select("id, brand, shade_name, collection, base_color_hex, finish_type, photo_count, has_ultrachrome, has_iridescent", { count: "exact" })
              .order("brand", { ascending: true })
              .order("shade_name", { ascending: true })
              .range(offset, offset + limit - 1);
            if (p.brand) q = q.eq("brand", p.brand);
            const { data, count, error } = await q;
            if (error) return fail(`list_shades failed: ${error.message}`);
            return ok({ total: count, returned: data?.length ?? 0, limit, offset, shades: data });
          }

          // ---------------------------------------------------------------
          case "get_shade": {
            if (!p.shadeId && !(p.brand && p.shadeName)) {
              return fail("get_shade requires shadeId, or both brand + shadeName");
            }
            let q = supabase.from("shade_signatures").select("*").limit(1);
            q = p.shadeId
              ? q.eq("id", p.shadeId)
              : q.eq("brand", p.brand!).eq("shade_name", p.shadeName!);
            const { data: shadeData, error } = await q.maybeSingle();
            if (error) return fail(`get_shade failed: ${error.message}`);
            if (!shadeData) return fail(`Shade not found`);

            const shade = shadeData as ShadeRow;
            const { data: imgs, error: imgErr, count } = await supabase
              .from("image_signatures")
              .select("id, source_path, swatcher_handle, image_type, alt_text, confidence, analyzed_at", { count: "exact" })
              .eq("shade_id", shade.id)
              .order("analyzed_at", { ascending: false })
              .limit(20);
            if (imgErr) return fail(`get_shade image lookup failed: ${imgErr.message}`);

            return ok({
              shade,
              imageCount: count ?? 0,
              recentImages: imgs ?? [],
            });
          }

          // ---------------------------------------------------------------
          case "recompute_shade": {
            if (!p.shadeId) return fail("recompute_shade requires shadeId");
            await recomputeShadeAggregate(p.shadeId);
            return ok({ shadeId: p.shadeId, recomputed: true });
          }

          // ---------------------------------------------------------------
          case "feedback": {
            if (!p.confirmedShadeId) return fail("feedback requires confirmedShadeId");
            const { error: feedbackErr } = await supabase.from("match_feedback").insert({
              user_photo_url: p.userPhotoUrl ?? null,
              predicted_shade_id: p.predictedShadeId ?? null,
              confirmed_shade_id: p.confirmedShadeId,
              similarity_score: p.similarityScore ?? null,
              user_id: p.userId ?? null,
            });
            if (feedbackErr) return fail(`feedback insert failed: ${feedbackErr.message}`);
            return ok({ recorded: true });
          }

          default:
            return fail(`Unknown action: ${p.action}`);
        }
      } catch (err) {
        return fail(`shade_index error: ${err}`, true);
      }
    },
  );
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
