import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { periodCustom, periodForMonth, periodForYear, periodLastDays, periodReview, type Period } from '@/lib/insightQueries';
import { useAsync, useFilter } from '@/lib/hooks';
import { SHAPE_LABELS, albumHref, artistHref, fmtDate, fmtHours, fmtInt, fmtMinutes, fmtPct, trackHref } from '@/lib/format';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { RankedBars, TrackList } from '@/components/Lists';
import { ClockFace } from '@/components/charts/ClockFace';
import { SessionShapes } from '@/components/charts/SessionShapes';
import { Histogram } from '@/components/charts/Bars';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { TopN } from '@/components/TopN';
import { ShareCardButton } from '@/components/ShareCard';
import { Collage } from '@/components/Collage';
import { yearReviewHtml } from '@/lib/exportHtml';
import { inTauri, invoke } from '@/lib/bridge';

/** One review page for any period: a year, a month, the last 30 days, or a custom range. */
export function ReviewPage() {
  const { filter } = useFilter();
  const [params, setParams] = useSearchParams();
  const [topN, setTopN] = useState(5);
  const [note, setNote] = useState<string | null>(null);
  const [customFrom, setCustomFrom] = useState(params.get('from') ?? '');
  const [customTo, setCustomTo] = useState(params.get('to') ?? '');

  const period: Period = useMemo(() => {
    const y = params.get('year'), m = params.get('month'), d = params.get('days'), f = params.get('from'), t = params.get('to');
    if (y) return periodForYear(Number(y));
    if (m) return periodForMonth(m);
    if (f && t) return periodCustom(f, t);
    return periodLastDays(d ? Number(d) : 365);
  }, [params]);
  const { data: y, error, loading } = useAsync(() => periodReview(period, topN), [period, topN, filter]);
  if (error) return <ErrorBox message={error} />;
  if (!y) return <Loading />;

  const mode = params.get('year') ? 'year' : params.get('month') ? 'month' : params.get('from') ? 'custom' : 'rolling';
  const selYear = params.get('year') ? Number(params.get('year')) : params.get('month') ? Number(params.get('month')!.slice(0, 4)) : null;
  const monthsOfYear = selYear ? y.monthsAvailable.filter((k) => k.startsWith(String(selYear))).sort() : [];
  const pill = (active: boolean) => `rounded-full px-3 py-1.5 text-xs ${active ? 'bg-amber text-ink' : 'border border-line text-dust hover:text-cream'}`;
  const trackTitle = y.spanDays <= 62 ? 'Day by day' : 'Month by month';
  const slug = y.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  return (
    <div className="mx-auto max-w-5xl">
      <section className="groove-bg relative -mx-8 -mt-6 border-b border-line px-8 pb-10 pt-8">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setParams({ days: '30' })} className={`num ${pill(mode === 'rolling' && params.get('days') === '30')}`}>Last 30 days</button>
          <button onClick={() => setParams({})} className={`num ${pill(mode === 'rolling' && !params.get('days'))}`}>Last 12 months</button>
          <span className="mx-1 text-line">|</span>
          {y.yearsAvailable.map((yy) => <button key={yy} onClick={() => setParams({ year: String(yy) })} className={`num ${pill(selYear === yy && mode === 'year')}`}>{yy}</button>)}
          <span className="mx-1 text-line">|</span>
          <details className="relative">
            <summary className={`cursor-pointer list-none ${pill(mode === 'custom')}`}>Custom range</summary>
            <div className="absolute right-0 z-20 mt-2 flex items-center gap-2 rounded-xl border border-line bg-surface p-3 text-xs shadow-glow">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="num rounded-lg border border-line bg-ink px-2 py-1" aria-label="From" />
              <span className="text-dust">to</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="num rounded-lg border border-line bg-ink px-2 py-1" aria-label="To" />
              <button disabled={!customFrom || !customTo || customFrom > customTo} onClick={() => setParams({ from: customFrom, to: customTo })} className="rounded-full bg-amber px-3 py-1 font-medium text-ink disabled:opacity-40">Go</button>
            </div>
          </details>
        </div>
        {selYear && monthsOfYear.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {monthsOfYear.map((k) => <button key={k} onClick={() => setParams({ month: k })} className={`num ${pill(params.get('month') === k)}`}>{new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'short' })}</button>)}
          </div>
        )}

        <div className="mt-8 grid items-center gap-8 md:grid-cols-[1.2fr_1fr]">
          <div>
            <p className="text-sm text-dust">{mode === 'month' ? 'Month in Review' : mode === 'year' ? 'Year in Review' : 'In Review'} · {y.label}{loading ? ' · updating…' : ''}</p>
            <h1 className="num mt-2 font-display text-6xl leading-[1.02] tracking-tight">{y.hours >= 10 ? `${fmtInt(y.hours)} hours` : fmtHours(y.hours)}</h1>
            <p className="num mt-4 max-w-md text-dust">{fmtInt(y.plays)} plays across {fmtInt(y.days)} of {fmtInt(y.spanDays)} days · {fmtInt(y.artists)} artists, {fmtInt(y.newArtists)} new to you · {fmtInt(y.tracks)} tracks · skipped {fmtPct(y.skipRate)}</p>
            {y.loudestDay && <p className="mt-4 text-sm text-dust">Loudest day: <Link to={`/day/${y.loudestDay.day}`} className="text-cream hover:text-amber">{fmtDate(y.loudestDay.day)}</Link> · {fmtMinutes(y.loudestDay.minutes)}, {fmtInt(y.loudestDay.plays)} plays.{y.longestSession ? <> Longest session: <Link to={`/day/${y.longestSession.day}`} className="text-cream hover:text-amber">{fmtDate(y.longestSession.day)}</Link>, {fmtHours(y.longestSession.hours)}, a {SHAPE_LABELS[y.longestSession.shape]?.label.toLowerCase()}.</> : null}</p>}
          </div>
          <div className="justify-self-center"><ClockFace data={y.clock} size={300} /></div>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <MakePlaylistButton name={`Deep Cuts · ${y.label}`} tracks={y.topTracks} kind="insight" description={`${fmtInt(y.hours)} hours, ${fmtInt(y.plays)} plays. Made with Deep Cuts.`} note={`review:${y.period.from}:${y.period.to}`} poolRange={[y.period.from, y.period.to]} />
          <button onClick={async () => {
            const html = yearReviewHtml(y);
            if (!inTauri) { const blob = new Blob([html], { type: 'text/html' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `deep-cuts-${slug}.html`; a.click(); return; }
            const { save } = await import('@tauri-apps/plugin-dialog');
            const path = await save({ defaultPath: `deep-cuts-${slug}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] });
            if (path) { await invoke('save_text_file', { path, contents: html }); setNote(`Saved ${path}.`); }
          }} className="rounded-full border border-line px-4 py-2 text-sm text-dust transition hover:border-dust hover:text-cream">Export as HTML</button>
          <ShareCardButton title={`${y.label} · top ${Math.min(topN, 10)} artists`} subtitle={`${fmtInt(y.hours)} hours · ${fmtInt(y.plays)} plays`} rows={y.topArtists.slice(0, 10).map((a) => ({ label: a.artist, value: fmtHours(a.hours) }))} />
          <ShareCardButton title={`${y.label} · top ${Math.min(topN, 10)} tracks`} subtitle={`${fmtInt(y.hours)} hours · ${fmtInt(y.plays)} plays`} rows={y.topTracks.slice(0, 10).map((t) => ({ label: `${t.track} — ${t.artist}`, value: `${t.plays}×` }))} />
          <div className="ml-auto flex items-center gap-2 text-xs text-dust">show top <TopN value={topN} onChange={setTopN} /></div>
          {note && <span className="w-full text-xs text-moss">{note}</span>}
        </div>
      </section>

      <section className="mt-8 grid gap-6 md:grid-cols-3">
        <Card title={`Top ${topN} artists`}><RankedBars data={y.topArtists} /></Card>
        <Card title={`Top ${topN} tracks`}><TrackList data={y.topTracks} /></Card>
        <Card title={`Top ${topN} albums`}>
          <Collage className="mb-4" size={3} items={y.topAlbums.map((a) => ({ id: a.albumId, title: a.album, subtitle: a.artist, imageUrl: a.imageUrl }))} />
          <ul className="space-y-2 text-sm">{y.topAlbums.map((a, i) => <li key={a.albumId} className="flex justify-between gap-2"><span className="truncate"><span className="num mr-2 text-xs text-dust">{i + 1}</span><Link to={albumHref(a.albumId)} className="hover:text-amber">{a.album}</Link><span className="ml-2 text-xs text-dust">{a.artist}</span></span><span className="num shrink-0 text-xs text-dust">{fmtHours(a.hours)}</span></li>)}</ul>
        </Card>
      </section>
      <section className="mt-6 grid gap-6 md:grid-cols-[1.3fr_1fr]">
        <Card title={trackTitle}><Histogram data={y.months.map((m) => ({ label: m.month, value: m.hours }))} /></Card>
        <Card title="How you listened"><SessionShapes data={y.shapes} /></Card>
      </section>
      <section className="mt-6 grid gap-6 md:grid-cols-3">
        <Card title="Discoveries you kept" subtitle="New artists still played 90+ days later.">{y.keptDiscoveries.length ? <ul className="space-y-1 text-sm">{y.keptDiscoveries.map((d) => <li key={d.artistId} className="flex justify-between"><Link to={artistHref(d.artistId)} className="truncate hover:text-amber">{d.artist}</Link><span className="num text-xs text-dust">{d.plays} plays</span></li>)}</ul> : <p className="text-sm text-dust">—</p>}</Card>
        <Card title="Discoveries you dropped" subtitle="Burned bright, gone within 90 days.">{y.droppedDiscoveries.length ? <ul className="space-y-1 text-sm">{y.droppedDiscoveries.map((d) => <li key={d.artistId} className="flex justify-between"><Link to={artistHref(d.artistId)} className="truncate hover:text-amber">{d.artist}</Link><span className="num text-xs text-dust">{d.plays} plays</span></li>)}</ul> : <p className="text-sm text-dust">Too soon to tell, or nothing new.</p>}</Card>
        <Card title="After midnight" subtitle={`${fmtPct(y.lateShare)} of plays fell between 11 PM and 4 AM.`}>{y.canon.length ? <ul className="space-y-1 text-sm">{y.canon.map((c) => <li key={c.id} className="flex justify-between gap-2"><span className="truncate"><Link to={trackHref(c.id)} className="hover:text-amber">{c.name}</Link><span className="ml-2 text-xs text-dust">{c.artist}</span></span><span className="num shrink-0 text-xs text-dust">{c.latePlays} late</span></li>)}</ul> : <p className="text-sm text-dust">Early nights.</p>}</Card>
      </section>
    </div>
  );
}
