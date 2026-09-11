import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { likedAlbums, likedArtists, likedFacets, likedSongs, playlistDetail, playlistsOverview, pruneLists, type LikedFilters } from '@/lib/phase4Queries';
import { followedPlaylists, madeByDeepCuts } from '@/lib/phase7Queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { albumHref, artistHref, fmtDate, fmtHours, fmtInt, fmtPct, trackHref } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { invoke } from '@/lib/bridge';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { RankedBars, TrackList } from '@/components/Lists';
import { Histogram } from '@/components/charts/Bars';

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'songs';
  const tabs = [['songs', 'Liked songs'], ['albums', 'Liked albums'], ['artists', 'Liked artists'], ['playlists', 'My playlists'], ['followed', 'Followed'], ['made', 'Made by Deep Cuts'], ['prune', 'Prune']];
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Library" title="Liked songs and playlists, with your numbers" meta="Everything Spotify knows you saved, joined to everything you actually played. Syncs daily once Spotify is connected." />
      <div className="mb-6 flex flex-wrap gap-2 text-xs">{tabs.map(([k, l]) => <button key={k} onClick={() => setParams({ tab: k })} className={`rounded-full px-3 py-1.5 ${tab === k ? 'bg-amber text-ink' : 'border border-line text-dust hover:text-cream'}`}>{l}</button>)}</div>
      {tab === 'songs' && <LikedSongs />}{tab === 'albums' && <LikedAlbums />}{tab === 'artists' && <LikedArtists />}{tab === 'playlists' && <Playlists />}{tab === 'followed' && <Followed />}{tab === 'made' && <MadeBy />}{tab === 'prune' && <Prune />}
    </div>
  );
}

