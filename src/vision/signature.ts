/**
 * Signatures — turning a vendor description into structured, comparable facts.
 *
 * This is the piece that makes shade assignment brand-agnostic. Nothing here
 * knows about Cadillacquer, Halloween, or any particular shade: it knows nail
 * polish vocabulary, which every brand writes in. Give it whatever descriptions
 * the operator has for whatever collection, and it yields facts that can be
 * diffed pairwise to discover what actually separates two shades.
 *
 * The previous approach hand-wrote a veto per confusable pair, naming shades in
 * code ("forbids: ['What Lurks Within']"). That worked for exactly one
 * collection and transferred to none.
 *
 * HARD vs SOFT — the load-bearing distinction
 * -------------------------------------------
 * Facts are split by whether they survive a change of viewing angle, which is
 * physics rather than branding:
 *
 *   HARD  discrete inclusions (glitter, flakes) and magnet-aligned structure
 *         (bands). A red glitter particle is red from every angle, and a band
 *         is either present or it is not. Safe to use as a constraint.
 *
 *   SOFT  base colour and shimmer travel. These come from goniochromatic
 *         interference pigments whose measured colour depends on an
 *         uncontrolled viewing angle (docs/effect-pigment-optics.md). An
 *         operator-CONFIRMED frame of a magenta-to-orange shade read as
 *         "deep mulberry base ... no orange travel" — using either as a
 *         constraint would have destroyed a correct assignment.
 *
 * Only HARD facts may become vetoes. SOFT facts stay as weights.
 */

/** An attribute of a polish that a description can pin down. */
export type Attribute =
  | "base"        // the colour under everything          SOFT
  | "shimmer"     // continuous interference sheen         SOFT
  | "travel"      // whether the shimmer shifts colour     SOFT
  | "glitter"     // discrete reflective particles         HARD
  | "flakes"      // discrete irregular particles          HARD
  | "band";       // magnet-aligned concentration          HARD

/** Attributes that survive a change of viewing angle, and may be constraints. */
export const HARD_ATTRIBUTES: ReadonlySet<Attribute> = new Set<Attribute>(["glitter", "flakes", "band"]);

export interface Fact {
  attribute: Attribute;
  /** Normalised colour term, or "clear" / "none" / "present". */
  value: string;
  /** The phrase this was read from, for auditability. */
  source: string;
}

export interface Signature {
  shade: string;
  facts: Fact[];
}

/**
 * Colour vocabulary, normalised to families.
 *
 * Deliberately coarse. "mulberry", "plum" and "eggplant" all land on purple
 * because the goal is to tell a PINK glitter from a GREEN one, not to grade
 * mulberry against plum. Over-fine terms would manufacture differences between
 * shades that are genuinely alike, and the whole point is to find the
 * differences that survive photography.
 */
const COLOR_FAMILIES: Record<string, string[]> = {
  red: ["red", "crimson", "scarlet", "ruby", "cherry"],
  orange: ["orange", "copper", "amber", "rust", "tangerine", "bronze"],
  yellow: ["yellow", "gold", "golden", "champagne"],
  green: ["green", "lime", "emerald", "olive", "mint"],
  teal: ["teal", "turquoise", "aqua", "cyan"],
  blue: ["blue", "indigo", "sapphire", "navy", "cobalt"],
  purple: ["purple", "violet", "lavender", "lilac", "mulberry", "plum", "eggplant", "aubergine"],
  pink: ["pink", "magenta", "fuchsia", "rose"],
  neutral: ["black", "grey", "gray", "charcoal", "white", "silver", "taupe"],
  clear: ["clear", "transparent", "colourless", "colorless"],
};

const COLOR_LOOKUP: Record<string, string> = {};
for (const [family, terms] of Object.entries(COLOR_FAMILIES)) {
  for (const t of terms) COLOR_LOOKUP[t] = family;
}

/** Every colour term, longest first so "lime green" beats "green". */
const COLOR_ALTERNATION = Object.keys(COLOR_LOOKUP)
  .sort((a, b) => b.length - a.length)
  .join("|");

export const normalizeColor = (term: string): string | null =>
  COLOR_LOOKUP[term.toLowerCase().trim()] ?? null;

/**
 * The chromatic families in hue-wheel order.
 *
 * Used to decide whether two colour readings genuinely disagree. Adjacent
 * families are NOT a disagreement: on a small iridescent particle under
 * uncontrolled light, teal and blue are not reliably distinguishable, and an
 * operator-confirmed frame described a shade's blue flakes as "teal flakes".
 * Treating that as a contradiction produced false vetoes on correct frames.
 *
 * This is the same reasoning that puts base colour in the SOFT bucket, applied
 * at finer grain: the question a veto may ask is "is this colour FAR from what
 * the description states", not "is it exactly the stated word".
 */
