import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { inTauri } from '@/lib/bridge';
import { fmtInt } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { albumMeta, artistMeta, mbCandidates, metaSet, setArtistMbid, setArtistOrigin, trackMeta, type MbCandidate } from '@/lib/metaQueries';
import { flag } from '@/lib/originQueries';

/**
 * Phase 9i — "What Deep Cuts knows" on the Artist, Album and Song pages. Every value shows where it came from;
 * the ones that feed other pages (origin, MusicBrainz match, release date, ISRC, artwork) can be corrected, and
 * corrections are marked "you" and survive every rebuild and enrichment pass.
 */
const REGION = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const countryName = (cc: string | null) => (cc ? (() => { try { return REGION?.of(cc) ?? cc; } catch { return cc; } })() : null);
const METHOD: Record<string, string> = { owner: 'chosen by you', isrc: 'confirmed by the ISRC of one of your tracks', albums: 'picked among namesakes by matching your albums', name: 'name match only — unverified', 'name (before 9i)': 'name match only (made before 9i) — being re-checked', ambiguous: 'several artists share this name — pick one below', none: 'MusicBrainz has no artist by this exact name' };

function Row({ label, children, source }: { label: string; children: ReactNode; source?: string | null }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr_auto] items-baseline gap-3 border-b border-line/50 py-1.5 text-sm last:border-0">
      <span className="text-xs text-dust">{label}</span>
      <span className="min-w-0 break-words">{children ?? <span className="text-dust/60">—</span>}</span>
      {source ? <span className={`shrink-0 rounded-full px-2 text-[10px] ${source === 'you' ? 'bg-amber/15 text-amber' : 'text-dust/70'}`}>{source}</span> : <span />}
    </div>
  );
}

function useSaver(reload: () => void) {
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const save = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setErr(null); setMsg(null); try { await fn(); setMsg(ok); reload(); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };
  return { busy, msg, err, save };
}

function FieldEdit({ label, initial, placeholder, onSave, onClear, busy, hint }: { label: string; initial: string; placeholder: string; onSave: (v: string) => void; onClear?: () => void; busy: boolean; hint?: string }) {
  const [v, setV] = useState(initial);
  return (
    <label className="block text-xs text-dust">
      {label}
      <span className="mt-1 flex gap-2">
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream" />
        <button disabled={busy || v.trim() === initial.trim()} onClick={() => onSave(v)} className="rounded-full border border-line px-3 text-dust hover:text-cream disabled:opacity-40">Save</button>
        {onClear && <button disabled={busy} onClick={onClear} className="rounded-full px-2 text-dust hover:text-coral" title="Drop your correction and go back to the automatic value">Reset</button>}
      </span>
      {hint && <span className="mt-0.5 block text-[11px] text-dust/70">{hint}</span>}
    </label>
  );
}

