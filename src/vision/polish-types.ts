/**
 * Polish type and finish — the two axes that drive measurement.
 *
 * Both lists are the CURATED SHOPIFY VOCABULARY, read from the live store on
 * 2026-08-22, not invented here:
 *   types    metaobject `nailstuff_polish_type`     (custom.nailstuff_polish_type)
 *   finishes metaobject `shopify--cosmetic-finish`  (shopify.cosmetic-finish)
 *
 * They are unions rather than a runtime fetch because the guidance below is
 * written per value and must be exhaustive at compile time. `checkVocabularyDrift`
 * compares them against the live store so divergence surfaces loudly instead of
 * silently narrowing what we can describe.
 *
 * TYPE IS NOT INFERRED FROM THE IMAGE. It comes from the Shopify metafield or
 * from the operator's product description. Vision inference exists only for
 * shades with no product yet, and its output must stay marked as inferred.
 * Measured on Halloween 2026, classifying type from images got 5 of 10 wrong,
 * every one in the same direction — it reports the loudest optical effect:
 *   both thermals            -> "glitter"
 *   a magnetic               -> "multichrome"
 *   two clear-base toppers   -> "linear_holo" / "crelly"
 *
 * Note the type/finish split does not fall where intuition suggests. `magnetic`
 * and `thermal` are TYPES here (they describe the formula and its behaviour),
 * while `multichrome` and `duochrome` are FINISHES (they describe the optics).
 */

export type PolishType =
  | "creme" | "crelly" | "jelly" | "sheer" | "topper" | "top-coat"
  | "magnetic" | "thermal" | "holo" | "uv" | "glow-in-the-dark" | "crackle";

export type PolishFinish =
  | "glitter" | "shimmer" | "metallic" | "holographic" | "glossy" | "opaque"
  | "matte" | "reflective" | "duochrome" | "multichrome" | "flakies" | "flakes"
  | "chrome" | "foil";

export const POLISH_TYPES: PolishType[] = [
  "creme", "crelly", "jelly", "sheer", "topper", "top-coat",
  "magnetic", "thermal", "holo", "uv", "glow-in-the-dark", "crackle",
];

export const POLISH_FINISHES: PolishFinish[] = [
  "glitter", "shimmer", "metallic", "holographic", "glossy", "opaque",
  "matte", "reflective", "duochrome", "multichrome", "flakies", "flakes",
  "chrome", "foil",
];

/**
 * §4.0a: flake size maps to a finish, and the pipeline already measures it.
 * Flakes are larger pieces; Flakies are tiny/micro. One of the few finish values
 * derivable from a measurement rather than a naming judgement — but only when
 * `closeup` is on, since the full frame alone returns flakeSize null.
 */
export function flakeSizeToFinish(size: "none" | "fine" | "medium" | "large" | null): PolishFinish | null {
  if (size === "fine") return "flakies";
  if (size === "medium" || size === "large") return "flakes";
  return null;
}

// ---------------------------------------------------------------------------
// Measurement guidance
// ---------------------------------------------------------------------------

