import { Link, useParams } from 'react-router-dom';
import { getArtistDetail } from '@/lib/queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { fmtDate, fmtHours, fmtInt, fmtPct } from '@/lib/format';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { Card, Empty, ErrorBox, Loading, Sleeve, StatCard } from '@/components/Card';
import { AlbumList, TrackList } from '@/components/Lists';
import { ClockFace } from '@/components/charts/ClockFace';
import { MonthlySparkline } from '@/components/charts/MonthlySparkline';

export function ArtistPage() {
  const { id = '' } = useParams();
  const { filter } = useFilter();
  const { data: a, error, loading } = useAsync(() => getArtistDetail(decodeURIComponent(id)), [id, filter]);
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
    </div>
  );
}
