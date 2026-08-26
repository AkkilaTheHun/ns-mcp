/**
 * Description vetoes — forbidding pairings the operator's own descriptions
 * rule out.
 *
 * The scoring layer treats every signal as a weight, so a shade can win a burst
 * despite the model's own text flatly contradicting it. Observed on a real
 * shoot: a frame whose reason read "no magnetic band" was assigned the orange
 * MAGNETIC shade; a frame reading "red reflective glitter" was assigned the
 * shade whose glitter is blue. Both are decidable from the description without
 * looking at the image again.
 *
 * So some facts are not weights. They are constraints. A veto removes a shade
 * from a burst's candidate set, and no accumulated soft score puts it back.
 *
 * BRAND-AGNOSTIC BY CONSTRUCTION
 * ------------------------------
 * Nothing here names a shade, a brand or a collection. The rules are derived at
 * run time by parsing the candidate descriptions (src/vision/signature.ts) and
 * diffing them pairwise. The first version of this file hand-wrote a regex per
 * confusable pair with shade names as string literals; it worked for exactly
 * one collection and transferred to none. Feed these functions any brand's
 * descriptions and they produce that brand's constraints.
 *
 * WHAT MAY BE A VETO
 * ------------------
 * Only HARD attributes — discrete inclusions (glitter, flakes) and
 * magnet-aligned structure (bands) — plus the special case of whether a base
 * exists at all. Those are morphological: a red glitter particle is red from
 * every angle, and a band is present or absent.
 *
 * WHAT MAY NOT
 * ------------
 * Base COLOUR and shimmer travel. These come from goniochromatic interference
 * pigments whose measured colour depends on an uncontrolled viewing angle
 * (docs/effect-pigment-optics.md). The proof is an operator-CONFIRMED frame of
 * a magenta-to-orange shade whose text reads "Single-colour magenta-pink
 * shimmer; deep mulberry base visible at cuticle; no orange travel" — mulberry
 * base and no travel both point at a different shade. A base-colour or travel
 * veto would have destroyed a correct assignment.
 *
 * Regression-tested by scripts/veto-regression.ts against operator-confirmed
 * shoots: a rule firing on a confirmed frame is a bug in the rule.
 */
import {
  HARD_ATTRIBUTES,
  contradicts,
  normalizeColor,
  type Attribute,
  type Signature,
} from "./signature.js";

export interface VetoHit {
  shade: string;
  /** The attribute that decided it. */
  attribute: Attribute | "base-presence";
  /** What the frame was observed to show. */
  observed: string;
  /** What the description says this shade holds. */
  expected: string;
  /** The phrase in the frame's text this was read from. */
  evidence: string;
  because: string;
}

/** Nouns marking each hard attribute in observation prose. */
const HARD_NOUNS: Record<string, string[]> = {
  // "hexes" cost a real frame: the model wrote "neon green hexes" and nothing
  // recognised it as glitter, so the contradiction never fired and burst
  // consensus overwrote a correct read at 0.93 confidence.
  glitter: ["glitter", "glitters", "sparkle", "microglitter", "hex", "hexes", "hexagons", "shard", "shards", "sequin", "sequins"],
  flakes: ["flake", "flakes", "flakie", "flakies"],
  band: ["band"],
};

const COLOR_TERM =
  "red|crimson|scarlet|ruby|cherry|orange|copper|amber|rust|tangerine|bronze|yellow|gold|golden|champagne|" +
  "green|lime|emerald|olive|mint|teal|turquoise|aqua|cyan|blue|indigo|sapphire|navy|cobalt|" +
  "purple|violet|lavender|lilac|mulberry|plum|eggplant|aubergine|pink|magenta|fuchsia|rose|" +
  "black|grey|gray|charcoal|white|silver|taupe|clear|transparent";

/** Words that may sit between the colour and its noun: "neon pink hex glitter". */
const MODIFIERS = "(?:\\s+(?:neon|matte|bright|dense|large|small|micro|hex|hexagonal|iridescent|reflective|holographic|magnetic|concentrated|dominant|light|dark|deep|pale|warm|cool)){0,3}";

/**
 * Negation, checked as a window before the match rather than baked into every
 * pattern. "no blue micro flakes" is evidence FOR the shade whose flakes are
 * not blue, never against it.
 */
const NEGATED = /\b(?:no|without|lacks|absent|not|none)\s+(?:\w+\s+){0,3}$/i;

/** An attribute value read off a frame's description. */
interface Observation {
  attribute: Attribute | "base-presence";
  value: string;
  evidence: string;
}

/**
 * Read hard facts out of a frame's free-text reason.
 *
 * Returns EVERY colour found per attribute, not just the first. A text naming
 * two colours for one attribute is a hedge, and a hedge must abstain rather
 * than pick a side — a veto is a hard constraint, so acting on "pink and green
 * glitter" would be a coin flip with permanent consequences.
 */
