/**
 * Phase 9i — everything the record knows about one artist / album / song, with where each value came from, so the
 * owner can see *why* something is wrong (e.g. which MusicBrainz match an origin came through) and correct it.
 * Writes go through host commands: meta_set, artist_set_origin, artist_mb_candidates, artist_set_mbid.
 */
import { invoke } from './bridge';
import { query, num, str } from './db';

export type Sourced<T> = { value: T | null; source: string | null; owner: boolean };
export type ArtistMeta = {
  artistId: string; name: string; spotifyId: string | null; imageUrl: Sourced<string>;
  mbid: string | null; matchMethod: string | null; matchEvidence: string | null; namesakes: number | null; matchCheckedAt: string | null;
  country: Sourced<string>; city: string | null; formedYear: number | null;
  tags: { tag: string; weight: number; source: string }[]; scene: string | null; sceneLabel: string | null; sceneByYou: boolean;
  listeners: number | null; listenersAt: string | null;
};

export async function artistMeta(id: string): Promise<ArtistMeta | null> {
  const [a] = await query(`
    SELECT a.artist_id, a.name, a.mbid, a.image_url, (SELECT value FROM metadata_overrides o WHERE o.entity_type = 'artist' AND o.entity_id = a.artist_id AND o.field = 'image_url') AS img_owner,
           m.method, m.evidence, m.candidates, CAST(m.checked_at AS VARCHAR) AS checked,
           o.country, o.city, o.formed_year, o.source AS origin_source,
           ap.listeners, CAST(ap.fetched_at AS VARCHAR) AS lat,
           (SELECT arg_max(scene, weight) FROM artist_scene s WHERE s.artist_id = a.artist_id) AS scene,
           (SELECT MAX(weight) FROM artist_scene s WHERE s.artist_id = a.artist_id) AS scene_w
    FROM artists a LEFT JOIN artist_mb_match m USING (artist_id) LEFT JOIN artist_origin o USING (artist_id) LEFT JOIN artist_popularity ap USING (artist_id)
    WHERE a.artist_id = $1`, [id]);
  if (!a) return null;
  const tags = (await query(`SELECT tag, weight, source FROM artist_tags WHERE artist_id = $1 ORDER BY weight DESC LIMIT 16`, [id])).map((r) => ({ tag: String(r.tag), weight: num(r.weight), source: String(r.source) }));
  const [lab] = a.scene ? await query(`SELECT label FROM scene_families WHERE scene = $1`, [a.scene]) : [];
  const ownerOrigin = a.origin_source === 'owner';
  return {
    artistId: String(a.artist_id), name: String(a.name), spotifyId: /^[A-Za-z0-9]{22}$/.test(String(a.artist_id)) ? String(a.artist_id) : null,
    imageUrl: { value: str(a.image_url), source: a.img_owner ? 'you' : a.image_url ? 'Spotify' : null, owner: Boolean(a.img_owner) },
    mbid: str(a.mbid), matchMethod: str(a.method) ?? (a.mbid ? 'name (before 9i)' : null), matchEvidence: str(a.evidence), namesakes: a.candidates == null ? null : num(a.candidates), matchCheckedAt: str(a.checked),
    country: { value: str(a.country), source: ownerOrigin ? 'you' : a.origin_source ? 'MusicBrainz' : null, owner: ownerOrigin }, city: str(a.city), formedYear: a.formed_year == null ? null : num(a.formed_year),
    tags, scene: str(a.scene), sceneLabel: lab ? String(lab.label) : str(a.scene), sceneByYou: num(a.scene_w) >= 9,
    listeners: a.listeners == null ? null : num(a.listeners), listenersAt: str(a.lat),
  };
}

export type AlbumMeta = { albumId: string; name: string; artist: string | null; artistId: string | null; releaseDate: Sourced<string>; albumType: string | null; totalTracks: number | null; imageUrl: Sourced<string>; spotifyId: string | null };
export async function albumMeta(id: string): Promise<AlbumMeta | null> {
  const [a] = await query(`
    SELECT al.album_id, al.name, al.artist_id, ar.name AS artist, CAST(al.release_date AS VARCHAR) AS rd, al.album_type, al.total_tracks, al.image_url, al.enriched_at IS NOT NULL AS enriched,
           (SELECT value FROM metadata_overrides o WHERE o.entity_type = 'album' AND o.entity_id = al.album_id AND o.field = 'release_date') AS rd_owner,
           (SELECT value FROM metadata_overrides o WHERE o.entity_type = 'album' AND o.entity_id = al.album_id AND o.field = 'image_url') AS img_owner
    FROM albums al LEFT JOIN artists ar ON ar.artist_id = al.artist_id WHERE al.album_id = $1`, [id]);
  if (!a) return null;
  return {
    albumId: String(a.album_id), name: String(a.name), artist: str(a.artist), artistId: str(a.artist_id),
    releaseDate: { value: str(a.rd)?.slice(0, 10) ?? null, source: a.rd_owner ? 'you' : a.rd ? 'Spotify' : null, owner: Boolean(a.rd_owner) },
    albumType: str(a.album_type), totalTracks: a.total_tracks == null ? null : num(a.total_tracks),
    imageUrl: { value: str(a.image_url), source: a.img_owner ? 'you' : a.image_url ? 'Spotify / Cover Art Archive' : null, owner: Boolean(a.img_owner) },
    spotifyId: /^[A-Za-z0-9]{22}$/.test(String(a.album_id)) ? String(a.album_id) : null,
  };
}

