/**
 * assignShades — identify which shade each photograph shows, given a set of
 * candidate descriptions.
 *
 * THIS IS THE WHOLE PIPELINE. Nothing that affects the outcome lives anywhere
 * else.
 *
 * It previously lived inside a local script, which meant an agent calling the
 * MCP server got the per-frame prompt and none of the grouping: no vetoes, no
 * burst reconciliation, no matching, no guards. The server advertised a
 * capability it did not have, and the failure was silent — output looked
 * plausible and was wrong. So the rule here is that the script and the MCP tool
 * both call THIS function and neither adds behaviour of its own.
 *
 * NO I/O, NO FILESYSTEM, NO PROVIDER
 * ----------------------------------
 * Frames arrive as bytes with an optional order and timestamp. Dropbox, Drive,
 * a local folder and a list of URLs all reduce to that, so the caller owns
 * fetching and this owns judgement. Collection data — descriptions, polish
 * types, operator corrections — arrives as ARGUMENTS, never as a file read, so
 * the same code serves any brand.
 *
 * ORDER OF OPERATIONS
 *   1. per-frame analysis, batched, with an optional visual index
 *   2. segment into bursts (runs of one shade)
 *   3. score bursts x shades from confidence-weighted votes
 *   4. optional deterministic accent evidence
 *   5. global 1:1 matching, then resolution that never starves a burst
 *   6. per-frame guards that stop a burst overwriting a dissenting frame
 *   7. operator corrections, which always win
 */
import Anthropic from "@anthropic-ai/sdk";
import { segmentBursts, timeFromFilename, type Burst } from "./group.js";
import { parseAll, type Signature } from "./signature.js";
import { vetoesFor } from "./veto.js";
import { detectAccents, resolvePair, type AccentSpec } from "./accent.js";
import { solveAssignment } from "../util/assignment.js";

export interface ShadeCandidate {
  name: string;
  /** The maker's description, verbatim. */
  description: string;
  /** Operator ground truth when known: creme, crelly, magnetic, thermal, topper... */
  polishType?: string;
  /** Optional one-line discriminator that sets this shade apart from the rest. */
  uniqueKey?: string;
}

export interface InputFrame {
  /** Stable identifier — filename, file id, URL. Returned untouched. */
  id: string;
  bytes: Buffer;
  /** Position in shooting order. Falls back to the id's "(N)" suffix, then array order. */
  order?: number;
  /** Capture time, epoch ms. Falls back to a timestamp parsed from the id. */
  time?: number | null;
}

export interface FrameAssignment {
  id: string;
  shade: string | null;
  confidence: number;
  alternative: string | null;
  reason: string;
  /** What the model said before any group reasoning touched it. */
  rawShade: string | null;
  /** The model's ORIGINAL wording, before any prefixing or clearing. */
  rawReason: string;
  /** Why this frame may deserve a human look. */
  flags: string[];
}

export interface AssignOptions {
  shades: ShadeCandidate[];
  frames: InputFrame[];
  apiKey: string;

  /**
   * Numbered reference photographs of the candidates, as one image.
   *
   * Worth real accuracy: without it every frame is matched against PROSE, and
   * the model must imagine what a description looks like on a nail at an
   * unknown angle. Build with buildIndexSheet() from VERIFIED frames only — an
   * index built from guesses teaches the model its own mistakes.
   */
  indexSheet?: Buffer | null;

  /** Operator answers, id -> shade. Applied last; always win. */
  corrections?: Record<string, string>;

  /** Confusable pairs separated by a saturated, hue-distant accent. */
  accents?: Record<string, AccentSpec[]>;

  /**
   * Pairs the model confuses, each decided by ONE feature.
   *
   * Supplied by the caller rather than derived, because knowing WHICH pairs
   * collide is operator knowledge. Measured to matter: removing this block and
   * the worked examples below cost ~17 points on a verified shoot, and the
   * errors that returned were precisely the pairs it names.
   */
  confusablePairs?: Array<{ pair: [string, string]; discriminator: string; values: Record<string, string> }>;

