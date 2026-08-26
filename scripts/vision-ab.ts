/**
 * vision-ab — repeatable A/B harness for the image-analysis rework.
 *
 * Runs the SAME image through analyzeImage() N times under a named config,
 * writes every raw response to disk, and reports run-to-run variance plus the
 * downstream feature-extraction result (what shade_index would actually store).
 *
 * The point is to validate each change in vision-analysis-rework.md against
 * evidence rather than vibes: capture a labelled baseline, make one change,
 * capture again under a new label, then `compare` the two.
 *
 * Usage:
 *   pnpm tsx scripts/vision-ab.ts run --label baseline-gemini --provider gemini --runs 3
 *   pnpm tsx scripts/vision-ab.ts run --label s2-claude-1400 --provider claude --width 1400 --closeup --runs 3
 *   pnpm tsx scripts/vision-ab.ts compare baseline-gemini s2-claude-1400
 *   pnpm tsx scripts/vision-ab.ts list
 *
 * Image selection (one of):
 *   --dropbox "/path/to/file.jpg"     Dropbox path in the connected account
 *   --file    ./local.jpg             Local file
 * Downloads are cached under output/vision-ab/_cache so repeat runs cost
 * nothing but the vision call itself.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import sharp from "sharp";
import { downloadOwnFile, listOwnFolder } from "../src/dropbox/client.js";
import { analyzeImage as analyzeImageGemini, type ImageAnalysis } from "../src/google/vision.js";
import { analyzeImage as analyzeImageClaude } from "../src/anthropic/vision.js";
import { extractAndEmbed, labToHex, type ImageAnalysisLike } from "../src/util/feature-extract.js";
import { hexToLab, deltaE76, type Lab } from "../src/util/color.js";
import { buildPixelIndex, snapAnalysis } from "../src/vision/snap.js";

const OUT_ROOT = join(process.cwd(), "output", "vision-ab");
const CACHE = join(OUT_ROOT, "_cache");

interface RunConfig {
  label: string;
  provider: "gemini" | "claude";
  model?: string;
  width: number;
  closeup: boolean;
  productName: string;
  brand: string;
  vendorHint?: string;
  polishType?: string;
  shadeKey?: string;
  image: string;
  runs: number;
  collectionMode?: boolean;
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { cmd: string; rest: string[]; flags: Record<string, string | boolean> } {
  const cmd = argv[0] ?? "run";
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { cmd, rest, flags };
}

// ---------------------------------------------------------------------------
// image prep — mirrors processImage() in src/mcp/tools/ingest.ts
// ---------------------------------------------------------------------------

async function loadImage(spec: { dropbox?: string; file?: string }): Promise<{ buffer: Buffer; name: string }> {
  mkdirSync(CACHE, { recursive: true });

  if (spec.file) {
    return { buffer: readFileSync(spec.file), name: basename(spec.file) };
  }
  if (!spec.dropbox) throw new Error("Pass --dropbox <path> or --file <path>");

  const name = basename(spec.dropbox);
  const cached = join(CACHE, name);
  if (existsSync(cached)) {
    console.log(`[cache] ${name}`);
    return { buffer: readFileSync(cached), name };
  }
  console.log(`[dropbox] downloading ${spec.dropbox}`);
  const buffer = await downloadOwnFile(spec.dropbox);
  writeFileSync(cached, buffer);
  return { buffer, name };
}

async function prepare(raw: Buffer, width: number, closeup: boolean) {
  const rotated = sharp(raw, { failOn: "none" }).rotate();
  const full = await rotated.clone().resize({ width, withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  let crop: Buffer | undefined;
  if (closeup) {
    crop = await rotated.clone()
      .resize({ width: 800, height: 800, fit: "cover", position: sharp.strategy.attention })
      .jpeg({ quality: 92 })
      .toBuffer();
  }
  return { full, crop };
}

// ---------------------------------------------------------------------------
// derived metrics — what the index would actually store
// ---------------------------------------------------------------------------

function hexSaturation(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : Math.round(((max - min) / max) * 100);
}

interface Derived {
  baseColorHex?: string;
  baseColorLab: number[] | null;
  baseSaturationPct: number | null;
  finishType?: string;
  flakeSize: string;
  flakeColorsHex: string[];
  booleans: Record<string, boolean>;
}

function derive(a: ImageAnalysis): Derived {
  const f = extractAndEmbed(a as unknown as ImageAnalysisLike);
  const hex = f.baseColorHex;
  return {
    baseColorHex: hex,
    baseColorLab: f.baseColorLab ? f.baseColorLab.map((v) => Math.round(v * 10) / 10) : null,
    baseSaturationPct: hex ? hexSaturation(hex) : null,
    finishType: f.flake.finishType,
    flakeSize: f.flake.flakeSize,
    flakeColorsHex: f.flake.flakeColorsHex,
    booleans: {
      ultrachrome: f.flake.hasUltrachrome,
      iridescent: f.flake.hasIridescent,
      holographic: f.flake.hasHolographic,
      thermal: f.flake.hasThermal,
      magnetic: f.flake.hasMagnetic,
    },
  };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface StoredRun {
  config: RunConfig;
  imageName: string;
  startedAt: string;
  runs: Array<{
    n: number;
    elapsedMs: number;
    error?: string;
    analysis?: ImageAnalysis;
    derived?: Derived;
  }>;
}

async function cmdRun(flags: Record<string, string | boolean>) {
  const cfg: RunConfig = {
    label: String(flags.label ?? "unlabelled"),
    provider: (flags.provider as "gemini" | "claude") ?? "gemini",
    model: flags.model ? String(flags.model) : undefined,
    width: Number(flags.width ?? 900),
    closeup: flags.closeup === true || flags.closeup === "true",
    productName: String(flags.product ?? "Fear What You Will Become"),
    brand: String(flags.brand ?? "Cadillacquer"),
    vendorHint: flags.hint ? String(flags.hint) : undefined,
    polishType: flags.type ? String(flags.type) : undefined,
    shadeKey: flags.shade ? String(flags.shade) : undefined,
    image: String(flags.dropbox ?? flags.file ?? ""),
    runs: Number(flags.runs ?? 3),
    collectionMode: flags.collection === true || flags.collection === "true",
  };

  const { buffer, name } = await loadImage({
    dropbox: flags.dropbox ? String(flags.dropbox) : undefined,
    file: flags.file ? String(flags.file) : undefined,
  });
  const { full, crop } = await prepare(buffer, cfg.width, cfg.closeup);
  console.log(
    `[prep] ${name}: full ${Math.round(full.length / 1024)} KB @ ${cfg.width}px` +
      (crop ? ` + crop ${Math.round(crop.length / 1024)} KB` : ""),
  );

  const analyzeFn = cfg.provider === "claude" ? analyzeImageClaude : analyzeImageGemini;
  // Pull operator ground truth (type, finishes, expected features) from the
  // collection data file when --shade names one.
  let expectedFeatures: Record<string, string | string[]> | undefined;
  let finishes: string[] | undefined;
  let type = cfg.polishType;
  if (cfg.shadeKey) {
    const doc = JSON.parse(readFileSync(join(process.cwd(), "data", "halloween-2026.json"), "utf-8"));
    const sh = doc.shades?.[cfg.shadeKey];
    if (sh) {
      type = type ?? sh.polishType;
      finishes = sh.finishes;
      expectedFeatures = sh.expectedFeatures;
      console.log(`[truth] ${cfg.shadeKey}: type=${type} finishes=[${(finishes ?? []).join(",")}]`);
    } else {
      console.log(`[truth] no entry for "${cfg.shadeKey}"`);
    }
  }
  const context = { productName: cfg.productName, brand: cfg.brand, vendorHint: cfg.vendorHint,
    polishType: type as any, polishFinishes: finishes as any, expectedFeatures,
    collectionMode: cfg.collectionMode } as any;

  const stored: StoredRun = { config: cfg, imageName: name, startedAt: new Date().toISOString(), runs: [] };

  for (let n = 1; n <= cfg.runs; n++) {
    const t0 = Date.now();
    try {
      const analysis = await analyzeFn(
        full.toString("base64"),
        "image/jpeg",
        context,
        cfg.model,
        crop ? { base64: crop.toString("base64"), mimeType: "image/jpeg" } : undefined,
      );
      const elapsedMs = Date.now() - t0;
      // Snap before deriving, so the harness measures what the pipeline stores.
      if (!process.env.NO_SNAP) {
        const idx = await buildPixelIndex(full);
        const rep = snapAnalysis(idx, analysis);
        (analysis as any)._snap = rep;
      }
      const derived = derive(analysis);
      stored.runs.push({ n, elapsedMs, analysis, derived });
      console.log(
        `  run ${n}/${cfg.runs}  ${(elapsedMs / 1000).toFixed(1)}s  ` +
          `type=${analysis.imageType} conf=${analysis.confidence} ` +
          `base=${derived.baseColorHex ?? "-"} sat=${derived.baseSaturationPct ?? "-"}% ` +
          `finish=${derived.finishType ?? "null"}`,
      );
    } catch (err) {
      stored.runs.push({ n, elapsedMs: Date.now() - t0, error: String(err) });
      console.log(`  run ${n}/${cfg.runs}  ERROR ${err}`);
    }
  }

  const dir = join(OUT_ROOT, cfg.label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runs.json"), JSON.stringify(stored, null, 2));
  console.log(`\nWrote ${join(dir, "runs.json")}`);
  printVariance(stored);
}

// ---------------------------------------------------------------------------
// variance / compare
// ---------------------------------------------------------------------------

function summarise(s: StoredRun) {
  const ok = s.runs.filter((r) => r.analysis);
  const uniq = (vals: unknown[]) => [...new Set(vals.map((v) => JSON.stringify(v)))];
  return {
    label: s.config.label,
    provider: s.config.provider,
    width: s.config.width,
    closeup: s.config.closeup,
    n: s.runs.length,
    ok: ok.length,
    failed: s.runs.length - ok.length,
    meanSeconds: ok.length ? Number((ok.reduce((a, r) => a + r.elapsedMs, 0) / ok.length / 1000).toFixed(1)) : null,
    imageType: uniq(ok.map((r) => r.analysis!.imageType)),
    confidence: ok.map((r) => r.analysis!.confidence),
    baseHex: ok.map((r) => r.derived!.baseColorHex ?? null),
    baseSat: ok.map((r) => r.derived!.baseSaturationPct ?? null),
    finishType: uniq(ok.map((r) => r.derived!.finishType ?? null)),
    flakeSize: uniq(ok.map((r) => r.derived!.flakeSize)),
    effects: ok.map((r) => r.analysis!.observedEffects),
    dominantColors: ok.map((r) => r.analysis!.dominantColors),
    booleans: uniq(ok.map((r) => r.derived!.booleans)),
    altText: ok.map((r) => r.analysis!.altText),
  };
}

/** Max pairwise LAB ΔE between the base colours reported across runs. */
function baseColorSpread(s: StoredRun): number | null {
  const hexes = s.runs.map((r) => r.derived?.baseColorHex).filter((h): h is string => !!h);
  if (hexes.length < 2) return null;
  let max = 0;
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      try {
        const a = hexToLab(hexes[i]);
        const b = hexToLab(hexes[j]);
        const d = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
        if (d > max) max = d;
      } catch { /* skip unparseable */ }
    }
  }
  return Math.round(max * 10) / 10;
}