/** TYPE guidance — governs WHERE the base colour is read. */
const TYPE_GUIDANCE: Partial<Record<PolishType, string>> = {
  magnetic: `TYPE: MAGNETIC. Measure it as one.

WHAT A MAGNETIC LOOKS LIKE, so you can find the parts:
The polish carries metallic particles suspended in a carrier base, usually a SHEER or translucent one. Holding a magnet near the wet polish drags those particles into a CONCENTRATED BAND — a stripe, arc, swirl or "cat eye" — leaving the rest of the nail with the particles thinned out.

That gives you two distinct regions on every magnetised nail, and you must not confuse them:

  BAND    — where particles piled up. BRIGHTER, more metallic, more reflective,
            often a sharply different hue. Usually a stripe or arc across the
            nail, frequently diagonal, and it sits in the SAME position on every
            nail in a set because the swatcher used the magnet the same way.
  FIELD   — either side of the band. DARKER and less metallic, because fewer
            particles are left there and you are seeing mostly the carrier base.

Use brightness and metallic sheen to tell them apart, not hue. The band is the
brighter, shinier region; the field is the duller region flanking it.

- baseColor: sample the FIELD, mid-way between the band and the cuticle or edge — the duller region, away from the concentrated stripe. Measured: doing this cut the base-colour disagreement between two frames of one bottle from 81.0 to 6.7 ΔE. This field reading IS baseColor for a magnetic; ignore any other instruction about where to read it.
- Do NOT report whichever colour fills the most pixels as the base. On a magnetic that is an artifact of where the magnet was held and it changes completely between two photographs of the same bottle.
- magneticLineColor: sample the brightest, most saturated part of the BAND itself. Be specific — "gold" is not enough when the real answer is amber vs lime vs copper.
- The band's own colour also shifts with angle, so report what THIS frame shows and do not reconcile it against anything else.
- THE BOTTLE USUALLY SHOWS NO BAND. Polish in the bottle is unmagnetised, so a bottle shot shows carrier plus scattered particles and no stripe. Do not hunt for a band there, and do not mistake a highlight running down the glass for one.
- If no band is visible in this frame, set magneticLineColor to null and lower "identification". Never invent a band.
- baseColor MAY BE NULL, and often should be. On a densely pigmented magnetic the particles cover the carrier almost completely and there is no true field to sample — and on an extreme macro of a single nail the frame may contain nothing BUT band. In either case set baseColor to null and lower "identification". Do not nominate the least-bright region just to fill the field: an invented base is worse than no base, because it enters the catalog as a measurement. A null is recoverable; a wrong anchor silently corrupts every later comparison.
- A magnetic often ALSO contains an aurora/multichrome shimmer that travels through several colours. That travelling shimmer is NOT the band and NOT the base — report it in shimmerFlashColors. Three separate things: carrier base (field), band (concentrated particles), shimmer (travelling flash).`,

  thermal: `TYPE: THERMAL. Measure it as one.

Two states, and the identity is the PAIR. A frame showing only the cold state is not comparable to a frame showing only the warm state.

- thermalCold / thermalWarm: fill in whichever state(s) are visible. Many frames show a TRANSITION with both present across one nail or between nails — capture both when both are visible.
- If only one state is visible, fill that one, set the other to null, and lower "identification". A single-state frame genuinely cannot identify a thermal.
- Glitter and flake colour are often the only things separating two thermals whose states look alike. Report glitterColors and flakeColors precisely and by size.`,

  creme: `TYPE: CREME — fully opaque, no particles, no shift. The base colour is the entire identity.
- baseColor: read from a flat, evenly lit patch. Avoid specular highlights, which read far lighter than the polish.
- Particle and shift fields should be empty. If you are seeing shift or sparkle, the type may be wrong — say so by lowering "identification".`,

  crelly: `TYPE: CRELLY — semi-opaque, between a creme and a jelly, usually with suspended particles.
- baseColor: read over the nail bed, NOT over the free edge, where translucency changes it.
- The suspension mix is what separates crellies sharing a base — report shimmerFlashColors, flakeColors and glitterColors precisely.`,

  jelly: `TYPE: JELLY — translucent with squishy depth.
- baseColor: read over the thickest, most opaque area. Thin areas read lighter and take colour from underneath.
- The free edge and any visible nail line differing from the body is the finish, not a second colour.`,

  sheer: `TYPE: SHEER — low opacity, the nail shows through.
- baseColor: read over the thickest area, and note that the nail beneath tints it.
- Do not report the natural nail or the skin tone as the polish colour.
- A sheer base is often the CARRIER for something else (a magnetic band, a shimmer). Measure the carrier colour and the suspended effect separately.`,

  topper: `TYPE: TOPPER — a sheer or clear suspension meant to layer over another colour.
- The PARTICLES are the product. If the suspension is clear or barely tinted, SAY SO rather than reporting whatever colour it was layered over — that colour belongs to the polish underneath, not to this one.
- Report glitterColors and flakeColors exhaustively, with sizes; they are the identity.
- Expect baseColor to be null or near-neutral. A strong base reading on a topper usually means the layer underneath was measured by mistake.`,

  "top-coat": `TYPE: TOP COAT — a finishing product, not a colour.
- Expect no meaningful base colour. Set colour fields to null rather than reporting whatever it was applied over.
- Describe the optical effect (gloss, matte, holographic) in observedEffects.`,

  holo: `TYPE: HOLO — the rainbow scatter is the FINISH, not the colour.
- Every holo throws similar spectral colours, so the rainbow says little about WHICH holo this is. The BASE colour under the scatter identifies it.
- baseColor: read the underlying body colour, looking past the spectral flare.
- Do NOT fill shiftColors with the rainbow. Spectral scatter belongs in observedEffects.`,

  uv: `TYPE: UV-REACTIVE — changes under UV light.
- Report the state visible in THIS frame and name the state in the labels.
- This is not thermal; UV-reactive and thermal have different triggers and must not be conflated.`,

  "glow-in-the-dark": `TYPE: GLOW IN THE DARK — a charged/glowing state and a daylight state.
- Report the state visible in this frame. A glowing-state frame is not comparable to a daylight-state frame; lower "identification" if only the glow is visible.`,

  crackle: `TYPE: CRACKLE — splits into a cracked pattern as it dries.
- Report the CRACKLE colour as the base, and the colour showing through the gaps separately in shiftColors, labelled as the underlying layer.`,
};