export type TrackMeta = {
  trackId: string; name: string; artist: string | null; artistId: string | null; album: string | null; albumId: string | null;
  durationMs: number | null; isrc: Sourced<string>; releaseDate: Sourced<string>; explicit: boolean | null; spotifyId: string | null;
  features: { bpm: number | null; key: string | null; camelot: string | null; energy: number | null; loudness: number | null; found: boolean } | null;
  lyrics: { lang: string | null; themes: string[]; valence: number | null; repetition: number | null; llmMood: string | null; found: boolean } | null;
  credits: { name: string; mbid: string | null; order: number }[];
};
export async function trackMeta(id: string): Promise<TrackMeta | null> {
  const [t] = await query(`
    SELECT t.track_id, t.name, t.artist_id, ar.name AS artist, t.album_id, al.name AS album, COALESCE(t.duration_ms, t.duration_ms_est) AS dur, t.isrc, CAST(t.release_date AS VARCHAR) AS rd, t.explicit,
           (SELECT value FROM metadata_overrides o WHERE o.entity_type = 'track' AND o.entity_id = t.track_id AND o.field = 'isrc') AS isrc_owner,
           (SELECT value FROM metadata_overrides o WHERE o.entity_type = 'track' AND o.entity_id = t.track_id AND o.field = 'release_date') AS rd_owner
    FROM tracks t LEFT JOIN artists ar ON ar.artist_id = t.artist_id LEFT JOIN albums al ON al.album_id = t.album_id WHERE t.track_id = $1`, [id]);
  if (!t) return null;
  const [f] = await query(`SELECT bpm, key_name, camelot, energy, loudness_db, found FROM track_features WHERE track_id = $1`, [id]);
  const [l] = await query(`SELECT lang, themes, valence, repetition, llm_mood, found FROM track_lyric_features WHERE track_id = $1`, [id]);
  const credits = (await query(`SELECT artist_name, artist_mbid, credit_order FROM track_credits WHERE track_id = $1 ORDER BY credit_order`, [id])).map((r) => ({ name: String(r.artist_name), mbid: str(r.artist_mbid), order: num(r.credit_order) }));
  return {
    trackId: String(t.track_id), name: String(t.name), artist: str(t.artist), artistId: str(t.artist_id), album: str(t.album), albumId: str(t.album_id),
    durationMs: t.dur == null ? null : num(t.dur),
    isrc: { value: str(t.isrc), source: t.isrc_owner ? 'you' : t.isrc ? 'Spotify' : null, owner: Boolean(t.isrc_owner) },
    releaseDate: { value: str(t.rd)?.slice(0, 10) ?? null, source: t.rd_owner ? 'you' : t.rd ? 'Spotify' : null, owner: Boolean(t.rd_owner) },
    explicit: t.explicit == null ? null : Boolean(t.explicit), spotifyId: /^[A-Za-z0-9]{22}$/.test(String(t.track_id)) ? String(t.track_id) : null,
    features: f ? { bpm: f.bpm == null ? null : num(f.bpm), key: str(f.key_name), camelot: str(f.camelot), energy: f.energy == null ? null : num(f.energy), loudness: f.loudness_db == null ? null : num(f.loudness_db), found: Boolean(f.found) } : null,
    lyrics: l ? { lang: str(l.lang), themes: Array.isArray(l.themes) ? (l.themes as unknown[]).map(String) : [], valence: l.valence == null ? null : num(l.valence), repetition: l.repetition == null ? null : num(l.repetition), llmMood: str(l.llm_mood), found: Boolean(l.found) } : null,
    credits,
  };
}

export type MbCandidate = { mbid: string; name: string; disambiguation: string | null; type: string | null; country: string | null; area: string | null; beginArea: string | null; begin: string | null; end: string | null; score: number };
export const metaSet = (entityType: 'artist' | 'album' | 'track', entityId: string, field: string, value: string | null) => invoke<void>('meta_set', { entityType, entityId, field, value });
export const setArtistOrigin = (artistId: string, country: string | null, city: string | null, formedYear: number | null) => invoke<void>('artist_set_origin', { artistId, country, city, formedYear });
export const mbCandidates = (artistId: string) => invoke<MbCandidate[]>('artist_mb_candidates', { artistId });
export const setArtistMbid = (artistId: string, mbid: string) => invoke<void>('artist_set_mbid', { artistId, mbid });