function LikedSongs() {
  const { filter } = useFilter();
  const [sort, setSort] = useState<'added' | 'plays' | 'hours' | 'skips' | 'unplayed' | 'lastPlayed' | 'momentum'>('added');
  const [f, setF] = useState<LikedFilters>({});
  const facets = useAsync(likedFacets, [filter]);
  const { data, error } = useAsync(() => likedSongs(sort, 300, f), [sort, f, filter]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  if (data.total === 0) return <Card><p className="text-sm text-dust">No liked songs synced yet. Connect Spotify in Services; the first sync pulls them all.</p></Card>;
  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <Card title={`${fmtInt(data.total)} liked songs`} aside={<div className="flex items-center gap-2 text-xs"><select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="rounded-full border border-line bg-transparent px-3 py-1 text-dust">{[['added', 'Recently liked'], ['plays', 'Most played'], ['hours', 'Most hours'], ['skips', 'Most skipped'], ['unplayed', 'Never played since liking'], ['lastPlayed', 'Longest since last play'], ['momentum', 'Momentum (last 90 days)']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><MakePlaylistButton small name="From my liked songs" tracks={data.rows.slice(0, 50)} note="liked" pool={data.rows} /></div>}>
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <select value={f.yearLiked ?? ''} onChange={(e) => setF({ ...f, yearLiked: e.target.value ? Number(e.target.value) : null })} className="rounded-full border border-line bg-transparent px-3 py-1 text-dust"><option value="">Any year liked</option>{facets.data?.years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
          <select value={f.tag ?? ''} onChange={(e) => setF({ ...f, tag: e.target.value || null })} className="rounded-full border border-line bg-transparent px-3 py-1 text-dust"><option value="">Any tag</option>{facets.data?.tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} · {t.n}</option>)}</select>
          {facets.data && facets.data.decades.length > 0 && <select value={f.decade ?? ''} onChange={(e) => setF({ ...f, decade: e.target.value ? Number(e.target.value) : null })} className="rounded-full border border-line bg-transparent px-3 py-1 text-dust"><option value="">Any decade</option>{facets.data.decades.map((d) => <option key={d} value={d}>{d}s</option>)}</select>}
          <input value={f.artistQuery ?? ''} onChange={(e) => setF({ ...f, artistQuery: e.target.value || null })} placeholder="Artist…" className="rounded-full border border-line bg-transparent px-3 py-1" />
          <label className="flex items-center gap-1 text-dust"><input type="checkbox" checked={!!f.neverInPlaylist} onChange={(e) => setF({ ...f, neverInPlaylist: e.target.checked })} /> not in any playlist</label>
          <label className="flex items-center gap-1 text-dust">min plays <input type="number" min={0} value={f.minPlays ?? ''} onChange={(e) => setF({ ...f, minPlays: e.target.value ? Number(e.target.value) : null })} className="num w-14 rounded-full border border-line bg-transparent px-2 py-0.5" /></label>
          {Object.values(f).some(Boolean) && <button onClick={() => setF({})} className="text-dust hover:text-cream">clear</button>}
        </div>
        <ul className="divide-y divide-line/60 text-sm">
          {data.rows.map((t) => (
            <li key={t.trackId} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1"><Link to={trackHref(t.trackId)} className="block truncate hover:text-amber">{t.track}</Link>{t.artistId ? <Link to={artistHref(t.artistId)} className="block truncate text-xs text-dust hover:text-amber">{t.artist}</Link> : <p className="truncate text-xs text-dust">{t.artist}</p>}</div>
              <span className="num shrink-0 text-right text-xs text-dust">liked {fmtDate(t.addedAt, { month: 'short', year: '2-digit' })}<br />{t.plays} plays · {t.playsSinceLiked} since · <span className={t.skipRate >= 0.4 ? 'text-coral' : ''}>{fmtPct(t.skipRate)} skips</span></span>
            </li>
          ))}
        </ul>
      </Card>
      <div className="space-y-6">
        <Card title="When you liked" subtitle="Songs liked per month."><Histogram data={data.timeline.slice(-24).map((m) => ({ label: m.month.slice(2), value: m.added }))} /></Card>
        <Card title="Like → play lag" subtitle="Median days between first play and the like.">{data.lagDays === null ? <p className="text-sm text-dust">—</p> : <p className="num font-display text-4xl">{data.lagDays < 1 ? 'same day' : `${Math.round(data.lagDays)} days`}</p>}</Card>
      </div>
    </div>
  );
}
function LikedAlbums() {
  const { filter } = useFilter(); const { data, error } = useAsync(() => likedAlbums(100), [filter]);
  if (error) return <ErrorBox message={error} />; if (!data) return <Loading />;
  return <Card title="Albums by liked tracks"><ul className="divide-y divide-line/60 text-sm">{data.map((a) => <li key={a.albumId} className="flex justify-between gap-3 py-2"><span className="truncate"><Link to={albumHref(a.albumId)} className="hover:text-amber">{a.album}</Link><span className="ml-2 text-xs text-dust">{a.artist}</span></span><span className="num shrink-0 text-xs text-dust">{a.liked} liked · {fmtInt(a.plays)} plays · {fmtHours(a.hours)}</span></li>)}</ul></Card>;
}
function LikedArtists() {
  const { filter } = useFilter(); const { data, error } = useAsync(() => likedArtists(100), [filter]);
  if (error) return <ErrorBox message={error} />; if (!data) return <Loading />;
  return <Card title="Artists by liked tracks"><RankedBars data={data.map((a) => ({ ...a, artist: `${a.artist} · ${a.liked} liked` }))} /></Card>;
}
function Playlists() {
  const { filter } = useFilter(); const { data, error } = useAsync(playlistsOverview, [filter]);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useAsync(() => (open ? playlistDetail(open) : Promise.resolve(null)), [open, filter]);
  if (error) return <ErrorBox message={error} />; if (!data) return <Loading />;
  if (!data.length) return <SyncNudge what="playlists" />;
  const cur = data.find((p) => p.playlistId === open);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
      <Card title="Your playlists" subtitle="Plays counted only after a song was added to the playlist.">
        <ul className="divide-y divide-line/60 text-sm">{data.map((p) => <li key={p.playlistId}><button onClick={() => setOpen(p.playlistId)} className={`w-full py-2 text-left hover:text-amber ${open === p.playlistId ? 'text-amber' : ''}`}><span className="flex justify-between gap-3"><span className="truncate">{p.name}{!p.ownerIsMe && <span className="ml-2 text-xs text-dust">followed</span>}</span><span className="num shrink-0 text-xs text-dust">{p.trackCount} tracks · {fmtInt(p.playsWithin)} plays · {fmtHours(p.hoursWithin)}</span></span></button></li>)}</ul>
      </Card>
      <Card title={cur ? cur.name : 'Pick a playlist'} subtitle={cur ? `${cur.trackCount} tracks · skip rate inside ${fmtPct(cur.skipRate)}${cur.isPublic === null ? '' : cur.isPublic ? ' · public' : ' · private'}` : undefined} aside={detail.data ? <MakePlaylistButton small label="Refresh as new playlist" name={`${cur?.name} · refreshed`} tracks={detail.data.tracks.filter((t) => t.skipRate < 0.5)} note={`playlist:${open}`} /> : undefined}>
        {!open ? <p className="text-sm text-dust">Plays within, plays before it was added, skips — per track.</p> : !detail.data ? <Loading label="Reading…" /> : (
          <ol className="divide-y divide-line/60 text-sm">{detail.data.tracks.map((t) => <li key={`${t.trackId}-${t.position}`} className="flex items-center gap-3 py-2"><span className="num w-6 text-xs text-dust">{t.position + 1}</span><div className="min-w-0 flex-1"><Link to={trackHref(t.trackId)} className="block truncate hover:text-amber">{t.track}</Link><p className="truncate text-xs text-dust">{t.artist}</p></div><span className="num shrink-0 text-right text-xs text-dust">{t.plays} in · {t.playsOutside} before<br /><span className={t.skipRate >= 0.5 ? 'text-coral' : ''}>{fmtPct(t.skipRate)} skips</span></span></li>)}</ol>
        )}
      </Card>
    </div>
  );
}
function Prune() {
  const { filter } = useFilter(); const { data, error } = useAsync(pruneLists, [filter]);
  if (error) return <ErrorBox message={error} />; if (!data) return <Loading />;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Liked but always skipped" subtitle="5+ plays since liking, skipped 60%+.">{data.likedSkipped.length ? <TrackList data={data.likedSkipped} /> : <p className="text-sm text-dust">Nothing — your likes hold up.</p>}</Card>
      <Card title="Liked, never played since" subtitle="Saved 90+ days ago, not played once after.">{data.likedNeverPlayed.length ? <ul className="divide-y divide-line/60 text-sm">{data.likedNeverPlayed.map((t) => <li key={t.trackId} className="py-1.5"><Link to={trackHref(t.trackId)} className="hover:text-amber">{t.track}</Link><span className="ml-2 text-xs text-dust">{t.artist} · liked {fmtDate(t.addedAt, { month: 'short', year: 'numeric' })}</span></li>)}</ul> : <p className="text-sm text-dust">—</p>}</Card>
      <Card title="Dead weight in your playlists" subtitle="Tracks you skip 60%+ inside playlists you own.">{data.playlistDeadweight.length ? <ul className="divide-y divide-line/60 text-sm">{data.playlistDeadweight.map((t) => <li key={`${t.trackId}${t.playlist}`} className="py-1.5"><Link to={trackHref(t.trackId)} className="hover:text-amber">{t.track}</Link><span className="ml-2 text-xs text-dust">{t.artist} · in {t.playlist} · {fmtPct(t.skipRate)}</span></li>)}</ul> : <p className="text-sm text-dust">—</p>}</Card>
    </div>
  );
}

