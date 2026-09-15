import { describe, expect, it } from 'vitest';
import { ensureLimit, isSafeSelect, tracksFrom } from '../ask';

describe('Ask the Archive guards (Phase 9e)', () => {
  it('accepts a single SELECT / WITH and rejects everything else', () => {
    expect(isSafeSelect('SELECT 1')).toBeNull();
    expect(isSafeSelect('  with x as (select 1) select * from x;')).toBeNull();
    expect(isSafeSelect('DELETE FROM events')).toMatch(/only SELECT/);
    expect(isSafeSelect('SELECT 1; DROP TABLE events')).toMatch(/single statement/);
    expect(isSafeSelect("WITH x AS (SELECT 1) SELECT * FROM x WHERE 1 = (COPY x TO 'out.csv')")).toMatch(/disallowed/);
    expect(isSafeSelect('SELECT * FROM pragma_database_size()')).toBeNull(); // read-only table function, not a PRAGMA statement
  });
  it('adds a LIMIT only when missing', () => {
    expect(ensureLimit('SELECT 1')).toBe('SELECT 1 LIMIT 200');
    expect(ensureLimit('SELECT 1 LIMIT 5;')).toBe('SELECT 1 LIMIT 5;');
  });
  it('lifts track rows into TrackRows when the columns are there', () => {
    const rows = [{ track_id: 'a', track_name: 'One', artist_name: 'X', plays: 3 }, { track_id: 'a', track_name: 'One', artist_name: 'X', plays: 3 }, { track_id: 'b', track_name: 'Two', artist_name: 'Y', plays: 1 }];
    expect(tracksFrom(rows)?.map((t) => t.trackId)).toEqual(['a', 'b']);
    expect(tracksFrom([{ artist_name: 'X', plays: 3 }])).toBeNull();
  });
});