const HUE_WHEEL = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;

/**
 * How far apart two colour families sit, 0-4, or null when either is
 * achromatic. Neutral and clear have no hue, so distance is undefined and
 * callers must not treat them as far from anything.
 */
export function hueDistance(a: string, b: string): number | null {
  const i = HUE_WHEEL.indexOf(a as (typeof HUE_WHEEL)[number]);
  const j = HUE_WHEEL.indexOf(b as (typeof HUE_WHEEL)[number]);
  if (i < 0 || j < 0) return null;
  const d = Math.abs(i - j);
  return Math.min(d, HUE_WHEEL.length - d);
}

/**
 * Minimum hue separation before two readings count as contradicting.
 *
 * 2 keeps green-vs-pink (4) and red-vs-blue (4) firing, while sparing
 * teal-vs-blue and green-vs-teal (1), which photograph into each other.
 */
export const MIN_CONTRADICTION_DISTANCE = 2;

/** Do these two colour readings genuinely disagree? */
export function contradicts(observed: string, stated: string): boolean {
  if (observed === stated) return false;

  // A shade the description says has NONE of a feature cannot be showing a
  // coloured one. This is asymmetric on purpose:
  //
  //   stated "none" + observed a colour  -> CONTRADICTION. A crelly has no
  //   magnetic band, so a frame reporting an orange band is not that crelly.
  //
  //   stated a colour + observed "none"  -> NOT a contradiction, handled
  //   earlier by refusing absence as evidence. A magnetic shade genuinely
  //   shows no band in a bottle shot, because bottle polish is unmagnetised.
  //
  // Without this, three frames explicitly describing "orange concentrated
  // band, magnetic" were filed under a shade whose description has no band,
  // while the shade they actually showed was reported as absent from the shoot.
  if (stated === "none") return observed !== "none";

  const d = hueDistance(observed, stated);
  // An achromatic reading against a chromatic one is not a safe contradiction:
  // "charcoal glitter" and "blue glitter" can be the same particle in shadow.
  if (d === null) return false;
  return d >= MIN_CONTRADICTION_DISTANCE;
}

/**
 * Nouns that mark each attribute in vendor prose.
 *
 * "flakies" and "flakes" are the same particle — the trade uses both, and the
 * distinction some brands draw is size, not kind, so they normalise together.
 */
const ATTRIBUTE_NOUNS: Record<Attribute, string[]> = {
  base: ["base", "creme", "crelly", "jelly"],
  shimmer: ["shimmer", "sheen", "aurora", "chrome", "metallic"],
  travel: ["shift", "shifts", "travel", "travels", "travelling", "traveling", "duochrome", "multichrome"],
  glitter: ["glitter", "glitters", "sparkle", "microglitter", "hex", "hexes", "hexagons", "shard", "shards", "sequin", "sequins"],
  flakes: ["flake", "flakes", "flakie", "flakies"],
  band: ["band", "magnetic", "cat eye", "cat-eye"],
};

/**
 * Read facts out of one description.
 *
 * Matches "<colour...> <noun>" — the order vendor prose overwhelmingly uses
 * ("deep mulberry base", "matte neon pink glitter", "lime green magnetic
 * band"). Modifiers between colour and noun are tolerated so "neon pink hex
 * glitter" still binds pink to glitter.
 */
