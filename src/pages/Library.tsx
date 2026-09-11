import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { likedAlbums, likedArtists, likedSongs, playlistDetail, playlistsOverview, pruneLists } from '@/lib/phase4Queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { albumHref, artistHref, fmtDate, fmtHours, fmtInt, fmtPct, trackHref } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { RankedBars, TrackList } from '@/components/Lists';
import { Histogram } from '@/components/charts/Bars';

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'songs';
  const tabs = [['songs', 'Liked songs'], ['albums', 'Liked albums'], ['artists', 'Liked artists'], ['playlists', 'Playlists'], ['prune', 'Prune']];
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Library" title="Liked songs and playlists, with your numbers" meta="Everything Spotify knows you saved, joined to everything you actually played. Syncs daily once Spotify is connected." />
      <div className="mb-6 flex flex-wrap gap-2 text-xs">{tabs.map(([k, l]) => <button key={k} onClick={() => setParams({ tab: k })} className={`rounded-full px-3 py-1.5 ${tab === k ? 'bg-amber text-ink' : 'border border-line text-dust hover:text-cream'}`}>{l}</button>)}</div>
      {tab === 'songs' && <LikedSongs />}{tab === 'albums' && <LikedAlbums />}{tab === 'artists' && <LikedArtists />}{tab === 'playlists' && <Playlists />}{tab === 'prune' && <Prune />}
    </div>
  );
}

function LikedSongs() {
  const { filter } = useFilter();
  const [sort, setSort] = useState<'added' | 'plays' | 'hours' | 'skips' | 'unplayed'>('added');
  const { data, error } = useAsync(() => likedSongs(sort, 300), [sort, filter]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  if (data.total === 0) return <Card><p className="text-sm text-dust">No liked songs synced yet. Connect Spotify in Services; the first sync pulls them all.</p></Card>;
  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <Card title={`${fmtInt(data.total)} liked songs`} aside={<div className="flex items-center gap-2 text-xs"><select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="rounded-full border border-line bg-transparent px-3 py-1 text-dust">{[['added', 'Recently liked'], ['plays', 'Most played'], ['hours', 'Most hours'], ['skips', 'Most skipped'], ['unplayed', 'Never played since liking']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><MakePlaylistButton small name="From my liked songs" tracks={data.rows.slice(0, 50)} note="liked" pool={data.rows} /></div>}>
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
  if (!data.length) return <Card><p className="text-sm text-dust">No playlists synced yet. They arrive with the Spotify connection.</p></Card>;
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
