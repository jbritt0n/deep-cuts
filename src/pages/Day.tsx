import { Link, useParams } from 'react-router-dom';
import { getDayDetail } from '@/lib/queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { fmtDate, fmtInt, fmtMinutes, monthHref } from '@/lib/format';
import { Card, Empty, ErrorBox, Loading, Sleeve, StatCard } from '@/components/Card';
import { PlaysTable, SessionCard } from '@/components/Lists';

export function DayPage() {
  const { date = '' } = useParams();
  const { filter } = useFilter();
  const { data: d, error, loading } = useAsync(() => getDayDetail(date), [date, filter]);
  if (error) return <ErrorBox message={error} />;
  if (loading && !d) return <Loading />;
  if (!d) return <Empty>Not a day I recognise.</Empty>;
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker={<>Day · <Link to={monthHref(date)} className="hover:text-amber">{fmtDate(date, { month: 'long', year: 'numeric' })}</Link></>} title={fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
        meta={<div className="flex items-center gap-4">
          <span>{fmtInt(d.plays)} plays · {fmtMinutes(d.minutes)} · {d.uniqueArtists} artists · {d.skips} skips</span>
          <span className="ml-auto flex gap-3">
            {d.prevDay && <Link to={`/day/${d.prevDay}`} className="hover:text-amber">← {d.prevDay}</Link>}
            {d.nextDay && <Link to={`/day/${d.nextDay}`} className="hover:text-amber">{d.nextDay} →</Link>}
          </span>
        </div>} />
      {d.plays === 0 ? <Empty>Nothing played this day under the current lens.</Empty> : (
        <>
          <section className="grid gap-4 sm:grid-cols-4">
            <StatCard label="Listened" value={fmtMinutes(d.minutes)} accent />
            <StatCard label="Plays" value={fmtInt(d.plays)} />
            <StatCard label="Sessions" value={String(d.sessions.length)} />
            <StatCard label="Skips" value={String(d.skips)} />
          </section>
          <div className="mt-6"><Card title="Sessions" subtitle="Click one for the full run-through.">
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{d.sessions.map((s) => <SessionCard key={s.sessionId} s={s} href={`/sessions/${s.sessionId}`} />)}</div>
          </Card></div>
          <div className="mt-6"><Card title="Every play"><PlaysTable data={d.playsList} /></Card></div>
        </>
      )}
    </div>
  );
}