  /**
   * Concrete worked examples of mistakes made on THIS collection.
   *
   * Measured at +7.1 points when present. Twice in this project a concrete
   * example beat an abstract rule by a wide margin — an abstract instruction
   * competes with every other instruction, while "frames that read BLUE were
   * actually mulberry-base-with-blue-shimmer" is directly applicable. Keep them
   * specific and few; prompt length is a real budget.
   */
  readingNotes?: string[];

  model?: string;
  batchSize?: number;
  /** Minutes of silence implying a polish change. */
  gapMinutes?: number;
  onProgress?: (message: string) => void;
}

export interface AssignResult {
  assignments: FrameAssignment[];
  /** Frame ids per burst, so grouping decisions are inspectable. */
  bursts: string[][];
  diagnostics: {
    shadesFound: number;
    notFound: string[];
    unplaced: number;
    rescuedFromStarvation: number;
    duplicatedShades: Array<{ shade: string; bursts: number }>;
    protectedFrames: string[];
    needsReview: string[];
  };
}

const DEFAULTS = {
  model: "claude-opus-5",
  batchSize: 12,
  gapMinutes: 5,
  minEvidence: 0.8,
  overrideMargin: 0.5,
  /** Confidence at which a frame's own reading outranks its burst. */
  highConfidenceDissent: 0.9,
  accentBonus: 1.0,
};

