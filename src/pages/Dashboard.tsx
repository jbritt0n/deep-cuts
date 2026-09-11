import { Link } from 'react-router-dom';
import type { AppStatus } from '@/lib/types';
import { getDashboardStats, recentMilestones, topAlbums, topArtists, topTracks } from '@/lib/queries';
import { Collage } from '@/components/Collage';
import { unseenInsights } from '@/lib/phase7Queries';
import { invoke } from '@/lib/bridge';
import { albumHref } from '@/lib/format';
import { TopN } from '@/components/TopN';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { ShareCardButton } from '@/components/ShareCard';
import { useState } from 'react';
import { useAsync, useFilter } from '@/lib/hooks';
import { fmtInt, monthHref } from '@/lib/format';
import { Card, ErrorBox, Loading, StatCard } from '@/components/Card';
import { OnThisDay, PlaysTable, RankedBars, Records, TrackList } from '@/components/Lists';
import { ClockFace } from '@/components/charts/ClockFace';
import { CalendarHeatmap } from '@/components/charts/CalendarHeatmap';
import { MonthlySparkline } from '@/components/charts/MonthlySparkline';
import { SessionShapes } from '@/components/charts/SessionShapes';

export function Dashboard({ status }: { status: AppStatus }) {
  const { filter } = useFilter();
  const { data: s, error, loading } = useAsync(getDashboardStats, [filter]);
  const [n, setN] = useState(10);
  const ms = useAsync(recentMilestones, [filter]);
  const shelf = useAsync(() => topAlbums(12), [filter]);
  const ins = useAsync(() => unseenInsights(6), [filter]);
  const more = useAsync(async () => (n === 10 ? null : { artists: await topArtists(n), tracks: await topTracks(n) }), [n, filter]);
  if (error) return <ErrorBox message={error} />;
  if (!s || loading && !s) return <Loading />;
  const peak = s.peakDay;
  const todayLabel = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const lensNote = filter.attentiveOnly ? 'attentive listening' : 'everything recorded';

  return (
    <div className="mx-auto max-w-6xl">
      {status.demo && (
        <div className="mb-6 rounded-xl border border-amber/30 bg-amber/5 px-4 py-3 text-sm text-amber">
          <strong className="font-medium">Demo record.</strong> A generated three-year history so every page has something to show. <Link to="/welcome" className="underline hover:text-cream">Import your own export</Link> and this switches to the real thing.
        </div>
      )}

      <section className="groove-bg grid items-center gap-10 pb-10 pt-4 md:grid-cols-[1.1fr_1fr]">
        <div>
          <p className="text-sm text-dust">Side A · {lensNote}{filter.fromYear || filter.toYear ? ` · ${filter.fromYear ?? '…'}–${filter.toYear ?? '…'}` : ''}</p>
          <h1 className="num mt-3 font-display text-5xl leading-[1.05] tracking-tight md:text-6xl">{fmtInt(s.totalHours)} hours,<br />annotated.</h1>
          <p className="num mt-5 max-w-md text-dust">
            {fmtInt(s.totalPlays)} plays · {fmtInt(s.uniqueTracks)} tracks · {fmtInt(s.uniqueArtists)} artists. The dial is your day as a record: each groove an hour, its reach how much you listened.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to="/sessions" className="rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-ink transition hover:shadow-glow">How you listen</Link>
            <Link to="/insights" className="rounded-full border border-line px-5 py-2.5 text-sm text-dust transition hover:border-dust hover:text-cream">Insights</Link>
            <Link to="/review" className="rounded-full border border-line px-5 py-2.5 text-sm text-dust transition hover:border-dust hover:text-cream">In Review</Link>
          </div>
        </div>
        <div className="justify-self-center"><ClockFace data={s.clock} /></div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
        <StatCard label="Plays" value={fmtInt(s.totalPlays)} />
        <StatCard label="Hours" value={fmtInt(s.totalHours)} accent />
        <StatCard label="Artists heard" value={fmtInt(s.uniqueArtists)} />
        <StatCard label="Current streak" value={`${s.currentStreakDays}d`} footnote="consecutive days with at least one play" />
      </section>

      <div id="year" className="mt-8">
        <Card title="The past year, day by day" subtitle="Click a day to see its sessions and plays."
          aside={peak && peak.minutes > 0 ? <Link to={`/day/${peak.day}`} className="num text-xs text-dust transition hover:text-amber">loudest day · {peak.day} · {fmtInt(peak.minutes)} min</Link> : undefined}>
          <CalendarHeatmap data={s.calendar} />
        </Card>
      </div>

      <section className="mt-6 grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <Card title="Hours by month" subtitle="Last 12 months. Click a month to open it."
          aside={s.monthlyHours.at(-1) ? <Link to={monthHref(s.monthlyHours.at(-1)!.key)} className="num text-xs text-dust hover:text-amber">this month</Link> : undefined}>
          <MonthlySparkline data={s.monthlyHours} />
        </Card>
        <Card title="How you listen" subtitle="Sessions by shape." aside={<Link to="/sessions" className="text-xs text-dust hover:text-amber">all sessions</Link>}>
          <SessionShapes data={s.sessionShapes} />
        </Card>
      </section>

      {ins.data && ins.data.length > 0 && (
        <div className="mt-6"><Card title="Fresh insights" subtitle="Computed nightly. Tap one to mark it seen." aside={<Link to="/insights" className="text-xs text-dust hover:text-amber">all insights</Link>}>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{ins.data.map((i) => { const p = i.payload; const text = i.kind === 'obsession' ? `${p.artist}: ${p.plays} plays in a week (usual ${p.usual})` : i.kind === 'scene_phase' ? `A ${String(p.scene).replace('-', ' ')} week — ${p.hours} h, led by ${p.lead}` : i.kind === 'comeback' ? `${p.artist} is back after ${p.days_silent} days` : i.kind === 'earworm' ? `Earworm: ${p.track} — ${p.artist}` : i.kind; const href = i.subjectType === 'artist' ? `/artist/${encodeURIComponent(i.subjectId)}` : i.subjectType === 'track' ? `/track/${encodeURIComponent(i.subjectId)}` : '/insights'; return <li key={i.id} className={`rounded-xl border px-3 py-2 text-sm ${i.surfaced ? 'border-line/50 bg-ink/30 text-dust' : 'border-line bg-ink/40'}`}><Link to={href} onClick={() => invoke('mark_insight_surfaced', { id: i.id }).catch(() => {})} className="block truncate hover:text-amber">{text}</Link><p className="num text-xs text-dust">{i.kind.replace('_', ' ')} · {i.periodStart}</p></li>; })}</ul>
        </Card></div>
      )}
      {ms.data && ms.data.length > 0 && (
        <div className="mt-6"><Card title="Milestones" subtitle="Quiet badges from the last few weeks." aside={<Link to="/achievements" className="text-xs text-dust hover:text-amber">achievements</Link>}>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{ms.data.map((m) => <li key={m.id} className="rounded-xl border border-line bg-ink/40 px-3 py-2 text-sm"><p className="truncate">{m.subjectType === 'artist' ? <Link to={`/artist/${encodeURIComponent(m.subjectId)}`} className="hover:text-amber">{m.description}</Link> : m.subjectType === 'track' ? <Link to={`/track/${encodeURIComponent(m.subjectId)}`} className="hover:text-amber">{m.description}</Link> : m.subjectType === 'day' ? <Link to={`/day/${m.subjectId}`} className="hover:text-amber">{m.description}</Link> : m.description}</p><p className="num text-xs text-dust">{m.occurredAt.slice(0, 10)}</p></li>)}</ul>
        </Card></div>
      )}
      <section className="mt-6 grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <Card title="Records" subtitle="Personal bests, computed live from the archive."><Records data={s.records} /></Card>
        <Card title={`On this day · ${todayLabel}`} subtitle="What you were listening to in years past."><OnThisDay data={s.onThisDay} todayLabel={todayLabel} /></Card>
      </section>

      {shelf.data && shelf.data.length >= 4 && (
        <div className="mt-6"><Card title="Record shelf" subtitle="Your most-played albums. Art arrives from Spotify and the Cover Art Archive once services are connected.">
          <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
            <Collage size={3} items={shelf.data.slice(0, 9).map((a) => ({ id: a.albumId, title: a.album, subtitle: a.artist, imageUrl: a.imageUrl }))} />
            <ol className="divide-y divide-line/60 text-sm">{shelf.data.slice(0, 9).map((a, i) => <li key={a.albumId} className="flex items-baseline gap-3 py-1.5"><span className="num w-5 text-xs text-dust">{i + 1}</span><span className="min-w-0 flex-1 truncate"><Link to={albumHref(a.albumId)} className="hover:text-amber">{a.album}</Link><span className="ml-2 text-xs text-dust">{a.artist}</span></span><span className="num shrink-0 text-xs text-dust">{a.hours.toFixed(0)} h</span></li>)}</ol>
          </div>
        </Card></div>
      )}
      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title={`Heavy rotation · top ${n}`} subtitle="Artists ranked by hours, not play counts." aside={<div className="flex items-center gap-2"><ShareCardButton title={`My top ${Math.min(n, 10)} artists`} subtitle={`${fmtInt(s.totalHours)} hours of listening`} rows={(more.data?.artists ?? s.topArtists).slice(0, 10).map((a) => ({ label: a.artist, value: `${a.hours.toFixed(0)} h` }))} /><TopN value={n} onChange={setN} options={[10, 25, 50, 100]} /></div>}><RankedBars data={more.data?.artists ?? s.topArtists} /></Card>
        <Card title={`Most played tracks · top ${n}`} subtitle="By plays. Skip rate alongside." aside={<MakePlaylistButton small name="Deep Cuts · most played" tracks={more.data?.tracks ?? s.topTracks} note="dashboard:top" />}><TrackList data={more.data?.tracks ?? s.topTracks} /></Card>
      </section>

      <div className="mt-6">
        <Card title="Recent plays" subtitle={status.demo ? 'Generated in demo mode.' : 'Your latest plays. Live plays arrive here once Spotify is connected.'}
          aside={s.recentPlays[0] ? <Link to={`/day/${s.recentPlays[0].playedAt.slice(0, 10)}`} className="num text-xs text-dust transition hover:text-amber">open latest day</Link> : undefined}>
          <PlaysTable data={s.recentPlays} showDate />
        </Card>
      </div>
    </div>
  );
}
