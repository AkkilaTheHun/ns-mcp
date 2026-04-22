# NailStuff SEO Writing Reference

Quick reference for writing product SEO. This covers the actionable rules, not store audit findings.

## SEO Titles

**Format:** `{Product Name} - {Brand} {Type} | NailStuff Canada` / `| NailStuff USA`

**Character limit:** 60 characters max (Google truncates after ~60)

**Rules:**
- Product name first (most important keyword position)
- Include brand name
- Include product type (e.g., "Nail Polish", "Thermal Nail Polish", "Magnetic Nail Polish")
- NailStuff Canada / NailStuff USA at the end
- CA and US titles must be different (not just a country swap)

**Examples:**
- CA: `Blazing Evening Sky - Chamaeleon Flakie Polish | NailStuff Canada`
- US: `Blazing Evening Sky Flakie Nail Polish by Chamaeleon | NailStuff USA`

## Meta Descriptions

**Character limit:** 145-160 characters. Under 145 wastes space. Over 160 gets truncated.

**Structure:**
1. Lead with product appeal (color, effect, what makes it special)
2. Include brand name naturally
3. End with commercial hook (shipping, exclusivity, availability)

**CA vs US must be meaningfully different:**
- Different sentence structure (don't just swap "Canada" for "USA")
- Different emphasis (CA: indie/handmade/Canadian, US: fast shipping/exclusive selection)
- Different keyword ordering
- Spelling: colour/color, favourite/favorite

**Examples:**
- CA: `Blazing Evening Sky by Chamaeleon features stunning multichrome flakies that shift from purple to copper. Shop indie nail polish at NailStuff Canada.`
- US: `A bold multichrome flakie polish that shifts purple to copper. Blazing Evening Sky from Chamaeleon, available with fast US shipping at NailStuff.`

## Handles (URL Slugs)

**Pattern:** `{brand}-{collection}-{product-name}-nail-polish`

**Rules:**
- All lowercase, kebab-case
- Include brand, collection (if applicable), and product name
- End with product type identifier
- Check recent products from same brand for consistency

**Example:** `chamaeleon-harvest-time-blazing-evening-sky-nail-polish`

## The US Market Problem

Google Search Console indexes the US market (.co) at ~2% because of duplicate content across .ca and .co. Every SEO decision should help differentiate US content.

**This means:**
- US body_html MUST be meaningfully rewritten (not just spelling swaps)
- US meta descriptions MUST use different sentence structure
- US titles MUST have different keyword ordering
- Even when the CA copy has no obvious Canadian language, the US version must be distinct

**Rewriting strategies when CA copy has no Canadian language:**
- Restructure sentences (lead with different details)
- Use different synonyms and phrasing
- Adjust the commercial hook (CA = indie/handmade, US = fast shipping/exclusive)
- Reorder the description flow

## Product Descriptions

**Length:** 2-3 sentences default. 3-5 when source material supports it.

**Structure:**
1. Opening: product name + type + brand + collection naturally
2. Color/effect breakdown: base color, shimmer/shift behavior, how it moves in light
3. Optional: one concrete detail from vendor data (coat count, opacity, collection theme)
4. Soft SEO: 1-2 sentences working in secondary keywords

**Hard rules:**
- No em-dashes. Use commas, periods, semicolons.
- No fluff without backing
- No hallucinated claims
- No ingredient mentions
- No fake urgency
- Shorter is better than padded

**Image analysis informs descriptions.** If vision analysis shows effects the vendor didn't mention (e.g., vendor says "gold shimmer" but images show gold-to-green shift), describe what's visible.

## Keywords by Product Type

**Nail polish general:** nail polish, indie nail polish, handmade nail polish, artisan polish
**Magnetic:** magnetic nail polish, cat eye nail polish, magnetic effect
**Thermal:** thermal nail polish, color-changing nail polish, temperature-sensitive
**Multichrome:** multichrome nail polish, color-shifting, duochrome
**Flakies:** flakie nail polish, iridescent flakies, chameleon flakes
**Holographic:** holographic nail polish, holo polish, rainbow effect
**Reflective:** reflective glitter nail polish, reflective polish, disco ball effect
**Jelly:** jelly nail polish, translucent nail polish, jelly finish
**Crelly:** crelly nail polish, cream-jelly hybrid

## Alt Text

**Format:** `"{Effect/finish} {brand} nail polish in {shade name}, {what's shown}, {skin tone if visible}, {lighting note}"`

- Each image gets unique alt text
- Bottle shots and swatches of the same polish get different descriptions
- Include skin tone for accessibility (fair, light, light-medium, medium, medium-deep, deep, rich)
- Include swatcher credit when known: ", swatched by @handle"

## Tags

**Functional tags only.** No legacy `Brand_*`, `Colour_*`, `Type_*`, `Collection_*` tags.

Common functional tags:
- `Preorder` (for preorder products)
- `__label4:Back in Stock` (Shopify label)
- `__label:Made in Canada` (for Canadian brands)
- Season tags where applicable (Spring, Fall, etc.)
