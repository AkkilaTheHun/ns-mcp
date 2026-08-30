/**
 * assign_shades — identify which shade each photograph in a folder shows,
 * against a supplied set of candidate descriptions.
 *
 * This is the CONSTRAINED counterpart to analyze_images. analyze_images asks
 * "what is this polish?" open-endedly, which is what a similar-shade
 * recommender needs. This asks "which of these N is it?", which is what
 * ingesting a collection needs — a different and much easier question, and one
 * where the model's own impression should be undervalued relative to the
 * candidate descriptions.
 *
 * ALL JUDGEMENT LIVES IN src/vision/assign-shades.ts. This tool only fetches
 * bytes and hands them over. That separation is deliberate: the pipeline
 * previously lived in a local script, so an agent calling this server got the
 * per-frame prompt and none of the grouping — no vetoes, no burst
 * reconciliation, no matching. The server advertised a capability it did not
 * have and failed silently. Nothing that changes an outcome may be added here.
 *
 * Works against Dropbox or Drive, because the pipeline never sees a path — only
 * an id, an optional order, an optional timestamp, and bytes.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { listOwnFolderImages, downloadOwnFile } from "../../dropbox/client.js";
import { listFolderImages, downloadFile } from "../../google/drive.js";
import { assignShades, type ShadeCandidate } from "../../vision/assign-shades.js";
import { buildIndexSheet, type Exemplar } from "../../vision/index-sheet.js";
import { isDropboxSource } from "../../dropbox/source.js";

const isDropbox = isDropboxSource;
const dropboxPath = (source: string) => source.replace(/^dropbox:/i, "");

/**
 * Long-edge 1568px is the tier Claude downscales to, so sending more is wasted
 * and sending less discards flake and shimmer detail the task depends on.
 */
