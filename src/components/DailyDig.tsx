import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox } from '@/components/Card';
import { CoverTile } from '@/components/Collage';
import { useQueue } from '@/components/QueueButton';
import { invoke } from '@/lib/bridge';
import { albumTracks, dailyDig, obscurityTier, popularityMovers, popularityTrajectory } from '@/lib/crateQueries';
import { albumHref, artistHref, fmtInt } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';

/**
 * Phase 9f roadmap item — Daily Dig. One record from the Crate's back pockets each day, chosen from today's date
 * so it stays put until tomorrow: something you loved and dropped, something you pulled once and left, or the
 * rarest thing you barely played. Queue the whole album, or put it away for 90 days (same feedback rows as The Crate).
 */
export function DailyDigCard() {
  const { filter } = useFilter();
  const [tick, setTick] = useState(0);
  const dig = useAsync(dailyDig, [filter, tick]);
  const q = useQueue();
  const [note, setNote] = useState<string | null>(null);
  const kindLabel = { rediscover: 'Worth a rediscovery', abandoned: 'Pulled once and left', backroom: 'From the back room', nearby: 'Nearby' } as const;
  if (dig.error) return <Card title="Daily dig"><ErrorBox message={dig.error} /></Card>;
  if (!dig.data) return dig.loading ? <Card title="Daily dig"><p className="text-sm text-dust">Flipping through the back pockets…</p></Card> : <Card title="Daily dig" subtitle="Nothing to dig today — every record is either in rotation or put away. Records qualify once they've sat for a while."><Link to="/crate" className="text-sm text-amber hover:underline">Open The Crate →</Link></Card>;
  const { record: r, reason, kind, alternates } = dig.data;
  const queueAlbum = async () => {
    setNote('Queueing the album…');
    const tracks = await albumTracks(r.albumId);
    const res = await q.queueMany(tracks.map((t) => t.trackId), r.album);
    setNote(res.message);
  };
  const putAway = async () => { await invoke('rec_feedback', { subjectType: 'album', subjectKey: r.albumId, engine: 'crate', verdict: 'dismissed' }).catch(() => {}); setNote(`${r.album} put away for 90 days.`); setTick((t) => t + 1); };
  return (
    <Card title="Daily dig" subtitle={`${kindLabel[kind]} — a different record every day, from ${fmtInt(alternates + 1)} candidates.`} aside={<Link to="/crate" className="text-xs text-dust hover:text-amber">The Crate</Link>}>
      <div className="flex gap-4">
        <Link to={albumHref(r.albumId)} className="block w-28 shrink-0 overflow-hidden rounded-lg border border-line shadow-lg sm:w-36"><CoverTile id={r.albumId} title={r.album} subtitle={r.artist} imageUrl={r.imageUrl} /></Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-xl"><Link to={albumHref(r.albumId)} className="hover:text-amber">{r.album}</Link></p>
          <p className="truncate text-sm text-dust">{r.artistId ? <Link to={artistHref(r.artistId)} className="hover:text-amber">{r.artist}</Link> : r.artist}{r.section && <span className="ml-2 text-xs capitalize">· {r.section.replace(/-/g, ' ')}</span>}</p>
          <p className="mt-2 text-sm">{reason}</p>
          <p className="num mt-1 text-xs text-dust">{r.plays} plays · {r.tracksPlayed}{r.totalTracks ? ` of ${r.totalTracks}` : ''} tracks heard · first {r.firstPlayed.slice(0, 10)} · last {r.lastPlayed.slice(0, 10)}{r.obscurity != null ? ` · ${obscurityTier(r.obscurity)}` : ''}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {q.canQueue && <button onClick={queueAlbum} className="rounded-full border border-amber/60 px-3 py-1 text-amber hover:bg-amber/10">Queue the album</button>}
            <button onClick={putAway} className="rounded-full border border-line px-3 py-1 text-dust hover:text-coral">Put away 90 days</button>
            {r.topTrackId && <Link to={`/track/${encodeURIComponent(r.topTrackId)}`} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream">Your top track: {r.topTrack}</Link>}
          </div>
          {note && <p className="mt-2 text-xs text-moss">{note}</p>}
        </div>
      </div>
    </Card>
  );
}

/** Phase 9f roadmap item — the obscurity trajectory of one artist: Last.fm listener snapshots since tracking began. */
export function TrajectoryCard({ artistId, artist }: { artistId: string; artist: string }) {
  const t = useAsync(() => popularityTrajectory(artistId), [artistId]);
  if (t.error) return null;
  if (!t.data) return t.loading ? null : <Card title="Popularity trajectory" subtitle={`No Last.fm listener snapshots for ${artist} yet — they accumulate a few artists per tick once Last.fm is connected.`}><span /></Card>;
  const d = t.data;
  const pts = d.points; const w = 320, h = 60;
  const min = Math.min(...pts.map((p) => p.listeners)), max = Math.max(...pts.map((p) => p.listeners));
  const x = (i: number) => (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * (w - 8) + 4);
  const y = (v: number) => (max === min ? h / 2 : h - 4 - ((v - min) / (max - min)) * (h - 8));
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.listeners).toFixed(1)}`).join(' ');
  return (
    <Card title="Popularity trajectory" subtitle={d.change == null ? `${fmtInt(d.last ?? 0)} Last.fm listeners — ${d.word}.` : `${fmtInt(d.first ?? 0)} → ${fmtInt(d.last ?? 0)} Last.fm listeners over ${d.days} days: ${d.word} (${d.change >= 0 ? '+' : ''}${Math.round(d.change * 100)} %). Tracking started when the Last.fm connector first saw this artist; before that the record has no snapshots.`}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" role="img" aria-label={`${pts.length} listener snapshots`}>
        <path d={path} fill="none" stroke="var(--c-amber, #F2A93B)" strokeWidth="2" />
        {pts.map((p, i) => <circle key={p.at} cx={x(i)} cy={y(p.listeners)} r="2.5" fill="var(--c-cream, #EFE9F4)"><title>{p.at.slice(0, 10)} · {fmtInt(p.listeners)}</title></circle>)}
      </svg>
      <p className="num mt-1 flex justify-between text-[11px] text-dust"><span>{pts[0].at.slice(0, 10)}</span><span>{pts[pts.length - 1].at.slice(0, 10)}</span></p>
    </Card>
  );
}

/** Phase 9f — Insights card: artists in your record whose listener counts moved most since tracking began. */
export function MoversCard() {
  const { filter } = useFilter();
  const m = useAsync(() => popularityMovers(8), [filter]);
  if (m.error) return <Card title="Rising and fading"><ErrorBox message={m.error} /></Card>;
  if (!m.data) return <Card title="Rising and fading"><p className="text-sm text-dust">Reading listener snapshots…</p></Card>;
  const d = m.data;
  if (!d.rising.length && !d.fading.length) return <Card title="Rising and fading" subtitle={`Last.fm listener counts are snapshotted on every enrichment pass (${fmtInt(d.tracked)} artists tracked${d.since ? ` since ${d.since}` : ''}). Movements show once an artist has two snapshots more than a week apart.`}><span /></Card>;
  const Row = ({ a }: { a: (typeof d.rising)[number] }) => (
    <li className="flex items-baseline gap-2 text-sm">
      <Link to={artistHref(a.artistId)} className="min-w-0 flex-1 truncate hover:text-amber">{a.artist}</Link>
      <span className={`num shrink-0 text-xs ${a.change >= 0 ? 'text-moss' : 'text-coral'}`}>{a.change >= 0 ? '+' : ''}{Math.round(a.change * 100)} %</span>
      <span className="num shrink-0 text-[11px] text-dust" title={`${fmtInt(a.first)} → ${fmtInt(a.last)} listeners over ${a.days} days · you first played them ${a.firstPlayed}`}>{fmtInt(a.last)}</span>
    </li>
  );
  return (
    <Card title="Rising and fading" subtitle={`Last.fm listener counts for your artists, first snapshot vs latest (${fmtInt(d.tracked)} tracked${d.since ? ` since ${d.since}` : ''}). Hover a number for the before/after and when you first played them.`}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><p className="mb-1 text-xs text-dust">Blowing up</p><ul className="space-y-1">{d.rising.map((a) => <Row key={a.artistId} a={a} />)}{!d.rising.length && <li className="text-xs text-dust">Nobody yet.</li>}</ul></div>
        <div><p className="mb-1 text-xs text-dust">Fading</p><ul className="space-y-1">{d.fading.map((a) => <Row key={a.artistId} a={a} />)}{!d.fading.length && <li className="text-xs text-dust">Nobody yet.</li>}</ul></div>
      </div>
    </Card>
  );
}
