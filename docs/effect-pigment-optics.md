# Effect-pigment optics, and what it means for this pipeline

Research notes, 2026-08-22. Written because the pipeline was built on an
assumption that turns out to be contradicted by the coatings industry's own
measurement standards.

---

## 1. What these pigments physically are

Nail polish "shimmer", "aurora", "multichrome", "duochrome" and "flakies" are
almost all **interference pigments**: thin optical films deposited on a
transparent platelet substrate — mica, borosilicate glass flake, alumina.
Colour is produced by **thin-film interference**, not by absorption, so the
wavelength that constructively interferes depends on the optical path length
through the film, which depends on the angle light enters and leaves at.

The technical term for the result is **goniochromatism**: perceived colour
varies as the angle of illumination or observation varies.

Borosilicate ("glass flake") substrates are used where high chroma and low
scatter are wanted — that's the "aurora"/"ultrachrome" look. Mica-based ones
scatter more and read softer.

## 2. The finding that invalidates single-frame colour measurement

**ASTM E2539** — *Standard Test Method for Multiangle Color Measurement of
Interference Pigments* — exists precisely because one angle is not enough. Its
preferred aspecular angles are:

| angle | position |
|---|---|
| **15°** | near-specular |
| **45°** | mid |
| **110°** | far from specular |

Three controlled angles, minimum, on a fixed-geometry instrument. There is even
a derived metric, the **flop index**, quantifying how lightness changes between
them: `FI = 2.69 (L*15 − L*110)^1.11 / (L*45)^0.96`.

The related ASTM E2194 does the same for metal-flake pigments.

**The implication for us is blunt:** the coatings industry does not attempt to
characterise an effect pigment from a single viewing angle, because the quantity
being measured is not a colour — it is a *curve* over angle. A swatch photograph
is one uncontrolled, unknown sample from that curve.

This explains the measurements taken earlier today exactly:

| measurement | value |
|---|---|
| within-shade spread, same swatcher, same shade | median **28.3** ΔE |
| between-shade separation, hardest confirmed pair | **17.0** ΔE |
| two frames of one magnetic bottle | up to **136** ΔE |

The within-class variance exceeds the between-class signal because uncontrolled
photographic angles sample random points on a goniochromatic curve. No
threshold, linkage, prompt or snapping algorithm fixes that — it is the
measurement geometry, not the estimator.

**Conclusion: per-frame colour cannot serve as shade identity for effect
pigments.** Identification must use the whole set of colours a shade presents
(its gamut) or, better, match against a description of the product.

## 3. Magnetics specifically

Magnetic ("cat eye") polishes suspend **paramagnetic, needle-shaped particles**
— carbonyl iron powder, or mica coated with iron oxide. A neodymium magnet held
over the wet polish aligns them along the field lines; they lock in place as it
cures. They are not permanently magnetised and relax when the field is removed.

Two consequences the pipeline has to respect:

1. **The band is an artifact of the magnet, not of the product.** Its position,
   width and shape depend on how the swatcher held the magnet. Straight bars
   give a linear streak; curved or multi-pole magnets give waves, doubles or
   starbursts. Two photos of the same polish can have the band in different
   places.
2. **The band is itself goniochromatic.** The aligned particles form tiny
   angled reflective surfaces inside the film, so the band's own colour shifts
   as the hand moves. Measured here: one band read `#38aca7` teal-cyan in one
   frame and `#c84b32` orange-red in another — **95.2 ΔE apart**, on what is
   certainly the same polish.

So "the magnetic line colour is the discriminator" (spec §1.3) is true of the
*product* and false of any *single frame*. It only works as an accumulated set.

**And polish in the bottle is unmagnetised.** A bottle shot shows carrier plus
randomly-oriented particles and no band at all. Asking for a band there produces
invention.

## 4. Why a multi-swatcher folder is well suited to identification

Seven swatchers shooting the same polish under different lights and angles is a
poor multi-angle *measurement* (the geometry is unknown and uncontrolled) but a
good *sample of the gamut*: collectively the frames traverse much of the curve.

That is an argument for identification-by-description over
identification-by-colour-distance. A description like "murky teal base packed
with magenta to orange shimmer" already encodes the gamut in the form a human
uses to recognise it, and it is invariant to the angle any one frame happened
to catch.

## 5. Prompt / vision-API findings that change our settings

From the Claude vision documentation:

- **Images before text.** Documented explicitly: "Claude works best when images
  come before text." Our measurement prompt already does this; the batch
  assignment path does too.
- **Resolution tiers.** Standard-tier models downscale to a **1568 px** long
  edge; Claude 4.7 and later run a high-resolution tier at **2576 px** / 4784
  visual tokens. We were sending **1400 px** — below even the standard cap, so
  we were discarding fidelity for free. Raised to 1568.
- **Compression artifacts hurt.** "Heavy JPEG compression can introduce
  artifacts that are detrimental to model performance." For flake morphology
  this is exactly the wrong thing to economise on; the closeup crop is now
  q95 rather than q92.
- **Label each image.** "Introduce each one with a short text label (Image 1:,
  Image 2:)" — we do.
- **Batch size.** Up to 100 images per request on 200k-context models, but past
  **20 images** a stricter 2000 px per-image limit kicks in. Keep batches ≤20 to
  stay at full resolution.
- **Claude does not read image metadata.** EXIF is invisible to the model, so
  capture time and camera must be passed as text if they matter.
- **Counting is approximate**, "especially with large numbers of small objects"
  — so never rely on glitter/flake *counts*, only on their colours and sizes.

## Sources

- [ASTM E2539 — Multiangle Color Measurement of Interference Pigments](https://www.astm.org/e2539-14r21.html)
- [ASTM E2194 — Multiangle Color Measurement of Metal Flake Pigmented Materials](https://standards.iteh.ai/catalog/standards/astm/9025f713-acfb-475e-b6b2-ff2942fa4896/astm-e2194-14)
- [Goniochromism of Multicolor and Interference Pigments Under Varying Illumination Conditions](https://doi.org/10.3390/app16126103)
- [Chemikos — Introduction to effect pigments](https://chemikos.de/en/introduction-effect-pigment)
- [US20070048239A1 — Goniochromatic multi-layer effect materials in cosmetics](https://patents.google.com/patent/US20070048239)
- [NailKnowledge — How do cat eye nails work](https://nailknowledge.org/blog/how-do-cat-eye-nails-work)
- [Anthropic — Vision documentation](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Anthropic — Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