/** FINISH guidance — governs WHICH discriminator fields carry identity. */
const FINISH_GUIDANCE: Partial<Record<PolishFinish, string>> = {
  multichrome: `FINISH: MULTICHROME — adds shiftColors. The polish BODY travels through a range of colours with viewing angle, and that range is part of its identity.
- shiftColors: EVERY distinct colour the body passes through, beyond the one recorded as baseColor. Do not omit a shift colour because it occupies few pixels.
- bottleEdgeColor is especially valuable here — the rim shows the body colour more consistently than the shifting face.
- This applies to the BODY of the polish. A travelling shimmer or a shifting magnetic band is not this; those belong in shimmerFlashColors and magneticLineColor. Follow the TYPE instruction above for where baseColor is read.`,

  duochrome: `FINISH: DUOCHROME — adds shiftColors, with the body shifting between TWO main colours.
- shiftColors: the second colour. Two duochromes sharing a base are told apart by it. Read baseColor per the TYPE instruction above.`,

  shimmer: `FINISH: SHIMMER — adds shimmerFlashColors. The colour the shimmer FLASHES is frequently a different hue from the base and is the main discriminator between otherwise similar shades.
- shimmerFlashColors: what the shimmer throws, INCLUDING its travel if it shifts. "green to blue" is TWO entries, not one, and a travelling shimmer is still a shimmer — it does not make the polish a multichrome.
- Read the flash where it is actually flaring; read the base elsewhere, per the TYPE instruction above.`,

  glitter: `FINISH: GLITTER — adds glitterColors.
- glitterColors: EVERY distinct glitter colour, with sizes when they differ. The mix is the fingerprint.
- Particle finish goes in componentFinish. Matte glitter in a glossy polish does not make the polish matte.`,

  flakies: `FINISH: FLAKIES — tiny/micro flakes (distinct from flakes, which are larger).
- flakeColors: the colours the flakes show, including their range if they shift.
- Confirm the size in componentFinish.flakeSize using the closeup image.`,

  flakes: `FINISH: FLAKES — larger flake pieces (distinct from flakies, which are micro).
- flakeColors: the colours the flakes show, including their range if they shift.
- Confirm the size in componentFinish.flakeSize using the closeup image.`,

  holographic: `FINISH: HOLOGRAPHIC — rainbow spectral scatter.
- The rainbow is shared by every holo and identifies nothing, so do not record it as a shift colour. Read baseColor past the flare, per the TYPE instruction above.
- Note in componentFinish whether the scatter is linear (tight rainbow lines) or scattered.`,

  reflective: `FINISH: REFLECTIVE — glass-flake particles that flare intensely under direct light.
- Under flash the flare can swamp the frame and read as a rainbow. That is the PARTICLES firing, not a holographic base — do not reclassify the polish because of it.
- Read baseColor from a shadowed area where the particles are not firing.`,

  metallic: `FINISH: METALLIC — dense reflective particles.
- Read baseColor away from specular hotspots, which blow out toward white and are not the polish colour.`,

  chrome: `FINISH: CHROME — mirror-like.
- The surface reflects its surroundings. Read the polish colour where it is NOT mirroring something else, and never report a reflected object's colour as the polish.`,

  foil: `FINISH: FOIL — dense metallic foil particles with visible texture.
- Read baseColor across several particles rather than from one bright fleck.`,

  matte: `FINISH: MATTE — no gloss. Report this ONLY if the POLISH is matte. Matte particles in a glossy polish belong in componentFinish and must never reach observedEffects.`,
};

