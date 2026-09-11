import { useState } from 'react';
import { Link } from 'react-router-dom';
import { yearInReview } from '@/lib/insightQueries';
import { useAsync, useFilter } from '@/lib/hooks';
import { SHAPE_LABELS, albumHref, artistHref, fmtDate, fmtHours, fmtInt, fmtMinutes, fmtPct, trackHref } from '@/lib/format';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { RankedBars, TrackList } from '@/components/Lists';
import { ClockFace } from '@/components/charts/ClockFace';
import { SessionShapes } from '@/components/charts/SessionShapes';
import { Histogram } from '@/components/charts/Bars';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { yearReviewHtml } from '@/lib/exportHtml';
import { inTauri, invoke } from '@/lib/bridge';

export function YearInReviewPage() {
  const { filter } = useFilter();
  const [year, setYear] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { data: y, error, loading } = useAsync(() => yearInReview(year), [year, filter]);
  if (error) return <ErrorBox message={error} />;
  if (!y) return <Loading />;
  return (
    <div className="mx-auto max-w-5xl">
      {/* record sleeve */}
      <section className="groove-bg relative -mx-8 -mt-6 border-b border-line px-8 pb-10 pt-8">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button onClick={() => setYear(null)} className={`rounded-full px-3 py-1.5 ${year === null ? 'bg-amber text-ink' : 'border border-line text-dust hover:text-cream'}`}>Last 12 months</button>
          {y.yearsAvailable.map((yy) => <button key={yy} onClick={() => setYear(yy)} className={`num rounded-full px-3 py-1.5 ${year === yy ? 'bg-amber text-ink' : 'border border-line text-dust hover:text-cream'}`}>{yy}</button>)}
        </div>
        <div className="mt-8 grid items-center gap-8 md:grid-cols-[1.2fr_1fr]">
          <div>
            <p className="text-sm text-dust">Year in Review · {y.label}{loading ? ' · updating…' : ''}</p>
            <h1 className="num mt-2 font-display text-6xl leading-[1.02] tracking-tight">{fmtInt(y.hours)} hours</h1>
            <p className="num mt-4 max-w-md text-dust">{fmtInt(y.plays)} plays across {fmtInt(y.days)} days · {fmtInt(y.artists)} artists, {fmtInt(y.newArtists)} of them new to you · {fmtInt(y.tracks)} tracks · skipped {fmtPct(y.skipRate)}</p>
            {y.loudestDay && <p className="mt-4 text-sm text-dust">Loudest day: <Link to={`/day/${y.loudestDay.day}`} className="text-cream hover:text-amber">{fmtDate(y.loudestDay.day)}</Link> · {fmtMinutes(y.loudestDay.minutes)}, {fmtInt(y.loudestDay.plays)} plays.{y.longestSession ? <> Longest session: <Link to={`/day/${y.longestSession.day}`} className="text-cream hover:text-amber">{fmtDate(y.longestSession.day)}</Link>, {fmtHours(y.longestSession.hours)}, a {SHAPE_LABELS[y.longestSession.shape]?.label.toLowerCase()}.</> : null}</p>}
          </div>
          <div className="justify-self-center"><ClockFace data={y.clock} size={300} /></div>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <MakePlaylistButton name={`Deep Cuts · ${y.label}`} tracks={y.topTracks} kind="insight" description={`${fmtInt(y.hours)} hours, ${fmtInt(y.plays)} plays. Made with Deep Cuts.`} note={`year_in_review:${y.label}`} />
          <button onClick={async () => {
            const html = yearReviewHtml(y);
            if (!inTauri) { const blob = new Blob([html], { type: 'text/html' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `deep-cuts-${y.label.replace(/\s+/g, '-').toLowerCase()}.html`; a.click(); return; }
            const { save } = await import('@tauri-apps/plugin-dialog');
            const path = await save({ defaultPath: `deep-cuts-${y.label.replace(/\s+/g, '-').toLowerCase()}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] });
            if (path) { await invoke('save_text_file', { path, contents: html }); setNote(`Saved ${path}. It opens offline in any browser.`); }
          }} className="rounded-full border border-line px-4 py-2 text-sm text-dust transition hover:border-dust hover:text-cream">Export as HTML</button>
          {note && <span className="text-xs text-moss">{note}</span>}
        </div>
      </section>

      <section className="mt-8 grid gap-6 md:grid-cols-3">
        <Card title="Top artists"><RankedBars data={y.topArtists} /></Card>
        <Card title="Top tracks"><TrackList data={y.topTracks} /></Card>
        <Card title="Top albums">
          <ul className="space-y-2 text-sm">{y.topAlbums.map((a, i) => <li key={a.albumId} className="flex justify-between gap-2"><span className="truncate"><span className="num mr-2 text-xs text-dust">{i + 1}</span><Link to={albumHref(a.albumId)} className="hover:text-amber">{a.album}</Link><span className="ml-2 text-xs text-dust">{a.artist}</span></span><span className="num shrink-0 text-xs text-dust">{fmtHours(a.hours)}</span></li>)}</ul>
        </Card>
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-[1.3fr_1fr]">
        <Card title="Month by month"><Histogram data={y.months.map((m) => ({ label: m.month, value: m.hours }))} /></Card>
        <Card title="How you listened"><SessionShapes data={y.shapes} /></Card>
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-3">
        <Card title="Discoveries you kept" subtitle="New artists still played 90+ days later.">
          {y.keptDiscoveries.length ? <ul className="space-y-1 text-sm">{y.keptDiscoveries.map((d) => <li key={d.artistId} className="flex justify-between"><Link to={artistHref(d.artistId)} className="truncate hover:text-amber">{d.artist}</Link><span className="num text-xs text-dust">{d.plays} plays</span></li>)}</ul> : <p className="text-sm text-dust">—</p>}
        </Card>
        <Card title="Discoveries you dropped" subtitle="Burned bright, gone within 90 days.">
          {y.droppedDiscoveries.length ? <ul className="space-y-1 text-sm">{y.droppedDiscoveries.map((d) => <li key={d.artistId} className="flex justify-between"><Link to={artistHref(d.artistId)} className="truncate hover:text-amber">{d.artist}</Link><span className="num text-xs text-dust">{d.plays} plays</span></li>)}</ul> : <p className="text-sm text-dust">—</p>}
        </Card>
        <Card title="After midnight" subtitle={`${fmtPct(y.lateShare)} of plays fell between 11 PM and 4 AM.`}>
          {y.canon.length ? <ul className="space-y-1 text-sm">{y.canon.map((c) => <li key={c.id} className="flex justify-between gap-2"><span className="truncate"><Link to={trackHref(c.id)} className="hover:text-amber">{c.name}</Link><span className="ml-2 text-xs text-dust">{c.artist}</span></span><span className="num shrink-0 text-xs text-dust">{c.latePlays} late</span></li>)}</ul> : <p className="text-sm text-dust">Early nights this year.</p>}
        </Card>
      </section>
    </div>
  );
}
