/**
 * Grouping — segmenting a shoot into bursts, independent of where the frames
 * came from.
 *
 * PROVIDER-AGNOSTIC BY CONSTRUCTION
 * --------------------------------
 * Nothing here knows about Dropbox, folders, or filenames-as-paths. A frame is
 * an id, an optional position in the shooting order, and an optional capture
 * time. Dropbox, Drive, a local directory, or a list of URLs all reduce to
 * that, so the same grouping runs for any brand whose photographer uses any
 * storage. This logic previously lived inside a Dropbox-specific script and
 * could not run for anything else.
 *
 * WHY BURSTS AT ALL
 * -----------------
 * A swatcher removes one polish and applies the next, which takes minutes. So
 * frames cluster into runs showing one shade, and that clustering is a physical
 * property of how the shoot happened rather than anything inferred from pixels
 * — which makes it far more robust than colour, because it does not care how
 * the light fell.
 */

/** One photograph, from any source. */
export interface Frame {
  /** Stable identifier — a filename, a file id, a URL. Never parsed for meaning. */
  id: string;
  /**
   * Position in the shooting order, if known. Falls back to array order.
   * This is the durable signal: it survives the loss of timestamps.
   */
  order?: number;
  /** Capture time in epoch ms, or null when unknown. */
  time?: number | null;
}

export interface Burst {
  /** Indices into the frame array. */
  idx: number[];
  start: number | null;
  end: number | null;
}

/**
 * Recover a capture time from a filename, for sources that carry it there.
 *
 * Optional: callers that have real metadata should pass `time` on the Frame and
 * never call this. Exported because two filename regimes appear across real
 * swatcher shoots and both encode the same instant.
 */
export function timeFromFilename(name: string): number | null {
  const m = /(\d{2})\.(\d{2})\.(\d{2}),\s*(\d{2})[ .](\d{2})[ .](\d{2})/.exec(name);
  if (!m) return null;
  const [, dd, mm, yy, hh, mi, ss] = m;
  const t = Date.parse(`20${yy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * Recover shooting order from a filename's "(N)" suffix.
 *
 * Used by exports that flatten every capture time to the moment of transfer and
 * carry the ordering in the suffix instead. A frame with no suffix sorts first,
 * which matches how these exports name the initial frame.
 */
export function orderFromFilename(name: string): number | null {
  const m = /\((\d+)\)(?!.*\(\d+\))/.exec(name.replace(/\.[^.]+$/, ""));
  return m ? Number(m[1]) : null;
}

export interface SegmentOptions {
  /** Minutes of silence that imply a polish change. */
  gapMinutes?: number;
  /**
   * Per-frame label used to detect a change of subject. Usually the model's
   * per-frame guess. Segmentation still works with labels absent — it simply
   * relies on time alone.
   */
  labels?: Array<string | null>;
}

/**
 * Segment frames into bursts.
 *
 * TIME IS A GOOD SIGNAL WHEN PRESENT AND NEVER GOSPEL. Real swatchers do not
 * shoot in tidy groups; editing an image strips its original time; and a bulk
 * upload stamps every file with the moment of transfer. Measured on real
 * shoots, half the photographers export under a single timestamp, so a
 * time-only rule collapsed an entire session into one burst.
 *
 * The durable structure is the ORDERED SEQUENCE, which survives both regimes.
 * So a boundary is declared on either signal:
 *   - a real time gap, when times are actually distinct
 *   - a sustained change in the per-frame label
 *
 * "Sustained" matters: a lone dissenting frame between two agreeing ones is
 * usually noise, and requiring the new label to persist for two frames makes
 * this a smoother rather than a change-detector.
 *
 * CAUTION — that smoothing has a cost, and callers must handle it. Swatchers do
 * interleave, shooting a single frame of another shade mid-run. When that
 * happens the dissenting frame is not noise, it is the only correct frame in
 * the group, and absorbing it silently overwrites a correct answer. Measured on
 * a verified shoot, this accounted for two of three remaining errors. Callers
 * must not let burst consensus overrule a frame whose own evidence contradicts
 * the burst's conclusion; see src/vision/veto.ts.
 */
export function segmentBursts(frames: Frame[], opts: SegmentOptions = {}): Burst[] {
  const gapMinutes = opts.gapMinutes ?? 5;
  const labels = opts.labels ?? [];
  const label = (i: number) => labels[i] ?? null;

  const out: Burst[] = [];
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i].time ?? null;
    const cur = out[out.length - 1];

    let boundary = !cur;
    if (cur) {
      const gap = t && cur.end ? (t - cur.end) / 60000 : 0;
      if (gap > gapMinutes) boundary = true;
      else {
        const prev = label(i - 1);
        const here = label(i);
        if (here && prev && here !== prev) {
          const next = label(i + 1);
          if (next === null || next === here) boundary = true;
        }
      }
    }

    if (boundary) out.push({ idx: [i], start: t, end: t });
    else {
      cur!.idx.push(i);
      cur!.end = t ?? cur!.end;
    }
  }
  return out;
}

/**
 * Put frames into shooting order.
 *
 * Prefers an explicit `order`, then capture time, then a numeric-aware compare
 * on the id — which handles "(2)" sorting before "(10)", where a plain string
 * compare would not.
 */
export function inShootingOrder<T extends Frame>(frames: T[]): T[] {
  return [...frames].sort((a, b) => {
    if (a.order != null && b.order != null && a.order !== b.order) return a.order - b.order;
    if (a.time != null && b.time != null && a.time !== b.time) return a.time - b.time;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}