async function prep(buf: Buffer): Promise<Buffer> {
  return sharp(buf, { failOn: "none" })
    .rotate()
    .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function listImages(source: string): Promise<Array<{ id: string; fetch: () => Promise<Buffer> }>> {
  if (isDropbox(source)) {
    const files = await listOwnFolderImages(dropboxPath(source));
    return files.map((f) => ({ id: f.name, fetch: () => downloadOwnFile(f.path) }));
  }
  const files = await listFolderImages(source);
  return files.map((f: any) => ({ id: f.name, fetch: () => downloadFile(f.id) }));
}

export function registerAssignShadesGateway(server: McpServer) {
  server.registerTool(
    "assign_shades",
    {
      title: "Assign photographs to shades",
      description:
        "Identify which shade each photo in a folder shows, given the candidate descriptions. Use this when ingesting a known collection — it is far more accurate than analyze_images for that, because it treats the candidate list as a constraint rather than guessing open-endedly. Handles one photographer's shoot at a time: lighting and skin tone are constant within a shoot, which makes relative judgement possible. Supply exemplarFolder once you have verified frames — a visual index measurably improves accuracy over descriptions alone. Returns per-frame assignments plus flags marking which frames deserve a human look.",
      inputSchema: {
        source: z
          .string()
          .describe("Folder holding ONE photographer's shoot. Dropbox path (starts with /) or Google Drive folder id."),
        shades: z
          .array(
            z.object({
              name: z.string().describe("Exact shade name, used verbatim in the output"),
              description: z.string().describe("The maker's description, verbatim — do not paraphrase"),
              polishType: z.string().optional().describe("creme, crelly, jelly, topper, magnetic, thermal, holo... Operator ground truth; lets absences be asserted that prose never states"),
              uniqueKey: z.string().optional().describe("One line on what sets this shade apart from every other candidate"),
            }),
          )
          .min(2)
          .describe("The candidate shades. Accuracy depends far more on these being verbatim and complete than on anything else."),
        exemplarFolder: z
          .string()
          .optional()
          .describe("Optional folder of VERIFIED frames, in per-shade subfolders named exactly as the shades. Builds a visual index. Never point this at unverified output — it teaches the model its own mistakes."),
        corrections: z
          .record(z.string(), z.string())
          .optional()
          .describe("Operator answers as {filename: shadeName}. Applied last and always win."),
        confusablePairs: z
          .array(z.object({
            pair: z.tuple([z.string(), z.string()]),
            discriminator: z.string().describe("The ONE feature that separates them, e.g. 'magnetic band colour'"),
            values: z.record(z.string(), z.string()).describe("What each shade holds for that feature, keyed by shade name"),
          }))
          .optional()
          .describe("Pairs that get confused, each decided by a single feature. Worth real accuracy — omitting this cost ~17 points on a verified shoot."),
        readingNotes: z
          .array(z.string())
          .optional()
          .describe("Concrete worked examples of errors made on THIS collection, e.g. 'frames that read BLUE were mulberry base packed with BLUE shimmer, not a blue-based shade'. Measured at +7 points. Keep them few and specific — prompt length is a real budget."),
        model: z.string().optional().describe("Defaults to claude-opus-5. Opus is markedly more CONSISTENT run to run, which matters more than raw accuracy when errors need diagnosing."),
        batchSize: z.number().optional().describe("Frames per vision call (default 12)"),
      },
    },
    async ({ source, shades, exemplarFolder, corrections, confusablePairs, readingNotes, model, batchSize }) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return { content: [{ type: "text", text: "ANTHROPIC_API_KEY is not configured on the server." }], isError: true };
      }

      // Progress goes to stdout so `docker logs -f` shows the run advancing.
      // Without it this tool is silent for minutes while it downloads frames
      // and calls the vision API, which is indistinguishable from being hung.
      const t0 = Date.now();
      const log = (m: string) => console.log(`[assign_shades] ${m}`);
      log(`start: ${source} against ${shades.length} candidate shade(s)`);

      const listed = await listImages(source);
      if (!listed.length) {
        return { content: [{ type: "text", text: `No images found in ${source}` }], isError: true };
      }

      log(`${listed.length} image(s) found; downloading`);
      const frames = [];
      for (const f of listed) {
        frames.push({ id: f.id, bytes: await prep(await f.fetch()) });
        if (frames.length % 10 === 0) log(`downloaded ${frames.length}/${listed.length}`);
      }
      log(`downloaded ${frames.length}/${listed.length}`);

      // Optional visual index, built from verified exemplars only.
      let indexSheet: Buffer | null = null;
      let legend: string[] = [];
      if (exemplarFolder) {
        const exemplars: Exemplar[] = [];
        for (const shade of shades) {
          // Dropbox nests exemplars in per-shade subfolders. Drive is
          // addressed by folder id, so a per-shade path cannot be synthesised
          // from a name — Drive callers must pass a folder that is already the
          // shade's, or skip the index rather than get a silently wrong one.
          if (!isDropbox(exemplarFolder)) continue;
          const sub = `${dropboxPath(exemplarFolder)}/${shade.name.replace(/[?*:<>"|\\]/g, "").trim()}`;
          const files = await listImages(sub).catch(() => []);
          for (const f of files.slice(0, 12)) {
            exemplars.push({
              shade: shade.name,
              bytes: await f.fetch(),
              // Staged filenames carry the photographer, which lets exemplars
              // be spread across lighting conditions rather than angles alone.
              source: /_swatcher-(.+)\.\w+$/i.exec(f.id)?.[1] ?? f.id,
            });
          }
        }
        if (exemplars.length) {
          const built = await buildIndexSheet({ shades: shades.map((s) => s.name), exemplars });
          indexSheet = built.sheet;
          legend = built.legend;
          log(`index sheet built from ${exemplars.length} verified exemplar(s)`);
        } else {
          log(`exemplarFolder given but no exemplars found — running on descriptions alone`);
        }
      }

      const result = await assignShades({
        shades: shades as ShadeCandidate[],
        confusablePairs,
        readingNotes,
        frames,
        apiKey,
        indexSheet,
        corrections,
        model,
        batchSize,
        onProgress: (m) => log(m),
      });

      const tally = new Map<string, number>();
      for (const a of result.assignments) if (a.shade) tally.set(a.shade, (tally.get(a.shade) ?? 0) + 1);
      const flagged = result.assignments.filter((a) => a.flags.length);
      log(`done in ${Math.round((Date.now() - t0) / 1000)}s — ${result.assignments.length} frames, ${result.diagnostics.shadesFound} shades, ${flagged.length} flagged`);

      const lines = [
        `${result.assignments.length} frames -> ${result.diagnostics.shadesFound} shades${indexSheet ? " (visual index used)" : " (descriptions only)"}`,
        "",
        ...[...tally.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${String(n).padStart(3)}  ${s}`),
        result.diagnostics.unplaced ? `  ${String(result.diagnostics.unplaced).padStart(3)}  UNPLACED` : "",
        "",
        result.diagnostics.notFound.length
          ? `Not present in this shoot: ${result.diagnostics.notFound.join(", ")} (a photographer may genuinely skip a shade)`
          : "",
        result.diagnostics.duplicatedShades.length
          ? `Shades claimed by more than one burst: ${result.diagnostics.duplicatedShades.map((d) => `${d.shade} x${d.bursts}`).join(", ")}`
          : "",
        result.diagnostics.rescuedFromStarvation
          ? `${result.diagnostics.rescuedFromStarvation} burst(s) kept their own vote where matching had no slot`
          : "",
        "",
        flagged.length ? `${flagged.length} frame(s) worth a human look:` : "No frames flagged.",
        ...flagged.map((a) => `  ${a.id}  -> ${a.shade ?? "UNPLACED"}  [${a.flags.join(", ")}]\n      "${a.reason}"`),
        legend.length ? `\nIndex built from:\n${legend.map((l) => `  ${l}`).join("\n")}` : "",
      ].filter(Boolean);

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify({ assignments: result.assignments, bursts: result.bursts, diagnostics: result.diagnostics }, null, 2) },
        ],
      };
    },
  );
}