/**
 * Compose guidance from the operator-supplied type and finishes. Type comes
 * first because it governs where the base is read, which everything else
 * depends on.
 */
/**
 * PRECEDENCE: the TYPE block owns `baseColor` — where to read it, and what
 * counts as "the base" at all. Finish blocks may only ADD their own fields
 * (shiftColors, shimmerFlashColors, glitterColors, flakeColors).
 *
 * This was learned the expensive way. An earlier version let every finish block
 * redefine baseColor, so a magnetic tagged multichrome received "sample the
 * field away from the band" AND "there is no single base colour" in the same
 * prompt. Frame-to-frame base agreement regressed from 6.7 to 57.0 ΔE, and the
 * model began swapping which region it called the base and which the band.
 */
export function typeGuidance(type: PolishType | undefined, finishes?: PolishFinish[]): string {
  const parts: string[] = [];
  if (type && TYPE_GUIDANCE[type]) parts.push(TYPE_GUIDANCE[type]!);
  for (const f of finishes ?? []) if (FINISH_GUIDANCE[f]) parts.push(FINISH_GUIDANCE[f]!);
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

/**
 * Classifier prompt — FALLBACK ONLY, for shades with no product and no
 * description. See the file header for its measured error rate; never let its
 * output stand in for operator truth.
 */
export function classifyPrompt(brand: string): string {
  return `This is a photograph of ${brand} nail polish. Identify its TYPE and its FINISHES.

These are two INDEPENDENT questions and must not be collapsed. A polish has one primary type and can have SEVERAL finishes at once. Reporting the loudest visual effect as if it were the type is the specific mistake to avoid: "multichrome" is a FINISH, never a type.

Two traps in particular:
- A thermal caught in a single state looks like an ordinary polish. If you see glitter or flakes, that does not make the TYPE "glitter".
- Reflective glitter under flash throws a rainbow that looks holographic. That is particles firing, not a holo base.

TYPE (the formula — pick the single best match): ${POLISH_TYPES.join(", ")}
- creme: fully opaque, no particles, no shift
- crelly: semi-opaque with suspended particles
- jelly: translucent, squishy depth
- sheer: low opacity, nail shows through
- topper / top-coat: clear or sheer, meant to layer over another colour
- magnetic: metallic particles pulled into a concentrated band or swirl
- thermal: two colour states, or a visible transition across the nail
- holo: rainbow spectral scatter is the defining character
- uv / glow-in-the-dark / crackle: as named

FINISHES (the optics — list ALL that apply, may be empty): ${POLISH_FINISHES.join(", ")}
Note flakies = tiny/micro flakes, flakes = larger pieces.

Return ONLY this JSON, no fencing:
{"polishType": "<one value>", "finishes": ["<zero or more>"], "confidence": <0.0-1.0>, "reason": "<max 12 words>"}`;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface MatchProfile {
  identityFields: string[];
  anchorWeight: number;
  gamutWeight: number;
}

/** Fallback when neither type nor finish is known. */
export const DEFAULT_PROFILE: MatchProfile = {
  identityFields: ["bottleEdgeColor", "baseColor", "shiftColors", "shimmerFlashColors", "flakeColors", "glitterColors"],
  anchorWeight: 0.5,
  gamutWeight: 1.0,
};

const TYPE_PROFILES: Partial<Record<PolishType, MatchProfile>> = {
  /**
   * Measured, and the opposite of the obvious guess.
   *
   * Once the prompt says to read the base AWAY from the band, baseColor becomes
   * the most stable measurement available: two frames of one bottle went from
   * 81.0 ΔE apart to 6.7. The BAND is not stable per frame — the particles are
   * themselves multichrome, so one band read #38aca7 teal-cyan and #c84b32
   * orange-red across two frames, 95.2 ΔE apart. The line still carries identity
   * (orange-banded vs lime-banded over comparable bases are different products)
   * but only as an accumulated SET across frames, never as a single-frame value.
   */
  magnetic: { identityFields: ["baseColor", "bottleEdgeColor", "magneticLineColor"], anchorWeight: 1.0, gamutWeight: 0.4 },
  thermal: { identityFields: ["thermalCold", "thermalWarm", "glitterColors", "flakeColors"], anchorWeight: 0.2, gamutWeight: 0.5 },
  creme: { identityFields: ["bottleEdgeColor", "baseColor"], anchorWeight: 1.0, gamutWeight: 0.0 },
  crelly: { identityFields: ["bottleEdgeColor", "baseColor"], anchorWeight: 0.9, gamutWeight: 0.3 },
  jelly: { identityFields: ["bottleEdgeColor", "baseColor"], anchorWeight: 0.9, gamutWeight: 0.3 },
  sheer: { identityFields: ["bottleEdgeColor", "baseColor"], anchorWeight: 0.8, gamutWeight: 0.3 },
  holo: { identityFields: ["bottleEdgeColor", "baseColor"], anchorWeight: 1.0, gamutWeight: 0.2 },
  // A topper's base is clear; matching on it would compare whatever was underneath.
  topper: { identityFields: ["glitterColors", "flakeColors"], anchorWeight: 0.1, gamutWeight: 1.0 },
  "top-coat": { identityFields: [], anchorWeight: 0.1, gamutWeight: 0.1 },
};

const FINISH_PROFILES: Partial<Record<PolishFinish, MatchProfile>> = {
  multichrome: { identityFields: ["bottleEdgeColor", "baseColor", "shiftColors"], anchorWeight: 0.2, gamutWeight: 1.0 },
  duochrome: { identityFields: ["bottleEdgeColor", "baseColor", "shiftColors"], anchorWeight: 0.4, gamutWeight: 0.9 },
  shimmer: { identityFields: ["bottleEdgeColor", "baseColor", "shimmerFlashColors"], anchorWeight: 0.8, gamutWeight: 0.6 },
  glitter: { identityFields: ["baseColor", "glitterColors"], anchorWeight: 0.6, gamutWeight: 0.8 },
  flakies: { identityFields: ["baseColor", "flakeColors"], anchorWeight: 0.6, gamutWeight: 0.8 },
  flakes: { identityFields: ["baseColor", "flakeColors"], anchorWeight: 0.6, gamutWeight: 0.8 },
  holographic: { identityFields: ["bottleEdgeColor", "baseColor"], anchorWeight: 1.0, gamutWeight: 0.2 },
  reflective: { identityFields: ["baseColor", "glitterColors"], anchorWeight: 0.6, gamutWeight: 0.7 },
  metallic: { identityFields: ["bottleEdgeColor", "baseColor"], anchorWeight: 0.9, gamutWeight: 0.3 },
  chrome: { identityFields: ["bottleEdgeColor", "baseColor"], anchorWeight: 0.9, gamutWeight: 0.2 },
  foil: { identityFields: ["baseColor", "flakeColors"], anchorWeight: 0.7, gamutWeight: 0.6 },
};

/**
 * Union the profiles for a shade's type and finishes, taking the strongest
 * weight any of them asks for. A crelly that is multichrome and flakie needs
 * what each contributes, not an average that dilutes all three.
 */
export function resolveProfile(type?: PolishType, finishes?: PolishFinish[]): MatchProfile {
  const picks = [
    type ? TYPE_PROFILES[type] : undefined,
    ...(finishes ?? []).map((f) => FINISH_PROFILES[f]),
  ].filter((p): p is MatchProfile => !!p);

  if (!picks.length) return DEFAULT_PROFILE;

  const fields = new Set<string>();
  let anchor = 0, gamut = 0;
  for (const p of picks) {
    p.identityFields.forEach((x) => fields.add(x));
    anchor = Math.max(anchor, p.anchorWeight);
    gamut = Math.max(gamut, p.gamutWeight);
  }
  return { identityFields: [...fields], anchorWeight: anchor, gamutWeight: gamut };
}

/**
 * Compare the compiled vocabulary against the live store. The unions cannot be
 * generated at runtime (guidance is written per value), so this makes drift
 * loud rather than silent.
 */
export function checkVocabularyDrift(liveTypes: string[], liveFinishes: string[]) {
  return {
    missingGuidance: [
      ...liveTypes.filter((t) => !POLISH_TYPES.includes(t as PolishType)),
      ...liveFinishes.filter((f) => !POLISH_FINISHES.includes(f as PolishFinish)),
    ],
    removedUpstream: [
      ...POLISH_TYPES.filter((t) => !liveTypes.includes(t)),
      ...POLISH_FINISHES.filter((f) => !liveFinishes.includes(f)),
    ],
  };
}
