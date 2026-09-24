-- ============================================================
-- Scenes (Phase 9f — vocabulary moved out of this file into scene_families /
-- scene_tag_map / scene_origin_map, which the owner edits in Settings → Tuning → Scenes).
-- Rebuilds artist_scene: which scene families each artist belongs to, and how strongly.
--   1. tags: every tag the artist carries that maps to a visible family, weight summed per family
--      (an artist can sit in several); floor 0.3 so one weak tag does not file an artist.
--   2. origin: artists with no mapped tag fall back to their MusicBrainz origin country.
--   3. overrides: the owner's own filing decisions win (weight 9 marks "filed by you").
-- Runs standalone (Settings → Scenes → "Re-file now"), inside rebuild_all, and before compute_insights.
-- ============================================================
-- Phase 9j: tags the owner removed never file anyone
DELETE FROM artist_tags WHERE EXISTS (SELECT 1 FROM tag_blocks b WHERE b.artist_id = artist_tags.artist_id AND b.tag = lower(artist_tags.tag));

DELETE FROM artist_scene;

INSERT INTO artist_scene
SELECT t.artist_id, m.scene, SUM(t.weight) AS w
FROM artist_tags t
JOIN scene_tag_map m ON m.tag = lower(t.tag)
JOIN scene_families f ON f.scene = m.scene AND NOT f.hidden
GROUP BY 1, 2
HAVING SUM(t.weight) >= 0.3;

INSERT INTO artist_scene
SELECT o.artist_id, m.scene, 0.5
FROM artist_origin o
JOIN scene_origin_map m ON m.country = o.country
JOIN scene_families f ON f.scene = m.scene AND NOT f.hidden
WHERE NOT EXISTS (SELECT 1 FROM artist_scene s WHERE s.artist_id = o.artist_id);

DELETE FROM artist_scene WHERE artist_id IN (SELECT artist_id FROM scene_overrides);
INSERT INTO artist_scene SELECT artist_id, scene, 9.0 FROM scene_overrides WHERE scene IS NOT NULL;
