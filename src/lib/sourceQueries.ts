/**
 * Phase 9l — how polled plays and extended-history exports fit together. After an import, every polled play inside
 * the export's date range is either REPLACED by the export's richer row (real ms played, skip reason, device, country)
 * or KEPT because the export doesn't contain it. Polled plays after the export's last day wait for the next export.
 * The matching rule lives in entity_resolution.sql (same track, poll time within 15 s of the export's start or end).
 */
import { query, num, str } from './db';

export type SourceCoverage = {
  exportFrom: string | null; exportTo: string | null; exportPlays: number; exportFiles: number;
  polledTotal: number; polledReplaced: number; polledKeptInRange: number; polledAfterExport: number; polledBeforeExport: number;
  inferredSkipsPending: number;   // polled plays whose skip is still inferred (not yet confirmed by an export)
};

export async function sourceCoverage(): Promise<SourceCoverage> {
  const [e] = await query(`SELECT CAST(MIN(CAST(played_at_utc AS DATE)) AS VARCHAR) AS f, CAST(MAX(CAST(played_at_utc AS DATE)) AS VARCHAR) AS l, COUNT(*) AS n,
                                  (SELECT COUNT(DISTINCT source_file) FROM events WHERE event_type = 'play' AND json_extract_string(payload, '$.source') = 'extended_export') AS files
                           FROM plays_normalized WHERE source = 'extended_export'`);
  const [p] = await query(`
    WITH ex AS (SELECT MIN(played_at_utc) AS f, MAX(played_at_utc) AS l FROM plays_normalized WHERE source = 'extended_export'),
         poll AS (SELECT n.play_id, n.raw_at, EXISTS (SELECT 1 FROM plays_resolved r WHERE r.play_id = n.play_id) AS kept, n.was_skipped FROM plays_normalized n WHERE n.source = 'recently_played_poll')
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE NOT kept) AS replaced,
           COUNT(*) FILTER (WHERE kept AND raw_at BETWEEN (SELECT f FROM ex) AND (SELECT l FROM ex)) AS kept_in,
           COUNT(*) FILTER (WHERE kept AND raw_at > COALESCE((SELECT l FROM ex), TIMESTAMPTZ '1900-01-01')) AS after,
           COUNT(*) FILTER (WHERE kept AND raw_at < (SELECT f FROM ex)) AS before,
           COUNT(*) FILTER (WHERE kept AND was_skipped) AS inferred
    FROM poll`);
  return { exportFrom: str(e?.f)?.slice(0, 10) ?? null, exportTo: str(e?.l)?.slice(0, 10) ?? null, exportPlays: num(e?.n), exportFiles: num(e?.files),
    polledTotal: num(p?.total), polledReplaced: num(p?.replaced), polledKeptInRange: num(p?.kept_in), polledAfterExport: num(p?.after), polledBeforeExport: num(p?.before), inferredSkipsPending: num(p?.inferred) };
}