/** Prompt text describing the candidate set and how these polishes behave. */
function buildInstructions(
  shades: ShadeCandidate[],
  signatures: Signature[],
  confusablePairs?: AssignOptions["confusablePairs"],
  readingNotes?: string[],
): string {
  const list = shades
    .map((s, i) =>
      `${i + 1}. ${s.name}\n   ${s.uniqueKey ? `KEY: ${s.uniqueKey}\n   ` : ""}vendor: "${s.description}"${s.polishType ? `\n   type: ${s.polishType}` : ""}`)
    .join("\n\n");

  const clearBase = signatures
    .filter((s) => s.facts.some((f) => f.attribute === "base" && f.value === "clear"))
    .map((s) => s.shade);

  const travelling = signatures.filter((s) => s.facts.some((f) => f.attribute === "travel" && f.value === "yes")).map((s) => s.shade);
  const single = signatures.filter((s) => s.facts.some((f) => f.attribute === "travel" && f.value === "no")).map((s) => s.shade);

  const pairs = (confusablePairs ?? [])
    .map((p) => `- ${p.pair[0]} vs ${p.pair[1]} -> decided by ${p.discriminator}:\n    ${p.pair[0]}: ${p.values[p.pair[0]] ?? "?"}\n    ${p.pair[1]}: ${p.values[p.pair[1]] ?? "?"}`)
    .join("\n");

  return `You are identifying which shade each photograph shows, from a known set of candidates.

THE CANDIDATES:
${list}

DOES THE SHIMMER TRAVEL? A shimmer described as "X to Y" changes colour with angle and shows BOTH colours across a set of frames; a shimmer described as one colour stays that colour.
- SINGLE-colour shimmer: ${single.join("; ") || "(none)"}
- TRAVELLING shimmer: ${travelling.join("; ") || "(none)"}

${pairs ? `CONFUSABLE PAIRS — each is decided by ONE feature. Check that feature specifically rather than weighing overall impression:\n${pairs}\n` : ""}
THE MOST IMPORTANT RULE — THE COLOUR FILLING THE FRAME IS USUALLY THE EFFECT, NOT THE BASE.
"Packed with" means the effect is dense enough to cover the base at nearly every angle, so your first impression of "what colour is this polish" is usually the SHIMMER. Naming the shade after it is the single most common way to get this wrong.

${readingNotes?.length ? `Verified against operator-identified frames from this exact collection:\n${readingNotes.map((n) => `- ${n}`).join("\n")}\n` : ""}
Work in this order:
1. Identify the SHIMMER colour first, and whether it is one colour or travels between two.
2. Then hunt for the BASE where the shimmer is NOT firing: the cuticle edge, the very tip, shadowed areas, steeply-angled nails, and the RIM OF THE BOTTLE. Do not read the base from the flattest, brightest or largest area — that is where the shimmer is strongest.
3. Match on the PAIR (base + effect). Either alone is usually ambiguous.
4. If you cannot find the base anywhere, say so and lower confidence rather than reporting the shimmer colour as the base.

HOW THESE POLISHES BEHAVE:
- These are interference pigments. Their colour CHANGES WITH ANGLE — that is the product working, not two different polishes. Judge on the COMBINATION of base and effect across frames, never on whichever colour fills the most pixels in one frame.
- MAGNETIC: particles pulled into a bright concentrated band, with a duller field either side. Band position varies per frame, and its colour shifts with angle. IN THE BOTTLE there is no band at all — bottle polish is unmagnetised, so absence of a band never rules out a magnetic shade.
- THERMAL: two states; a frame may show one, the other, or a transition. A single-state frame still belongs to that thermal.
${clearBase.length ? `- CLEAR-BASE SHADES (${clearBase.join(", ")}): the particles ARE the product and the base contributes no colour. ANY colour you see comes from somewhere else — the bare nail, a base coat, or another polish underneath. Identify these by their PARTICLES ONLY.
- That cuts the other way too: if you are describing a colour AND a scatter of particles that do not belong to that colour — "lavender base with fine holographic scatter" — consider a clear-base shade worn OVER a lavender polish before concluding the shade itself is lavender.` : ""}
- Bottle and nails routinely read as different colours in the same frame. Both are the same polish.

WHAT YOU CAN RELY ON:
- These frames are from ONE session, so lighting, camera, skin tone and nail shape are constant. Compare frames against EACH OTHER, not only against the descriptions. Relative judgement is far more reliable here than absolute colour.
- Do NOT assume every candidate was photographed. Some may be absent entirely and some may appear more than once. Never assign a shade merely because it is otherwise unclaimed.
- The lighting may be poor. Bad light changes BASE and SHIMMER colour a lot, and particle colour and magnetic bands very little. When the light looks off, lean on the particles and lower your confidence in the base reading. Do NOT revise what you saw to fit a description.
- The images are in shooting order. Consecutive frames are usually the same shade from different angles.`;
}

const INDEX_GUIDANCE = `
USE THE REFERENCE INDEX — THIS IS THE MOST RELIABLE SIGNAL YOU HAVE.

For every image, work in two steps:
STEP 1. Describe what you actually see, in your own words, without looking at the candidate list.
STEP 2. Compare that against the numbered reference photographs. Which index shade does this frame most RESEMBLE as a photograph? Comparing a photo to a photo is far more reliable than matching a photo to a written description.

Where your reading of the words and your reading of the pictures disagree, TRUST THE PICTURES.

Two cautions:
- Each shade shows only a couple of its possible angles. A frame at a different angle can still be that shade, so look for the same COMBINATION of base and effect, not an identical colour.
- Reference frames come from other hands and other lighting. Do not reject a match because skin tone or brightness differs.`;

interface RawVote {
  id: string;
  shade: string | null;
  confidence: number;
  alternative: string | null;
  reason: string;
}