export function observe(reason: string): Observation[] {
  const out: Observation[] = [];
  const text = reason.toLowerCase();

  for (const [attribute, nouns] of Object.entries(HARD_NOUNS)) {
    const nounAlt = nouns.join("|");

    // Explicit absence: "no magnetic band", "no band at all".
    //
    // A colour between the negator and the noun makes this a colour-SPECIFIC
    // denial, not an absence: "no blue micro flakes" says the flakes are not
    // blue, and reading it as "there are no flakes" vetoed a confirmed frame.
    const absent = new RegExp(
      `\\b(?:no|without|lacks|absent)\\s+((?:\\w+\\s+){0,2}?)(?:${nounAlt})\\b`,
      "i",
    );
    const am = absent.exec(text);
    if (am && !new RegExp(`\\b(?:${COLOR_TERM})\\b`, "i").test(am[1])) {
      out.push({ attribute: attribute as Attribute, value: "none", evidence: am[0].trim() });
    }

    // Colour phrases may be compound or a range — "orange-gold band",
    // "pink-red to orange micro flakes". Every colour named is emitted, so a
    // multi-colour phrase becomes a hedge and abstains rather than picking one.
    const phrase = `(?:${COLOR_TERM})(?:(?:[-\\/]|[-\\s]*[+&][-\\s]*|[-\\s]+(?:to|through|into|and)[-\\s]+|\\s*,\\s*|\\s+)(?:${COLOR_TERM}))*`;
    const withColor = new RegExp(`\\b(${phrase})\\b${MODIFIERS}\\s+(?:${nounAlt})\\b`, "gi");
    for (const m of text.matchAll(withColor)) {
      if (NEGATED.test(text.slice(0, m.index))) continue;
      for (const term of m[1].split(/[-\s]+(?:to|through|into|and)[-\s]+|[-\s]*[+&][-\s]*|[-\/,]|\s+/)) {
        const value = normalizeColor(term);
        if (value) out.push({ attribute: attribute as Attribute, value, evidence: m[0].trim() });
      }
    }
  }

  // Base PRESENCE is hard even though base COLOUR is not: a topper has no
  // pigmented base at all, which is structural rather than a colour reading.
  //
  // Requires the noun. Bare "clear" is an adverb in this corpus ("Clear orange
  // magnetic band visible", "Orange band clear") and matching it would veto
  // most of a collection off a word meaning "distinct".
  const clear = /\b(?:clear|transparent)(?:\/sheer)?\s+(?:base|topper)\b/i.exec(text);
  if (clear && !NEGATED.test(text.slice(0, clear.index))) {
    out.push({ attribute: "base-presence", value: "clear", evidence: clear[0].trim() });
  }
  return out;
}

/**
 * Which candidate shades a frame's own text rules out.
 *
 * @param reason      the model's free-text description of what it saw
 * @param signatures  parsed candidate descriptions for this collection
 */
export function vetoesFor(reason: string, signatures: Signature[]): VetoHit[] {
  const observations = observe(reason);
  if (!observations.length) return [];

  // Group by attribute so a two-sided hedge can abstain wholesale.
  const byAttribute = new Map<string, Observation[]>();
  for (const o of observations) {
    if (!byAttribute.has(o.attribute)) byAttribute.set(o.attribute, []);
    byAttribute.get(o.attribute)!.push(o);
  }

  const hits: VetoHit[] = [];

  for (const [attribute, obs] of byAttribute) {
    const values = new Set(obs.map((o) => o.value));
    // Two different values for one attribute: the text supports both sides and
    // therefore decides neither.
    if (values.size > 1) continue;
    const observed = obs[0].value;
    const evidence = obs[0].evidence;

    // ONLY PRESENCE MAY VETO. ABSENCE IS NOT EVIDENCE.
    //
    // Seeing green glitter proves green glitter is in the polish. NOT seeing a
    // magnetic band proves only that it was not visible in this frame — and a
    // magnetic shade genuinely shows no band in a bottle shot, because bottle
    // polish is unmagnetised, nor at plenty of nail angles.
    //
    // Caught by regression: an operator-CONFIRMED frame of a magnetic shade
    // read "no magnetic band", and treating that as absence vetoed the correct
    // answer. This costs some true catches — frames correctly ruled out of a
    // magnetic shade by saying no band — but a veto is a hard constraint and a
    // false one destroys a right answer, while a missed one only leaves the
    // decision to the model.
    if (observed === "none") continue;

    for (const sig of signatures) {
      if (attribute === "base-presence") {
        const base = sig.facts.filter((f) => f.attribute === "base").map((f) => f.value);
        // Only a shade whose description states a COLOURED base is ruled out.
        if (base.length && !base.includes("clear")) {
          hits.push({
            shade: sig.shade,
            attribute: "base-presence",
            observed: "clear/none",
            expected: base.join("/"),
            evidence,
            because: `${sig.shade} has a ${base.join("/")} base; a clear base means a topper`,
          });
        }
        continue;
      }

      if (!HARD_ATTRIBUTES.has(attribute as Attribute)) continue;

      // PARTICLE NOUNS ARE COMPARED AGAINST THE WHOLE PARTICLE PALETTE.
      //
      // Swatchers do not use "glitter" and "flakes" precisely — a confirmed
      // frame described a shade's blue FLAKES as "blue glitter". Requiring the
      // observed colour to be absent from BOTH particle sets tolerates that,
      // at a real cost: two shades whose glitter and flake colours are merely
      // swapped now have identical palettes and can no longer be separated
      // here. That is the same limit accent.ts hit from the hue side, and for
      // the same reason — telling a flake from a glitter particle is a
      // question of morphology, not colour. It stays with the model.
      const compared: Attribute[] =
        attribute === "glitter" || attribute === "flakes" ? ["glitter", "flakes"] : [attribute as Attribute];

      const stated = sig.facts.filter((f) => compared.includes(f.attribute)).map((f) => f.value);
      if (!stated.length) continue;
      // "present" is a placeholder for an unstated colour and conflicts with
      // nothing; silence is not evidence.
      if (stated.includes("present")) continue;
      // A veto needs a GENUINE disagreement, not a different word. Adjacent
      // hues photograph into each other on small particles.
      if (!stated.every((v) => contradicts(observed, v))) continue;

      hits.push({
        shade: sig.shade,
        attribute: attribute as Attribute,
        observed,
        expected: stated.join("/"),
        evidence,
        because: `${sig.shade}'s ${attribute} is ${stated.join("/")}, not ${observed}`,
      });
    }
  }
  return hits;
}