function printVariance(s: StoredRun) {
  const sum = summarise(s);
  const spread = baseColorSpread(s);
  console.log(`\n=== ${sum.label} (${sum.provider}, ${sum.width}px, closeup=${sum.closeup}) ===`);
  console.log(`  runs ok/failed : ${sum.ok}/${sum.failed}   mean ${sum.meanSeconds}s`);
  console.log(`  imageType      : ${sum.imageType.join(" | ")}`);
  console.log(`  confidence     : ${sum.confidence.join(", ")}`);
  console.log(`  base hex       : ${sum.baseHex.join(", ")}`);
  console.log(`  base sat %     : ${sum.baseSat.join(", ")}`);
  console.log(`  base ΔE spread : ${spread ?? "n/a"}   ${spread !== null && spread > 5 ? "<-- run-to-run instability" : ""}`);
  console.log(`  finishType     : ${sum.finishType.join(" | ")}`);
  console.log(`  flakeSize      : ${sum.flakeSize.join(" | ")}`);
  console.log(`  booleans       : ${sum.booleans.join(" | ")}`);
  console.log(`  effects        :`);
  for (const e of sum.effects) console.log(`      ${JSON.stringify(e)}`);
  console.log(`  dominantColors :`);
  for (const d of sum.dominantColors) console.log(`      ${JSON.stringify(d)}`);
  console.log(`  altText        :`);
  for (const a of sum.altText) console.log(`      ${a}`);
}

