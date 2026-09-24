import { Link, useParams } from 'react-router-dom';
import { getArtistDetail } from '@/lib/queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { fmtDate, fmtHours, fmtInt, fmtPct } from '@/lib/format';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { Card, Empty, ErrorBox, Loading, Sleeve, StatCard } from '@/components/Card';
import { AlbumList, TrackList } from '@/components/Lists';
import { ClockFace } from '@/components/charts/ClockFace';
import { MonthlySparkline } from '@/components/charts/MonthlySparkline';
import { digDeeper } from '@/lib/digQueries';
import { TrajectoryCard } from '@/components/DailyDig';
import { ArtistAbout, ArtistMetadata } from '@/components/MetadataPanel';
import { ArtistSoundCard } from '@/components/SoundTools';
import { QueueButton, useQueue } from '@/components/QueueButton';
import { trackHref, albumHref } from '@/lib/format';
import { useState } from 'react';

export function ArtistPage() {
  const { id = '' } = useParams();
  const { filter } = useFilter();
  const { data: a, error, loading } = useAsync(() => getArtistDetail(decodeURIComponent(id)), [id, filter]);
  const dig = useAsync(() => digDeeper(decodeURIComponent(id)), [id, filter]);
  if (error) return <ErrorBox message={error} />;
  if (loading && !a) return <Loading />;
  if (!a) return <Empty>No plays for this artist under the current lens. Try “Everything” or widen the years.</Empty>;
  const loyal = a.albumLoyalty && a.albumLoyalty.share >= 0.6;
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker={<>Artist{a.rank ? <> · #{a.rank} by hours</> : null}{a.aliases.length ? <> · also filed as {a.aliases.join(', ')}</> : null}</>}
        title={a.artist}
        meta={<>{fmtInt(a.plays)} plays · {fmtHours(a.hours)} · {fmtInt(a.uniqueTracks)} tracks · first played {fmtDate(a.firstPlayed)} · last {fmtDate(a.lastPlayed)}</>}>
        {loyal && <p className="mt-4 max-w-xl text-sm text-dust">You're a <span className="text-cream">{a.albumLoyalty!.album}</span> person more than an {a.artist} person: {fmtPct(a.albumLoyalty!.share)} of your hours with them come from that one album.</p>}
      </Sleeve>
      <div className="mb-6"><ArtistAbout artistId={a.artistId} artist={a.artist} /></div>

      <section className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
        <StatCard label="Hours" value={fmtHours(a.hours)} accent />
        <StatCard label="Skip rate" value={fmtPct(a.skipRate)} footnote={a.skipRate < 0.05 ? 'you rarely bail' : a.skipRate > 0.3 ? 'you bail a lot' : undefined} />
        <StatCard label="Late-night share" value={fmtPct(a.lateNightShare)} footnote="plays between 11 PM and 4 AM" />
        <StatCard label="Tracks heard" value={fmtInt(a.uniqueTracks)} />
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <Card title="Two years, month by month"><MonthlySparkline data={a.monthly} /></Card>
        <Card title="When in the day" subtitle="Hours by hour of day."><div className="mx-auto max-w-[300px]"><ClockFace data={a.clock} size={300} /></div></Card>
      </section>
      <div className="mt-6 grid gap-6 lg:grid-cols-2"><TrajectoryCard artistId={a.artistId} artist={a.artist} /><ArtistMetadata artistId={a.artistId} /></div>
      <div className="mt-6 max-w-2xl"><ArtistSoundCard artistId={a.artistId} artist={a.artist} /></div>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Most played" subtitle="Top tracks by plays." aside={<MakePlaylistButton small name={`${a.artist} · Deep Cuts`} tracks={a.topTracks} note={`artist:${a.artistId}`} />}><TrackList data={a.topTracks} showArtist={false} /></Card>
        <div className="space-y-6">
          <Card title="Albums" subtitle="By hours."><AlbumList data={a.albums} /></Card>
          <Card title="Biggest days">
            <ul className="divide-y divide-line/60 text-sm">
              {a.topDays.map((d) => <li key={d.day} className="flex justify-between py-2"><Link to={`/day/${d.day}`} className="hover:text-amber">{fmtDate(d.day)}</Link><span className="num text-xs text-dust">{fmtInt(d.minutes)} min · {d.plays} plays</span></li>)}
            </ul>
          </Card>
        </div>
      </section>
      <section className="mt-6"><DigDeeperCard artist={a.artist} d={dig.data} /></section>
    </div>
  );
}

/** Phase 9d — Dig Deeper: catalogue penetration plus the unplayed tracks the record already knows about, with a queue action on each. */
function DigDeeperCard({ artist, d }: { artist: string; d: Awaited<ReturnType<typeof digDeeper>> | null }) {
  const { queueMany, connected } = useQueue();
  const [busy, setBusy] = useState(false);
  if (!d) return <Card title="Dig deeper"><p className="text-sm text-dust">Reading the catalogue…</p></Card>;
  const pct = d.penetration == null ? null : Math.round(d.penetration * 100);
  return (
    <Card title="Dig deeper" subtitle={d.catalogueTracks ? `You've played ${fmtInt(d.played)} of roughly ${fmtInt(d.catalogueTracks)} recordings MusicBrainz lists for ${artist} — the count includes live takes and remixes, so treat it as a ceiling.` : `You've played ${fmtInt(d.played)} distinct songs by ${artist}. The catalogue size arrives once MusicBrainz has resolved this artist (Services → MusicBrainz).`}
      aside={pct != null ? <span className="num font-display text-3xl text-amber">{pct}%</span> : undefined}>
      {pct != null && <div className="mb-4 h-2 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/80" style={{ width: `${pct}%` }} /></div>}
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-baseline justify-between"><p className="text-xs text-dust">Never played — {d.unplayed.length} songs the record already knows about</p>{d.unplayed.length > 0 && <button disabled={!connected || busy} onClick={async () => { setBusy(true); await queueMany(d.unplayed.map((t) => t.trackId), `${artist} — unplayed`); setBusy(false); }} className="text-xs text-amber hover:underline disabled:opacity-40">{busy ? 'queueing…' : 'queue them all'}</button>}</div>
          {d.unplayed.length ? <ul className="max-h-80 divide-y divide-line/60 overflow-y-auto text-sm">{d.unplayed.map((t) => <li key={t.trackId} className="flex items-center gap-3 py-1.5"><div className="min-w-0 flex-1"><Link to={trackHref(t.trackId)} className="block truncate hover:text-amber">{t.track}</Link><p className="truncate text-xs text-dust">{t.albumId ? <Link to={albumHref(t.albumId)} className="hover:text-amber">{t.album}</Link> : t.album} · {t.source}{t.hint ? ` · ${t.hint}` : ''}</p></div><QueueButton trackId={t.trackId} always /></li>)}</ul> : <p className="text-sm text-dust">Nothing unplayed in your liked songs, playlists or enriched albums by {artist}.</p>}
        </div>
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs text-dust">Barely played — once or twice, then never again</p>
            {d.barelyPlayed.length ? <ul className="divide-y divide-line/60 text-sm">{d.barelyPlayed.slice(0, 10).map((t) => <li key={t.trackId} className="flex items-center gap-3 py-1.5"><Link to={trackHref(t.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{t.track}<span className="ml-2 text-xs text-dust">{t.album}</span></Link><span className="num text-xs text-dust">{t.plays}×</span><QueueButton trackId={t.trackId} always /></li>)}</ul> : <p className="text-sm text-dust">Everything you've played by {artist}, you've played more than twice.</p>}
          </div>
          <div>
            <p className="mb-2 text-xs text-dust">Appears as a feature{d.featuredOn ? ` on ${d.featuredOn} track${d.featuredOn === 1 ? '' : 's'}` : ''}</p>
            {d.features.length ? <ul className="divide-y divide-line/60 text-sm">{d.features.map((t) => <li key={t.trackId} className="flex items-center gap-3 py-1.5"><Link to={trackHref(t.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{t.track}<span className="ml-2 text-xs text-dust">{t.primary}</span></Link><span className="num text-xs text-dust">{t.plays}×</span><QueueButton trackId={t.trackId} /></li>)}</ul> : <p className="text-sm text-dust">No feature credits known yet — they arrive with MusicBrainz credit enrichment.</p>}
          </div>
        </div>
      </div>
    </Card>
  );
}