async function analyseBatch(
  client: Anthropic,
  model: string,
  instructions: string,
  indexSheet: Buffer | null | undefined,
  batch: InputFrame[],
  soFar: Map<string, number>,
  batchNo: number,
  totalBatches: number,
): Promise<RawVote[]> {
  const content: any[] = [];

  if (indexSheet) {
    content.push({ type: "text", text: "REFERENCE INDEX — verified photographs of every candidate, numbered. Each shade shows two frames from two different photographers, so you can see how much it varies with lighting and angle." });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: indexSheet.toString("base64") } });
  }

  // Images before text: documented to perform better than text-first.
  for (let i = 0; i < batch.length; i++) {
    content.push({ type: "text", text: `Image ${i + 1} — ${batch[i].id}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: batch[i].bytes.toString("base64") } });
  }

  const progress = soFar.size
    ? `\n\nALREADY IDENTIFIED EARLIER IN THIS SAME SHOOT:\n${[...soFar.entries()].map(([k, v]) => `- ${k}: ${v} frame(s)`).join("\n")}\nShades not yet seen are more likely among these frames, but do not force a match.`
    : "";

  content.push({ type: "text", text: `${instructions}${indexSheet ? INDEX_GUIDANCE : ""}

This is batch ${batchNo} of ${totalBatches}, ${batch.length} images shown above in shooting order.${progress}

Return ONLY a JSON array with one object per image, in order, no fencing:
[{"image": 1, "shade": "<name or null>", "confidence": 0.0, "alternative": "<name or null>", "reason": "max 15 words citing the features you used"}]` });

  const res = await client.messages.create({ model, max_tokens: 8000, messages: [{ role: "user", content }] });
  const blk = res.content.find((x) => x.type === "text");
  const text = (blk && "text" in blk ? blk.text : "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // Salvage object-by-object so a truncated array does not lose the batch.
  let arr: any[] = [];
  try { arr = JSON.parse(text); } catch {
    arr = [...text.matchAll(/\{[^{}]*"shade"[^{}]*\}/g)]
      .map((m) => { try { return JSON.parse(m[0]); } catch { return null; } })
      .filter(Boolean) as any[];
  }
  const byIdx = new Map<number, any>();
  arr.forEach((o, i) => byIdx.set(typeof o?.image === "number" ? o.image - 1 : i, o));

  return batch.map((f, i) => ({
    id: f.id,
    shade: byIdx.get(i)?.shade ?? null,
    confidence: typeof byIdx.get(i)?.confidence === "number" ? byIdx.get(i).confidence : 0,
    alternative: byIdx.get(i)?.alternative ?? null,
    reason: byIdx.get(i)?.reason ?? "no result returned",
  }));
}

export async function assignShades(opts: AssignOptions): Promise<AssignResult> {
  const model = opts.model ?? DEFAULTS.model;
  const batchSize = opts.batchSize ?? DEFAULTS.batchSize;
  const log = opts.onProgress ?? (() => {});
  const client = new Anthropic({ apiKey: opts.apiKey });

  const shadeNames = opts.shades.map((s) => s.name);
  const signatures = parseAll(
    Object.fromEntries(opts.shades.map((s) => [s.name, { vendorDescription: s.description, polishType: s.polishType }])),
  );
  const instructions = buildInstructions(opts.shades, signatures, opts.confusablePairs, opts.readingNotes);

  // Shooting order.
  //
  // THE CALLER'S ARRAY ORDER IS AUTHORITATIVE unless it supplies an explicit
  // `order`. Re-deriving order from the filename looks helpful and is not: a
  // real shoot contains "...(24) (1).jpg" for a duplicate of frame 24, where
  // the trailing "(1)" parses as position 1 and collides with the real frame 1,
  // while an unsuffixed base file parses as nothing at all. That scrambled the
  // sequence, and since burst segmentation depends entirely on consecutive
  // frames, one burst then swallowed half the shoot.
  //
  // Callers that have no meaningful order can use orderFromFilename() from
  // ./group.js deliberately, having checked it suits their filenames.
  const frames = opts.frames
    .map((f, i) => ({
      ...f,
      order: f.order ?? i,
      time: f.time ?? timeFromFilename(f.id),
    }))
    .sort((a, b) => a.order - b.order);

  // --- 1. per-frame analysis ------------------------------------------------
  const votes: RawVote[] = [];
  const tally = new Map<string, number>();
  const totalBatches = Math.ceil(frames.length / batchSize);
  for (let i = 0; i < frames.length; i += batchSize) {
    const batch = frames.slice(i, i + batchSize);
    const out = await analyseBatch(client, model, instructions, opts.indexSheet, batch, tally, Math.floor(i / batchSize) + 1, totalBatches);
    for (const r of out) if (r.shade) tally.set(r.shade, (tally.get(r.shade) ?? 0) + 1);
    votes.push(...out);
    log(`batch ${Math.floor(i / batchSize) + 1}/${totalBatches}`);
  }

  const rawShade = new Map(votes.map((v) => [v.id, v.shade]));
  const rawReason = new Map(votes.map((v) => [v.id, v.reason]));
  const byId = new Map(votes.map((v) => [v.id, { ...v }]));

  // --- 2. bursts ------------------------------------------------------------
  const bursts: Burst[] = segmentBursts(frames, {
    gapMinutes: opts.gapMinutes ?? DEFAULTS.gapMinutes,
    labels: frames.map((f) => byId.get(f.id)?.shade ?? null),
  });

  // --- 3. score matrix ------------------------------------------------------
  const score: number[][] = bursts.map((b) => {
    const row = new Array(shadeNames.length).fill(0);
    for (const i of b.idx) {
      const v = byId.get(frames[i].id);
      if (!v) continue;
      const j = v.shade ? shadeNames.indexOf(v.shade) : -1;
      if (j >= 0) row[j] += v.confidence;
      // The runner-up is real evidence and costs nothing to include.
      const ja = v.alternative ? shadeNames.indexOf(v.alternative) : -1;
      if (ja >= 0) row[ja] += v.confidence * 0.25;
    }
    return row;
  });

  // --- 4. deterministic accent evidence ------------------------------------
  //
  // GATED: an accent pair breaks a tie between ITS OWN TWO shades and is not a
  // classifier. Applied ungated it is a forced choice even where neither
  // applies, which fired one shade across five unrelated bursts.
  const shadeOfAccent = (n: string) => /\(([^)]+)\)/.exec(n)?.[1] ?? "";
  if (opts.accents) {
    for (let bi = 0; bi < bursts.length; bi++) {
      const live = new Set<string>();
      for (const i of bursts[bi].idx) {
        const v = byId.get(frames[i].id);
        if (v?.shade) live.add(v.shade);
        if (v?.alternative) live.add(v.alternative);
      }
      const applicable = Object.values(opts.accents).filter((pair) => pair.every((a) => live.has(shadeOfAccent(a.name))));
      if (!applicable.length) continue;
      const rep = frames[bursts[bi].idx[Math.floor(bursts[bi].idx.length / 2)]];
      for (const pair of applicable) {
        const verdict = resolvePair(await detectAccents(rep.bytes, pair));
        if (!verdict.winner) continue;
        const j = shadeNames.indexOf(shadeOfAccent(verdict.winner));
        if (j >= 0) score[bi][j] += DEFAULTS.accentBonus;
      }
    }
  }

  // --- 5. matching, then resolution that never starves ----------------------
  const rawAssigned = solveAssignment(score);

  const resolutions = bursts.map((_, bi) => {
    const j = rawAssigned[bi];
    const matchScore = j >= 0 ? score[bi][j] : -Infinity;
    const votedJ = score[bi].indexOf(Math.max(...score[bi]));
    const votedScore = score[bi][votedJ];
    const voted = votedScore > 0 ? shadeNames[votedJ] : null;

    // Matching may not sacrifice a burst for a much worse shade, and may not
    // leave one empty when its own vote stands on its merits: segmentation
    // over-splits far more often than a photographer genuinely reshoots.
    const usable = j >= 0 && matchScore >= DEFAULTS.minEvidence && votedScore - matchScore <= DEFAULTS.overrideMargin;
    if (usable) return { shade: shadeNames[j], score: matchScore, source: "matching" as const, voted, votedScore };
    if (voted && votedScore >= DEFAULTS.minEvidence) return { shade: voted, score: votedScore, source: "own-vote" as const, voted, votedScore };
    return { shade: null, score: votedScore, source: "none" as const, voted, votedScore };
  });

  // --- 6. apply to frames, with the dissent guards --------------------------
  const protectedFrames: string[] = [];
  const needsReview: string[] = [];

  for (let bi = 0; bi < bursts.length; bi++) {
    const winner = resolutions[bi].shade;
    for (const i of bursts[bi].idx) {
      const id = frames[i].id;
      const v = byId.get(id)!;
      if (!winner) {
        // An abstaining burst must CLEAR its frames, not leave them holding a
        // per-frame guess that downstream would file as confident.
        if (v.shade) {
          v.reason = `unplaced (best shade scored ${resolutions[bi].votedScore.toFixed(2)}); model leaned ${v.shade}`;
          v.shade = null;
        }
        continue;
      }
      if (v.shade === winner) continue;

      // A frame whose own words rule out the burst's shade is not noise.
      if (vetoesFor(v.reason, signatures).some((x) => x.shade === winner)) {
        protectedFrames.push(`${id}: kept ${v.shade ?? "unplaced"} (text rules out ${winner})`);
        continue;
      }
      // Nor is a frame the model was emphatic about. Vocabulary can miss a
      // contradiction; confidence is independent of vocabulary.
      if (v.confidence >= DEFAULTS.highConfidenceDissent) {
        protectedFrames.push(`${id}: kept ${v.shade ?? "unplaced"} (own confidence ${v.confidence})`);
        continue;
      }
      v.shade = winner;
      v.reason = `burst+matching: ${v.reason}`;
    }
    if (!winner) needsReview.push(`burst of ${bursts[bi].idx.length} frame(s): best shade only scored ${resolutions[bi].votedScore.toFixed(2)}`);
  }

  // --- 7. operator corrections always win ----------------------------------
  if (opts.corrections) {
    for (const [id, shade] of Object.entries(opts.corrections)) {
      const v = byId.get(id);
      if (!v) continue;
      v.shade = shade;
      v.confidence = Math.max(v.confidence, 0.99);
      v.reason = "operator-confirmed";
    }
  }

  const assignments: FrameAssignment[] = frames.map((f) => {
    const v = byId.get(f.id)!;
    const flags: string[] = [];
    if (!v.shade) flags.push("unplaced");
    if (v.shade && vetoesFor(v.reason, signatures).some((x) => x.shade === v.shade)) flags.push("contradicts-own-description");
    if (v.shade && v.confidence < DEFAULTS.minEvidence) flags.push("low-confidence");
    return {
      id: f.id,
      shade: v.shade,
      confidence: v.confidence,
      alternative: v.alternative,
      reason: v.reason,
      rawShade: rawShade.get(f.id) ?? null,
      rawReason: rawReason.get(f.id) ?? v.reason,
      flags,
    };
  });

  const found = new Map<string, number>();
  for (const a of assignments) if (a.shade) found.set(a.shade, (found.get(a.shade) ?? 0) + 1);
  const claims = new Map<string, number>();
  for (const r of resolutions) if (r.shade) claims.set(r.shade, (claims.get(r.shade) ?? 0) + 1);

  return {
    assignments,
    bursts: bursts.map((b) => b.idx.map((i) => frames[i].id)),
    diagnostics: {
      shadesFound: found.size,
      notFound: shadeNames.filter((n) => !found.has(n)),
      unplaced: assignments.filter((a) => !a.shade).length,
      rescuedFromStarvation: resolutions.filter((r) => r.source === "own-vote").length,
      duplicatedShades: [...claims.entries()].filter(([, n]) => n > 1).map(([shade, n]) => ({ shade, bursts: n })),
      protectedFrames,
      needsReview,
    },
  };
}