function load(label: string): StoredRun {
  const p = join(OUT_ROOT, label, "runs.json");
  if (!existsSync(p)) throw new Error(`No saved run for label "${label}" (${p})`);
  return JSON.parse(readFileSync(p, "utf-8")) as StoredRun;
}

function cmdCompare(labels: string[]) {
  if (labels.length < 2) throw new Error("compare needs at least two labels");
  for (const l of labels) printVariance(load(l));

  console.log(`\n=== side by side ===`);
  const rows = labels.map((l) => ({ l, s: summarise(load(l)), spread: baseColorSpread(load(l)) }));
  const pad = (v: unknown, w: number) => String(v).slice(0, w).padEnd(w);
  console.log(pad("label", 26) + pad("ok", 6) + pad("secs", 7) + pad("conf", 22) + pad("ΔE", 7) + "finish");
  for (const r of rows) {
    console.log(
      pad(r.l, 26) +
        pad(`${r.s.ok}/${r.s.n}`, 6) +
        pad(r.s.meanSeconds ?? "-", 7) +
        pad(r.s.confidence.join(","), 22) +
        pad(r.spread ?? "-", 7) +
        r.s.finishType.join("|"),
    );
  }
}

function cmdList() {
  if (!existsSync(OUT_ROOT)) return console.log("No runs yet.");
  for (const d of readdirSync(OUT_ROOT)) {
    if (d.startsWith("_")) continue;
    try {
      const s = load(d);
      console.log(`${d.padEnd(28)} ${s.config.provider} ${s.config.width}px closeup=${s.config.closeup} runs=${s.runs.length}  ${s.startedAt}`);
    } catch { /* skip */ }
  }
}

