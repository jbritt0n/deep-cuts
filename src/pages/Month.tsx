import { Link, useParams } from 'react-router-dom';
import { getMonthDetail } from '@/lib/queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { fmtHours, fmtInt, monthHref, monthLabel } from '@/lib/format';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { Card, Empty, ErrorBox, Loading, Sleeve, StatCard } from '@/components/Card';
import { RankedBars, TrackList } from '@/components/Lists';
import { ClockFace } from '@/components/charts/ClockFace';
import { SessionShapes } from '@/components/charts/SessionShapes';
import { Histogram } from '@/components/charts/Bars';

export function MonthPage() {
  const { key = '' } = useParams();
  const { filter } = useFilter();
  const { data: m, error, loading } = useAsync(() => getMonthDetail(key), [key, filter]);
  if (error) return <ErrorBox message={error} />;
  if (loading && !m) return <Loading />;
  if (!m) return <Empty>Nothing played in {/^\d{4}-\d{2}$/.test(key) ? monthLabel(key) : 'that month'} under the current lens.</Empty>;
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Month" title={m.label}
        meta={<div className="flex items-center gap-4">
          <span>{fmtInt(m.plays)} plays · {fmtHours(m.hours)} · {fmtInt(m.uniqueArtists)} artists · {fmtInt(m.newTracks)} tracks you'd never played before</span>
          <span className="ml-auto flex gap-3">
            {m.prevMonth && <Link to={monthHref(m.prevMonth)} className="hover:text-amber">← {monthLabel(m.prevMonth)}</Link>}
            {m.nextMonth && <Link to={monthHref(m.nextMonth)} className="hover:text-amber">{monthLabel(m.nextMonth)} →</Link>}
          </span>
        </div>} />
      <section className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Hours" value={fmtHours(m.hours)} accent />
        <StatCard label="Plays" value={fmtInt(m.plays)} />
        <StatCard label="New tracks" value={fmtInt(m.newTracks)} footnote="first-ever plays" />
        <StatCard label="Skips" value={fmtInt(m.skips)} />
      </section>
      <section className="mt-6 grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <Card title="Day by day" subtitle="Minutes. Click a day."><Histogram data={m.days.map((d) => ({ label: d.day.slice(8), value: Math.round(d.minutes) }))} /><p className="mt-2 text-xs text-dust">{m.days.filter((d) => d.plays > 0).slice(0, 31).map((d) => <Link key={d.day} to={`/day/${d.day}`} className="mr-2 hover:text-amber">{d.day.slice(8)}</Link>)}</p></Card>
        <Card title="When in the day"><div className="mx-auto max-w-[300px]"><ClockFace data={m.clock} size={300} /></div></Card>
      </section>
      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Heavy rotation"><RankedBars data={m.topArtists} /></Card>
        <Card title="Most played" aside={<MakePlaylistButton small name={`${m.label} · Deep Cuts`} tracks={m.topTracks} note={`month:${m.key}`} />}><TrackList data={m.topTracks} /></Card>
      </section>
      <div className="mt-6"><Card title="How you listened" subtitle="Sessions by shape this month."><SessionShapes data={m.shapes} /></Card></div>
    </div>
  );
}
