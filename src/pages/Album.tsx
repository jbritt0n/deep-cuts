import { Link, useParams } from 'react-router-dom';
import { AlbumMetadata } from '@/components/MetadataPanel';
import { getAlbumDetail } from '@/lib/queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { artistHref, fmtDate, fmtHours, fmtInt, fmtPct } from '@/lib/format';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { Card, Empty, ErrorBox, Loading, Sleeve, StatCard } from '@/components/Card';
import { TrackList } from '@/components/Lists';
import { MonthlySparkline } from '@/components/charts/MonthlySparkline';

export function AlbumPage() {
  const { id = '' } = useParams();
  const { filter } = useFilter();
  const { data: a, error, loading } = useAsync(() => getAlbumDetail(decodeURIComponent(id)), [id, filter]);
  if (error) return <ErrorBox message={error} />;
  if (loading && !a) return <Loading />;
  if (!a) return <Empty>No plays for this album under the current lens.</Empty>;
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker={<>Album · {a.artistId ? <Link to={artistHref(a.artistId)} className="text-cream/80 hover:text-amber">{a.artist}</Link> : a.artist}</>}
        title={a.album}
        meta={<>{fmtInt(a.plays)} plays · {fmtHours(a.hours)} · {a.tracks.length} tracks heard · first {fmtDate(a.firstPlayed)} · last {fmtDate(a.lastPlayed)}</>}>
        {a.rideCount > 0 && <p className="mt-4 text-sm text-dust">You've ridden this album front to back <span className="num text-cream">{a.rideCount}</span> time{a.rideCount === 1 ? '' : 's'}.</p>}
      </Sleeve>
      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Hours" value={fmtHours(a.hours)} accent />
        <StatCard label="Share of this artist" value={fmtPct(a.shareOfArtist)} footnote="of your hours with them" />
        <StatCard label="Skip rate" value={fmtPct(a.skipRate)} />
      </section>
      <section className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Card title="Two years, month by month"><MonthlySparkline data={a.monthly} /></Card>
        <Card title="Tracks" subtitle="By plays — the deep cuts sit at the bottom." aside={<MakePlaylistButton small name={`${a.album} · as you play it`} tracks={a.tracks} note={`album:${a.albumId}`} />}><TrackList data={a.tracks} showArtist={false} /></Card>
      </section>
      <div className="mt-6 max-w-2xl"><AlbumMetadata albumId={a.albumId} /></div>
    </div>
  );
}