// ---------------------------------------------------------------------------
// batch — analyze a whole folder once per image, then cluster on base colour.
// This is the §5.2 prototype: group BEFORE naming, using the numbers rather
// than the prose labels.
// ---------------------------------------------------------------------------

interface BatchItem {
  file: string;
  swatcher: string | null;
  shotAt: string | null;
  analysis?: ImageAnalysis;
  derived?: Derived;
  error?: string;
}

/** Pull swatcher handle and capture time out of the camera filename (§5.3). */
function parseFilename(name: string): { swatcher: string | null; shotAt: string | null; seq: string | null } {
  const m = /^Foto_(\d\d)\.(\d\d)\.(\d\d)_(\d\d)_(\d\d)_(\d\d)(?:_(\d+(?:_\d+)*))?_swatcher-(.+)\.\w+$/i.exec(name);
  if (!m) return { swatcher: null, shotAt: null, seq: null };
  const [, dd, mm, yy, hh, mi, ss, seq, swatcher] = m;
  return { swatcher, shotAt: `20${yy}-${mm}-${dd}T${hh}:${mi}:${ss}`, seq: seq ?? null };
}

async function cmdBatch(flags: Record<string, string | boolean>) {
  const dir = String(flags.dir ?? join(OUT_ROOT, "_cache"));
  const label = String(flags.label ?? "batch");
  const provider = (flags.provider as "gemini" | "claude") ?? "claude";
  const width = Number(flags.width ?? 1400);
  const closeup = flags.closeup === true || flags.closeup === "true";
  const brand = String(flags.brand ?? "Cadillacquer");
  const productName = String(flags.product ?? "unknown shade");
  const concurrency = Number(flags.concurrency ?? 6);

  const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  console.log(`[batch] ${files.length} images from ${dir} (${provider}, ${width}px, closeup=${closeup})`);

  const analyzeFn = provider === "claude" ? analyzeImageClaude : analyzeImageGemini;
  const items: BatchItem[] = new Array(files.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      while (next < files.length) {
        const i = next++;
        const name = files[i];
        const meta = parseFilename(name);
        try {
          const { full, crop } = await prepare(readFileSync(join(dir, name)), width, closeup);
          const analysis = await analyzeFn(
            full.toString("base64"),
            "image/jpeg",
            { productName, brand },
            undefined,
            crop ? { base64: crop.toString("base64"), mimeType: "image/jpeg" } : undefined,
          );
          items[i] = { file: name, swatcher: meta.swatcher, shotAt: meta.shotAt, analysis, derived: derive(analysis) };
          console.log(`  ${String(i + 1).padStart(2, "0")}/${files.length} ${meta.swatcher ?? name}  base=${items[i].derived!.baseColorHex} conf=${analysis.confidence}`);
        } catch (err) {
          items[i] = { file: name, swatcher: meta.swatcher, shotAt: meta.shotAt, error: String(err) };
          console.log(`  ${String(i + 1).padStart(2, "0")}/${files.length} ERROR ${err}`);
        }
      }
    }),
  );

  const dirOut = join(OUT_ROOT, label);
  mkdirSync(dirOut, { recursive: true });
  writeFileSync(join(dirOut, "batch.json"), JSON.stringify({ dir, provider, width, closeup, items }, null, 2));

  clusterReport(items, Number(flags.threshold ?? 12));
  console.log(`\nWrote ${join(dirOut, "batch.json")}`);
}