export function parseDescription(shade: string, description: string, polishType?: string): Signature {
  const facts: Fact[] = [];
  const text = description.toLowerCase();


  for (const [attribute, nouns] of Object.entries(ATTRIBUTE_NOUNS) as [Attribute, string[]][]) {
    const nounAlt = nouns.map((n) => n.replace(/[-\s]/g, "[-\\s]")).join("|");

    // "<colour phrase> [up to two modifiers] <noun>".
    //
    // The colour phrase may be a RANGE or a COMPOUND — "red-orange to yellow
    // micro flakes", "orange-gold band" — and every colour in it is a colour
    // that particle genuinely shows. Recording only one produced false
    // contradictions: reducing "red-orange to yellow" to "yellow" made an
    // observation of orange flakes look like a conflict, which vetoed four
    // operator-CONFIRMED frames.
    const phrase = `(?:${COLOR_ALTERNATION})(?:(?:[-\\/]|[-\\s]+(?:to|through|into|and)[-\\s]+|\\s*,\\s*|\\s+)(?:${COLOR_ALTERNATION}))*`;
    const withColor = new RegExp(`\\b(${phrase})\\b((?:\\s+\\w+){0,2}?)\\s+(?:${nounAlt})\\b`, "gi");
    for (const m of text.matchAll(withColor)) {
      for (const term of m[1].split(/[-\s]+(?:to|through|into|and)[-\s]+|[-\/,]|\s+/)) {
        const value = normalizeColor(term);
        if (value && !facts.some((f) => f.attribute === attribute && f.value === value)) {
          facts.push({ attribute, value, source: m[0].trim() });
        }
      }
    }

    // Attribute present but uncoloured — "packed with shimmer", "magnetic".
    if (!facts.some((f) => f.attribute === attribute)) {
      const bare = new RegExp(`\\b(?:${nounAlt})\\b`, "i");
      const m = bare.exec(text);
      if (m) facts.push({ attribute, value: "present", source: m[0] });
    }
  }

  // Travel is a relation, not a colour: "magenta to orange" means the shimmer
  // shifts, which is what distinguishes it from a single-colour shimmer. A
  // description with no such phrase asserts a single colour by omission.
  const travelPhrase = new RegExp(`\\b(${COLOR_ALTERNATION})\\b[\\s\\w]{0,12}?\\b(?:to|through|into)\\b[\\s\\w]{0,12}?\\b(${COLOR_ALTERNATION})\\b`, "i");
  const tm = travelPhrase.exec(text);
  const travelFacts = facts.filter((f) => f.attribute === "travel");
  if (tm) {
    for (const f of travelFacts) f.value = "yes";
    if (!travelFacts.length) facts.push({ attribute: "travel", value: "yes", source: tm[0].trim() });
  } else if (!travelFacts.length) {
    facts.push({ attribute: "travel", value: "no", source: "(no shift phrase in description)" });
  }

  // Polish TYPE is operator ground truth rather than an observation, so unlike
  // prose it can assert an ABSENCE. This matters: a crelly's description has no
  // reason to mention a magnetic band, and silence cannot discriminate — which
  // is exactly why parsing prose alone failed to separate the magnetic shade
  // from the non-magnetic one it is most often confused with.
  //
  // Applied only where prose is silent. A magnetic shade whose description
  // already gives the band COLOUR must keep that colour: adding a bare
  // "present" alongside it would make the two magnetic shades look like they
  // agree on band, destroying the colour discriminator between them.
  if (polishType) {
    const isMagnetic = polishType.toLowerCase() === "magnetic";
    const hasBandFact = facts.some((f) => f.attribute === "band");
    if (!isMagnetic) {
      const kept = facts.filter((f) => f.attribute !== "band");
      kept.push({ attribute: "band", value: "none", source: `polishType=${polishType}` });
      return { shade, facts: kept };
    }
    if (!hasBandFact) facts.push({ attribute: "band", value: "present", source: `polishType=${polishType}` });
  }

  return { shade, facts };
}

/** Shade input: the description, plus operator-supplied type when known. */
export interface ShadeInput {
  vendorDescription: string;
  polishType?: string;
}

export const parseAll = (shades: Record<string, ShadeInput | string>): Signature[] =>
  Object.entries(shades).map(([shade, v]) =>
    typeof v === "string"
      ? parseDescription(shade, v)
      : parseDescription(shade, v.vendorDescription, v.polishType),
  );

/** A HARD attribute on which two shades demonstrably disagree. */
export interface Discriminator {
  attribute: Attribute;
  /** shade -> the value that shade holds. */
  values: Record<string, string>;
}

/**
 * Find the hard attributes that separate two shades.
 *
 * Both must state a value, and the values must differ. Silence is not evidence:
 * a description that never mentions glitter is not asserting the absence of
 * glitter, it is simply not saying — so an attribute missing from either side
 * yields no discriminator.
 */
export function discriminate(a: Signature, b: Signature): Discriminator[] {
  const out: Discriminator[] = [];
  const valuesOf = (s: Signature, attr: Attribute) =>
    new Set(s.facts.filter((f) => f.attribute === attr).map((f) => f.value));

  for (const attribute of HARD_ATTRIBUTES) {
    const av = valuesOf(a, attribute);
    const bv = valuesOf(b, attribute);
    if (!av.size || !bv.size) continue;
    // "present" is a placeholder for an unstated colour, so it cannot conflict.
    if (av.has("present") || bv.has("present")) continue;
    const overlap = [...av].some((v) => bv.has(v));
    if (overlap) continue;
    out.push({
      attribute,
      values: { [a.shade]: [...av].join("/"), [b.shade]: [...bv].join("/") },
    });
  }
  return out;
}