function Followed() {
  const { filter } = useFilter(); const { data, error } = useAsync(followedPlaylists, [filter]);
  if (error) return <ErrorBox message={error} />; if (!data) return <Loading />;
  if (!data.length) return <SyncNudge what="followed playlists" />;
  return (
    <Card title="Playlists you follow" subtitle="Sorted by how long since you last played anything from them — the ones at the top are the ones you lost.">
      <ul className="divide-y divide-line/60 text-sm">
        {data.map((p) => (
          <li key={p.playlistId} className="py-3">
            <div className="flex items-baseline justify-between gap-3"><a href={`https://open.spotify.com/playlist/${p.playlistId}`} target="_blank" rel="noreferrer" className="truncate hover:text-amber">{p.name}</a><span className="num shrink-0 text-xs text-dust">{p.tracks} tracks · played {p.playedTracks} · {fmtHours(p.hours)} · {p.lastPlayed ? `last ${p.lastPlayed.slice(0, 10)}` : 'never played'}</span></div>
            {p.gems.length > 0 && <p className="mt-1 truncate text-xs text-dust">your gems here: {p.gems.map((g, i) => <span key={g.trackId}>{i > 0 ? ' · ' : ''}<Link to={trackHref(g.trackId)} className="hover:text-amber">{g.track}</Link></span>)}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
function MadeBy() {
  const { filter } = useFilter(); const { data, error } = useAsync(madeByDeepCuts, [filter]);
  if (error) return <ErrorBox message={error} />; if (!data) return <Loading />;
  return (
    <Card title="Made by Deep Cuts" subtitle="Every playlist this app created on your Spotify account, including Deep Cuts Radar.">
      {!data.length ? <p className="text-sm text-dust">Nothing yet. Any “Make playlist” or “Add to Radar” lands here.</p> : (
        <ul className="divide-y divide-line/60 text-sm">{data.map((m) => <li key={m.id} className="flex items-center gap-3 py-2"><span className="min-w-0 flex-1 truncate">{m.url ? <a href={m.url} target="_blank" rel="noreferrer" className="hover:text-amber">{m.name}</a> : m.name}</span><span className="num shrink-0 text-xs text-dust">{m.kind} · {m.tracks} tracks · {m.isPublic ? 'public' : 'private'} · {m.createdAt.slice(0, 10)}</span></li>)}</ul>
      )}
    </Card>
  );
}

function SyncNudge({ what }: { what: string }) {
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const act = useAsync(() => invoke<{ at: string; task: string; level: string; message: string; detail: string | null }[]>('get_activity', { limit: 40 }), [msg]);
  const lastErr = act.data?.find((a) => a.level === 'error' && (a.task === 'sync' || a.task === 'spotify'));
  return (
    <Card title={`No ${what} yet`}>
      <p className="text-sm text-dust">They arrive with a Spotify sync. Run one now (also pulls liked songs and recent plays):</p>
      <button disabled={busy} onClick={async () => { setBusy(true); setMsg(null); try { setMsg(await invoke<string>('sync_now', { service: 'spotify' })); } catch (e) { setMsg(String(e)); } finally { setBusy(false); } }} className="mt-3 rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">{busy ? 'Syncing…' : 'Sync Spotify now'}</button>
      {msg && <p className="mt-2 text-xs text-dust">{msg}</p>}
      {lastErr && <p className="mt-3 text-xs text-coral">Last sync error ({lastErr.at.slice(0, 16)}): {lastErr.message}{lastErr.detail ? ` — ${lastErr.detail.slice(0, 300)}` : ''}</p>}
    </Card>
  );
}