/**
 * Agglomerative single-link clustering on base-colour LAB ΔE.
 * Deliberately dumb: the point is to show that the NUMBERS separate shades the
 * prose labels could not, not to ship a final clustering algorithm.
 */
function clusterReport(items: BatchItem[], threshold: number) {
  const pts = items
    .map((it, i) => ({ i, it, lab: it.derived?.baseColorLab as [number, number, number] | null }))
    .filter((p): p is { i: number; it: BatchItem; lab: [number, number, number] } => !!p.lab);

  const parent = pts.map((_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const d = Math.sqrt(
        (pts[a].lab[0] - pts[b].lab[0]) ** 2 +
        (pts[a].lab[1] - pts[b].lab[1]) ** 2 +
        (pts[a].lab[2] - pts[b].lab[2]) ** 2,
      );
      if (d <= threshold) union(a, b);
    }
  }

  const groups = new Map<number, typeof pts>();
  for (let i = 0; i < pts.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(pts[i]);
  }

  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  console.log(`\n=== clusters (single-link, base-colour ΔE ≤ ${threshold}) — ${sorted.length} groups from ${pts.length} images ===`);
  sorted.forEach((g, gi) => {
    const swatchers = [...new Set(g.map((p) => p.it.swatcher ?? "?"))];
    console.log(`\n  Group ${gi + 1}  (${g.length} images, ${swatchers.length} swatchers: ${swatchers.join(", ")})`);
    for (const p of g) {
      const d = p.it.derived!;
      const flakes = d.flakeColorsHex.join(",") || "-";
      console.log(
        `    ${(p.it.swatcher ?? "?").padEnd(20)} ${d.baseColorHex}  sat ${String(d.baseSaturationPct ?? "-").padStart(3)}%  ` +
        `finish=${(d.finishType ?? "null").padEnd(11)} flakes=${flakes}  ${p.it.file}`,
      );
    }
  });

  const failed = items.filter((it) => it.error || !it.derived?.baseColorHex);
  if (failed.length) console.log(`\n  unclustered (${failed.length}): ${failed.map((f) => f.file).join(", ")}`);
}

