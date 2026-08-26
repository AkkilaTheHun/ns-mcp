-- Remove image_signatures measured before the native-crop fix.
--
-- Before 2026-08-26 02:16 UTC the "closeup" sent to the vision model was the
-- whole frame downscaled to 800px rather than a 1:1 crop. On square swatcher
-- photos sharp's attention strategy had nothing to crop, so the closeup carried
-- LESS detail than the full image and particle-level fields (flakeColors,
-- glitterColors, flakeSize) were read from a blur.
--
-- Rows analyzed after that build measure the same shades through a real
-- magnified crop. Mixing the two in one aggregate averages two different
-- pipelines, which is worse than either alone.
--
-- Scope this deliberately. Purging everything older than the fix would delete
-- most of the catalog; the intent here is the Halloween 2026 shades indexed
-- tonight, which have post-fix replacements available.

BEGIN;

-- 1. Inspect before deleting.
SELECT s.id, s.shade_name, COUNT(*) AS rows,
       MIN(i.analyzed_at) AS oldest, MAX(i.analyzed_at) AS newest
FROM image_signatures i
JOIN shade_signatures s ON s.id = i.shade_id
WHERE s.collection = 'Halloween 2026'
  AND i.analyzed_at < TIMESTAMPTZ '2026-08-26 02:16:33+00'
GROUP BY s.id, s.shade_name
ORDER BY s.id;

-- 2. Delete only those.
DELETE FROM image_signatures i
USING shade_signatures s
WHERE s.id = i.shade_id
  AND s.collection = 'Halloween 2026'
  AND i.analyzed_at < TIMESTAMPTZ '2026-08-26 02:16:33+00';

COMMIT;

-- 3. Re-index the affected shades through analyze_images + shade_index
--    add_image, passing polishType so the aggregate stops re-deriving finish.
--    Then recompute_shade for each.
