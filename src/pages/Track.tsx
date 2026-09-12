import { C } from '@/lib/theme';
import { Link, useParams } from 'react-router-dom';
import { getTrackDetail } from '@/lib/queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { albumHref, artistHref, fmtDate, fmtHours, fmtInt, fmtMs, fmtPct, trackHref } from '@/lib/format';
import { Card, Empty, ErrorBox, Loading, Sleeve, StatCard } from '@/components/Card';
import { PlaysTable } from '@/components/Lists';
import { ClockFace } from '@/components/charts/ClockFace';
import { MonthlySparkline } from '@/components/charts/MonthlySparkline';
import { Histogram } from '@/components/charts/Bars';
import { QueueButton } from '@/components/QueueButton';

export function TrackPage() {
  const { id = '' } = useParams();
  const { filter } = useFilter();
  const { data: t, error, loading } = useAsync(() => getTrackDetail(decodeURIComponent(id)), [id, filter]);
  if (error) return <ErrorBox message={error} />;
  if (loading && !t) return <Loading />;
  if (!t) return <Empty>No plays for this track under the current lens.</Empty>;
  const Neigh = ({ rows, label }: { rows: typeof t.before; label: string }) => (
    <div>
      <p className="text-xs text-dust">{label}</p>
      {rows.length ? <ul className="mt-1 divide-y divide-line/60 text-sm">{rows.map((r) => <li key={r.trackId} className="flex justify-between gap-3 py-1.5"><Link to={trackHref(r.trackId)} className="truncate hover:text-amber">{r.track}<span className="ml-2 text-xs text-dust">{r.artist}</span></Link><span className="num shrink-0 text-xs text-dust">{r.count}×</span></li>)}</ul> : <p className="mt-1 text-sm text-dust">—</p>}
    </div>
  );
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker={<>Track{t.rank ? <> · #{t.rank} by plays</> : null} · {t.artistId ? <Link to={artistHref(t.artistId)} className="text-cream/80 hover:text-amber">{t.artist}</Link> : t.artist}{t.album && t.albumId ? <> · <Link to={albumHref(t.albumId)} className="hover:text-amber">{t.album}</Link></> : null}</>}
        title={<span className="inline-flex items-center gap-4">{t.track}<QueueButton trackId={t.trackId} always size={18} className="p-2" /></span>}
        meta={<>{fmtInt(t.plays)} plays · {fmtHours(t.hours)} · {t.durationMs ? `${fmtMs(t.durationMs)}${t.durationEstimated ? ' (from your longest full play)' : ''}` : 'length unknown'} · first {fmtDate(t.firstPlayed)} · last {fmtDate(t.lastPlayed)}{t.aliases.length ? <> · also listed as {t.aliases.join(', ')}</> : null}</>}>
        {t.earlyExitMs !== null && <p className="mt-4 max-w-xl text-sm text-dust">You bail at the same moment every time: your skips cluster around <span className="num text-cream">{fmtMs(t.earlyExitMs)}</span>.</p>}
      </Sleeve>
      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Plays" value={fmtInt(t.plays)} accent />
        <StatCard label="Skip rate" value={fmtPct(t.skipRate)} footnote={t.skipRate >= 0.6 && t.plays >= 10 ? "one you can't quit skipping" : undefined} />
        <StatCard label="Hours" value={fmtHours(t.hours)} />
      </section>
      <section className="mt-6 grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <Card title="Two years, month by month"><MonthlySparkline data={t.monthly} /></Card>
        <Card title="When in the day"><div className="mx-auto max-w-[300px]"><ClockFace data={t.clock} size={300} /></div></Card>
      </section>
      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Neighbours" subtitle="What you play right before and right after, within a session.">
          <div className="grid gap-6 sm:grid-cols-2"><Neigh rows={t.before} label="Before it" /><Neigh rows={t.after} label="After it" /></div>
        </Card>
        <Card title="Where you skip" subtitle="Skipped plays, bucketed by how far you got.">
          {t.exitPoints.length ? <Histogram data={t.exitPoints.map((e) => ({ label: fmtMs(e.msPlayed), value: e.count }))} color={C.coral} /> : <p className="text-sm text-dust">You've never skipped this one.</p>}
        </Card>
      </section>
      <div className="mt-6"><Card title="Recent plays"><PlaysTable data={t.recentPlays} showDate /></Card></div>
    </div>
  );
}