// ---------------------------------------------------------------------------
// session-aware clustering (§5.2 + §5.3)
//
// Per-frame base colour is too noisy to cluster directly on a multichrome: the
// same polish swings past the ΔE threshold between two frames of one burst.
// So group by shooting session FIRST (same swatcher, small time gap — a
// swatcher shoots one shade per burst), average each session's colours to kill
// the per-frame angle noise, THEN cluster the session aggregates.
// ---------------------------------------------------------------------------

interface Session {
  swatcher: string;
  start: string;
  end: string;
  items: BatchItem[];
  baseLab: Lab;
  flakeLab: Lab[];
}

function meanOf(labs: Lab[]): Lab | null {
  if (!labs.length) return null;
  const s = labs.reduce<[number, number, number]>(([a, b, c], [d, e, f]) => [a + d, b + e, c + f], [0, 0, 0]);
  return [s[0] / labs.length, s[1] / labs.length, s[2] / labs.length];
}

function buildSessions(items: BatchItem[], gapMinutes: number): Session[] {
  const byS = new Map<string, BatchItem[]>();
  for (const it of items) {
    if (!it.derived?.baseColorHex) continue;
    const k = it.swatcher ?? "(unknown)";
    if (!byS.has(k)) byS.set(k, []);
    byS.get(k)!.push(it);
  }

  const sessions: Session[] = [];
  for (const [swatcher, list] of byS) {
    list.sort((a, b) => (a.shotAt ?? "").localeCompare(b.shotAt ?? ""));
    let bucket: BatchItem[] = [];
    const flush = () => {
      if (!bucket.length) return;
      const baseLabs = bucket.map((b) => b.derived!.baseColorLab).filter(Boolean) as unknown as Lab[];
      const flakeLabs: Lab[] = [];
      for (const b of bucket) {
        for (const h of b.derived!.flakeColorsHex) {
          try { flakeLabs.push(hexToLab(h)); } catch { /* skip */ }
        }
      }
      const baseHexes = bucket.map((b) => b.derived!.baseColorHex!).filter(Boolean);
      const base = meanOf(baseHexes.map((h) => hexToLab(h)));
      if (base) {
        sessions.push({
          swatcher,
          start: bucket[0].shotAt ?? "?",
          end: bucket[bucket.length - 1].shotAt ?? "?",
          items: [...bucket],
          baseLab: base,
          flakeLab: flakeLabs,
        });
      }
      bucket = [];
    };

    for (const it of list) {
      if (!bucket.length) { bucket.push(it); continue; }
      const prev = bucket[bucket.length - 1].shotAt;
      const cur = it.shotAt;
      const gap = prev && cur ? (Date.parse(cur) - Date.parse(prev)) / 60000 : Infinity;
      if (gap > gapMinutes) flush();
      bucket.push(it);
    }
    flush();
  }
  return sessions;
}

/**
 * Session-to-session distance. Base colour alone cannot separate these shades
 * (a magenta↔gold multichrome and a teal crelly both report a mid-dark base
 * depending on angle) — the FLAKE colours carry the discriminating signal, so
 * they get equal weight via a symmetric nearest-flake distance.
 */