// ------------------------------------------------------------------ Artist
export function ArtistMetadata({ artistId }: { artistId: string }) {
  const [tick, setTick] = useState(0);
  const m = useAsync(() => artistMeta(artistId), [artistId, tick]);
  const { busy, msg, err, save } = useSaver(() => setTick((t) => t + 1));
  const [editing, setEditing] = useState(false);
  const [cands, setCands] = useState<MbCandidate[] | null>(null);
  const [candErr, setCandErr] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  if (m.error) return <Card title="What Deep Cuts knows"><ErrorBox message={m.error} /></Card>;
  if (!m.data) return <Card title="What Deep Cuts knows"><Loading /></Card>;
  const a = m.data;
  const loadCands = async () => { setCandErr(null); try { setCands(await mbCandidates(artistId)); } catch (e) { setCandErr(String(e)); } };
  return (
    <Card title="What Deep Cuts knows" subtitle="Every value with its source. Your corrections are marked “you” and survive rebuilds and enrichment." aside={<button onClick={() => setEditing(!editing)} className="text-xs text-dust hover:text-amber">{editing ? 'Done' : 'Edit'}</button>}>
      {msg && <p className="mb-2 text-xs text-moss">{msg}</p>}{err && <div className="mb-2"><ErrorBox message={err} /></div>}
      <Row label="Origin" source={a.country.source}>{a.country.value ? <>{flag(a.country.value)} {countryName(a.country.value)}{a.city ? ` · ${a.city}` : ''}{a.formedYear ? ` · since ${a.formedYear}` : ''}</> : null}</Row>
      <Row label="MusicBrainz" source={a.matchMethod === 'owner' ? 'you' : a.mbid ? 'MusicBrainz' : null}>
        {a.mbid ? <><a href={`https://musicbrainz.org/artist/${a.mbid}`} target="_blank" rel="noreferrer" className="num text-xs underline hover:text-amber">{a.mbid.slice(0, 8)}…</a> <span className={`text-xs ${a.matchMethod?.startsWith('name') ? 'text-amber' : 'text-dust'}`}>{METHOD[a.matchMethod ?? ''] ?? a.matchMethod}{a.matchEvidence && !['chosen by you'].includes(a.matchEvidence) ? ` (${a.matchEvidence})` : ''}</span></> : <span className="text-xs text-dust">{METHOD[a.matchMethod ?? ''] ?? 'not matched yet'}</span>}
      </Row>
      <Row label="Scene" source={a.sceneByYou ? 'you' : a.scene ? 'tags' : null}>{a.sceneLabel}</Row>
      <Row label="Tags">{a.tags.length ? <span className="flex flex-wrap gap-1">{a.tags.map((t) => <span key={t.tag + t.source} title={`${t.source} · weight ${t.weight.toFixed(2)}`} className="rounded-full border border-line px-2 text-[11px]">{t.tag}</span>)}</span> : null}</Row>
      <Row label="Last.fm listeners" source={a.listeners != null ? 'Last.fm' : null}>{a.listeners != null ? `${fmtInt(a.listeners)}${a.listenersAt ? ` · read ${a.listenersAt.slice(0, 10)}` : ''}` : null}</Row>
      <Row label="Spotify">{a.spotifyId ? <a href={`https://open.spotify.com/artist/${a.spotifyId}`} target="_blank" rel="noreferrer" className="num text-xs underline hover:text-amber">{a.spotifyId}</a> : null}</Row>
      {editing && (
        <div className="mt-4 space-y-4 rounded-xl border border-line bg-ink/30 p-4">
          <OriginEdit a={a} busy={busy} onSave={(cc, city, yr) => save(() => setArtistOrigin(artistId, cc, city, yr), 'Origin saved — Atlas and scenes use it from now on.')} onReset={() => save(() => setArtistOrigin(artistId, null, null, null), 'Back to the automatic origin; it is re-fetched on the next MusicBrainz tick.')} />
          <div>
            <p className="text-xs text-dust">Wrong MusicBrainz artist? Pick the right one — the origin, tags and relations from the old match are thrown away and fetched again from yours.</p>
            {inTauri && <button disabled={busy} onClick={loadCands} className="mt-2 rounded-full border border-line px-3 py-1 text-xs text-dust hover:text-cream">Show every “{a.name}” on MusicBrainz</button>}
            {candErr && <p className="mt-1 text-xs text-coral">{candErr}</p>}
            {cands && (
              <ul className="mt-2 max-h-[min(18rem,40vh)] divide-y divide-line/50 overflow-y-auto text-sm">
                {cands.map((c) => (
                  <li key={c.mbid} className={`flex items-baseline gap-2 py-1.5 ${c.mbid === a.mbid ? 'text-amber' : ''}`}>
                    <span className="min-w-0 flex-1"><span className="font-medium">{c.name}</span>{c.disambiguation && <span className="text-xs text-dust"> ({c.disambiguation})</span>}
                      <span className="block text-[11px] text-dust">{[c.type, c.country ? `${flag(c.country)} ${countryName(c.country)}` : null, c.area && c.area !== countryName(c.country) ? c.area : null, c.beginArea ? `from ${c.beginArea}` : null, c.begin ? `${c.begin.slice(0, 4)}${c.end ? `–${c.end.slice(0, 4)}` : '–'}` : null].filter(Boolean).join(' · ')}</span></span>
                    <a href={`https://musicbrainz.org/artist/${c.mbid}`} target="_blank" rel="noreferrer" className="text-[11px] text-dust hover:text-cream">view</a>
                    {c.mbid === a.mbid ? <span className="text-[11px]">current</span> : <button disabled={busy} onClick={() => save(() => setArtistMbid(artistId, c.mbid), `Now matched to the ${c.country ?? ''} ${c.name}. Origin and tags re-fetched.`)} className="rounded-full border border-line px-2 text-[11px] text-dust hover:text-amber">this one</button>}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex gap-2">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="…or paste a musicbrainz.org/artist/… link" className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm" />
              <button disabled={busy || url.trim().length < 36} onClick={() => save(() => setArtistMbid(artistId, url), 'MusicBrainz match set. Origin and tags re-fetched.')} className="rounded-full border border-line px-3 text-xs text-dust hover:text-cream disabled:opacity-40">Use</button>
            </div>
          </div>
          <FieldEdit label="Artist image URL" initial={a.imageUrl.owner ? a.imageUrl.value ?? '' : ''} placeholder={a.imageUrl.value ?? 'https://…'} busy={busy} onSave={(v) => save(() => metaSet('artist', artistId, 'image_url', v), 'Image saved.')} onClear={a.imageUrl.owner ? () => save(() => metaSet('artist', artistId, 'image_url', null), 'Image reset.') : undefined} />
          <p className="text-[11px] text-dust/70">Scene filing is on the record card in <Link to="/crate" className="underline hover:text-cream">The Crate</Link>; tags come from Last.fm and MusicBrainz and follow the match above.</p>
        </div>
      )}
    </Card>
  );
}

function OriginEdit({ a, busy, onSave, onReset }: { a: NonNullable<Awaited<ReturnType<typeof artistMeta>>>; busy: boolean; onSave: (cc: string | null, city: string | null, yr: number | null) => void; onReset: () => void }) {
  const [cc, setCc] = useState(a.country.value ?? ''); const [city, setCity] = useState((a.city ?? '').replace(/ \(born\/formed\)$/, '')); const [yr, setYr] = useState(a.formedYear ? String(a.formedYear) : '');
  return (
    <div>
      <p className="text-xs text-dust">Where the artist is from / based {a.country.owner && <span className="text-amber">· your correction</span>}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        <input value={cc} onChange={(e) => setCc(e.target.value.toUpperCase().slice(0, 2))} placeholder="US" aria-label="Country code" className="num w-14 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm" />
        <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City (New York)" aria-label="City" className="min-w-[10rem] flex-1 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm" />
        <input value={yr} onChange={(e) => setYr(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="since (year)" aria-label="Formed or born year" className="num w-24 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm" />
        <button disabled={busy || (cc.length !== 0 && cc.length !== 2)} onClick={() => onSave(cc || null, city || null, yr ? Number(yr) : null)} className="rounded-full border border-line px-3 text-xs text-dust hover:text-cream disabled:opacity-40">Save</button>
        {a.country.owner && <button disabled={busy} onClick={onReset} className="rounded-full px-2 text-xs text-dust hover:text-coral">Reset</button>}
      </div>
      {countryName(cc.length === 2 ? cc : null) && <p className="mt-0.5 text-[11px] text-dust">{flag(cc)} {countryName(cc)}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ Album
export function AlbumMetadata({ albumId }: { albumId: string }) {
  const [tick, setTick] = useState(0);
  const m = useAsync(() => albumMeta(albumId), [albumId, tick]);
  const { busy, msg, err, save } = useSaver(() => setTick((t) => t + 1));
  const [editing, setEditing] = useState(false);
  if (m.error) return <Card title="What Deep Cuts knows"><ErrorBox message={m.error} /></Card>;
  if (!m.data) return <Card title="What Deep Cuts knows"><Loading /></Card>;
  const a = m.data;
  return (
    <Card title="What Deep Cuts knows" subtitle="Your corrections are marked “you” and survive rebuilds." aside={<button onClick={() => setEditing(!editing)} className="text-xs text-dust hover:text-amber">{editing ? 'Done' : 'Edit'}</button>}>
      {msg && <p className="mb-2 text-xs text-moss">{msg}</p>}{err && <div className="mb-2"><ErrorBox message={err} /></div>}
      <Row label="Released" source={a.releaseDate.source}>{a.releaseDate.value}</Row>
      <Row label="Type">{a.albumType}{a.totalTracks ? ` · ${a.totalTracks} tracks` : ''}</Row>
      <Row label="Artwork" source={a.imageUrl.source}>{a.imageUrl.value ? <a href={a.imageUrl.value} target="_blank" rel="noreferrer" className="text-xs underline hover:text-amber">image</a> : null}</Row>
      <Row label="Spotify">{a.spotifyId ? <a href={`https://open.spotify.com/album/${a.spotifyId}`} target="_blank" rel="noreferrer" className="num text-xs underline hover:text-amber">{a.spotifyId}</a> : null}</Row>
      {editing && (
        <div className="mt-4 space-y-3 rounded-xl border border-line bg-ink/30 p-4">
          <FieldEdit label="Original release date" initial={a.releaseDate.owner ? a.releaseDate.value ?? '' : ''} placeholder={a.releaseDate.value ?? '1972 or 1972-03-01'} busy={busy} hint="Spotify often dates reissues and remasters by the reissue; put the original year here so Eras and Liner Notes read it right." onSave={(v) => save(() => metaSet('album', albumId, 'release_date', v), 'Release date saved.')} onClear={a.releaseDate.owner ? () => save(() => metaSet('album', albumId, 'release_date', null), 'Release date reset — back to Spotify’s after the next rebuild.') : undefined} />
          <FieldEdit label="Cover image URL" initial={a.imageUrl.owner ? a.imageUrl.value ?? '' : ''} placeholder="https://…" busy={busy} onSave={(v) => save(() => metaSet('album', albumId, 'image_url', v), 'Cover saved.')} onClear={a.imageUrl.owner ? () => save(() => metaSet('album', albumId, 'image_url', null), 'Cover reset.') : undefined} />
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ Track
export function TrackMetadata({ trackId }: { trackId: string }) {
  const [tick, setTick] = useState(0);
  const m = useAsync(() => trackMeta(trackId), [trackId, tick]);
  const { busy, msg, err, save } = useSaver(() => setTick((t) => t + 1));
  const [editing, setEditing] = useState(false);
  if (m.error) return <Card title="What Deep Cuts knows"><ErrorBox message={m.error} /></Card>;
  if (!m.data) return <Card title="What Deep Cuts knows"><Loading /></Card>;
  const t = m.data;
  const dur = t.durationMs ? `${Math.floor(t.durationMs / 60000)}:${String(Math.round((t.durationMs % 60000) / 1000)).padStart(2, '0')}` : null;
  return (
    <Card title="What Deep Cuts knows" subtitle="Your corrections are marked “you” and survive rebuilds." aside={<button onClick={() => setEditing(!editing)} className="text-xs text-dust hover:text-amber">{editing ? 'Done' : 'Edit'}</button>}>
      {msg && <p className="mb-2 text-xs text-moss">{msg}</p>}{err && <div className="mb-2"><ErrorBox message={err} /></div>}
      <Row label="Length">{dur}{t.explicit ? ' · explicit' : ''}</Row>
      <Row label="ISRC" source={t.isrc.source}>{t.isrc.value ? <span className="num">{t.isrc.value}</span> : null}</Row>
      <Row label="Released" source={t.releaseDate.source}>{t.releaseDate.value}</Row>
      <Row label="Credits" source={t.credits.length ? 'MusicBrainz' : null}>{t.credits.length ? t.credits.map((c) => c.name).join(', ') : null}</Row>
      <Row label="Audio" source={t.features?.found ? 'FreqBlog' : null}>{t.features ? (t.features.found ? [t.features.bpm ? `${Math.round(t.features.bpm)} bpm` : null, t.features.key, t.features.camelot, t.features.energy != null ? `energy ${t.features.energy.toFixed(2)}` : null, t.features.loudness != null ? `${t.features.loudness.toFixed(1)} dB` : null].filter(Boolean).join(' · ') : <span className="text-xs text-dust">not in FreqBlog’s catalogue</span>) : null}</Row>
      <Row label="Lyrics" source={t.lyrics?.found ? 'LRCLIB (derived)' : null}>{t.lyrics ? (t.lyrics.found ? [t.lyrics.lang, t.lyrics.themes.join(', ') || null, t.lyrics.valence != null ? `valence ${t.lyrics.valence >= 0 ? '+' : ''}${t.lyrics.valence.toFixed(2)}` : null, t.lyrics.llmMood].filter(Boolean).join(' · ') : <span className="text-xs text-dust">no lyrics found</span>) : null}</Row>
      <Row label="Spotify">{t.spotifyId ? <a href={`https://open.spotify.com/track/${t.spotifyId}`} target="_blank" rel="noreferrer" className="num text-xs underline hover:text-amber">{t.spotifyId}</a> : null}</Row>
      {editing && (
        <div className="mt-4 space-y-3 rounded-xl border border-line bg-ink/30 p-4">
          <FieldEdit label="ISRC" initial={t.isrc.owner ? t.isrc.value ?? '' : ''} placeholder={t.isrc.value ?? 'USUM71900001'} busy={busy} hint="Changing it discards the audio features and credits looked up through the old one; they're fetched again." onSave={(v) => save(() => metaSet('track', trackId, 'isrc', v), 'ISRC saved.')} onClear={t.isrc.owner ? () => save(() => metaSet('track', trackId, 'isrc', null), 'ISRC reset.') : undefined} />
          <FieldEdit label="Original release date" initial={t.releaseDate.owner ? t.releaseDate.value ?? '' : ''} placeholder={t.releaseDate.value ?? '1972'} busy={busy} onSave={(v) => save(() => metaSet('track', trackId, 'release_date', v), 'Release date saved.')} onClear={t.releaseDate.owner ? () => save(() => metaSet('track', trackId, 'release_date', null), 'Release date reset.') : undefined} />
        </div>
      )}
    </Card>
  );
}
