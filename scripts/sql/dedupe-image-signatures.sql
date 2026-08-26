-- Cleanup + guard for image_signatures duplicates.
--
-- add_image used a plain INSERT, so re-indexing a folder appended a second full
-- set of rows and the shade aggregate was then computed over the duplicates.
-- As of 2026-08-26: 6860 rows, 114 of them duplicate (shade 102 x93, shade 779 x21).
--
-- Run inside a transaction and review each SELECT before the DELETE.
-- The unique index at the end cannot be created until duplicates are gone.

BEGIN;

-- 1. What will be removed: every row that is not the newest for its
--    (shade_id, source_path). Newest wins because later runs came through the
--    fixed native-resolution crop; earlier ones were measured on a downscaled
--    frame that could not resolve particles.
WITH ranked AS (
  SELECT id, shade_id, source_path, analyzed_at,
         ROW_NUMBER() OVER (
           PARTITION BY shade_id, source_path
           ORDER BY analyzed_at DESC, id DESC
         ) AS rn
  FROM image_signatures
)
SELECT shade_id, COUNT(*) AS rows_to_delete,
       MIN(analyzed_at) AS oldest, MAX(analyzed_at) AS newest
FROM ranked WHERE rn > 1
GROUP BY shade_id ORDER BY rows_to_delete DESC;

-- 2. Delete them.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY shade_id, source_path
           ORDER BY analyzed_at DESC, id DESC
         ) AS rn
  FROM image_signatures
)
DELETE FROM image_signatures
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3. Verify: must return zero rows.
SELECT COUNT(*) - COUNT(DISTINCT (shade_id, source_path)) AS remaining_duplicates
FROM image_signatures;

-- 4. Guard, so this cannot recur. add_image now upserts on this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS image_signatures_shade_source_uniq
  ON image_signatures (shade_id, source_path);

COMMIT;

-- 5. AFTER committing, recompute every affected shade so the aggregates stop
--    reflecting the deleted rows. Via MCP:
--      shade_index(action:"recompute_shade", shadeId:102, polishType:"<type>")
--      shade_index(action:"recompute_shade", shadeId:779, polishType:"crelly")