function sessionDistance(a: Session, b: Session, flakeWeight: number): number {
  const baseD = deltaE76(a.baseLab, b.baseLab);
  if (!a.flakeLab.length || !b.flakeLab.length) return baseD;
  const nearest = (from: Lab[], to: Lab[]) =>
    from.reduce((sum, f) => sum + Math.min(...to.map((t) => deltaE76(f, t))), 0) / from.length;
  const flakeD = (nearest(a.flakeLab, b.flakeLab) + nearest(b.flakeLab, a.flakeLab)) / 2;
  return (baseD + flakeWeight * flakeD) / (1 + flakeWeight);
}

function cmdCluster(flags: Record<string, string | boolean>) {
  const label = String(flags.label ?? "fwywb-batch");
  const gap = Number(flags.gap ?? 20);
  const threshold = Number(flags.threshold ?? 14);
  const flakeWeight = Number(flags.flakeWeight ?? 1);

  const raw = JSON.parse(readFileSync(join(OUT_ROOT, label, "batch.json"), "utf-8")) as { items: BatchItem[] };
  const sessions = buildSessions(raw.items, gap);

  console.log(`=== sessions (same swatcher, gap ≤ ${gap} min) — ${sessions.length} from ${raw.items.length} images ===`);
  for (const s of sessions) {
    console.log(`  ${s.swatcher.padEnd(20)} ${s.items.length} img  ${s.start.slice(5, 16)} → ${s.end.slice(11, 16)}  base=${labToHex(s.baseLab)}`);
  }

  // Single-link agglomerative over sessions.
  const parent = sessions.map((_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const pairs: Array<{ a: number; b: number; d: number }> = [];
  for (let a = 0; a < sessions.length; a++) {
    for (let b = a + 1; b < sessions.length; b++) {
      pairs.push({ a, b, d: sessionDistance(sessions[a], sessions[b], flakeWeight) });
    }
  }
  pairs.sort((x, y) => x.d - y.d);

  console.log(`\n=== pairwise session distance (base + ${flakeWeight}× flake) ===`);
  for (const p of pairs) {
    const mark = p.d <= threshold ? "  <-- merged" : "";
    console.log(`  ${sessions[p.a].swatcher.padEnd(20)} ↔ ${sessions[p.b].swatcher.padEnd(20)} ${p.d.toFixed(1)}${mark}`);
  }

  for (const p of pairs) if (p.d <= threshold) parent[find(p.a)] = find(p.b);

  const groups = new Map<number, Session[]>();
  sessions.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(s);
  });

  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  console.log(`\n=== shade groups (threshold ${threshold}) — ${sorted.length} distinct shades ===`);
  sorted.forEach((g, gi) => {
    const imgs = g.reduce((n, s) => n + s.items.length, 0);
    console.log(`\n  Shade ${gi + 1}: ${imgs} images across ${g.length} swatchers`);
    for (const s of g) {
      console.log(`    ${s.swatcher.padEnd(20)} ${String(s.items.length).padStart(2)} img  base=${labToHex(s.baseLab)}`);
      for (const it of s.items) console.log(`        ${it.file}`);
    }
  });
}

/** Browse a Dropbox folder so you can pick a --dropbox path without leaving the terminal. */
async function cmdLs(path: string) {
  const { entries } = await listOwnFolder(path);
  for (const e of entries) {
    console.log(`${e[".tag"] === "folder" ? "d" : "-"}  ${e.path_display}`);
  }
}

// ---------------------------------------------------------------------------

const { cmd, rest, flags } = parseArgs(process.argv.slice(2));
try {
  if (cmd === "run") await cmdRun(flags);
  else if (cmd === "compare") cmdCompare(rest);
  else if (cmd === "list") cmdList();
  else if (cmd === "ls") await cmdLs(rest[0] ?? "");
  else if (cmd === "batch") await cmdBatch(flags);
  else if (cmd === "cluster") cmdCluster(flags);
  else console.log("Commands: run | batch | compare <labelA> <labelB> ... | list | ls <dropboxPath>");
} catch (err) {
  console.error(String(err));
  process.exit(1);
}
