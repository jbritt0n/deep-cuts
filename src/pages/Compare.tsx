import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { periodCustom, periodForMonth, periodForYear, periodLastDays, periodReview, type Period } from '@/lib/insightQueries';
import { useAsync, useFilter } from '@/lib/hooks';
import { SHAPE_LABELS, artistHref, fmtHours, fmtInt, fmtPct, trackHref } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { ClockFace } from '@/components/charts/ClockFace';

type Pick = { kind: 'year' | 'month' | 'last' | 'custom'; year?: number; month?: string; days?: number; from?: string; to?: string };
const toPeriod = (p: Pick): Period => p.kind === 'year' ? periodForYear(p.year!) : p.kind === 'month' ? periodForMonth(p.month!) : p.kind === 'custom' ? periodCustom(p.from!, p.to!) : periodLastDays(p.days ?? 30);

export function ComparePage() {
  const { filter, years } = useFilter();
  const y0 = years.at(-1) ?? new Date().getFullYear();
  const [a, setA] = useState<Pick>({ kind: 'year', year: y0 - 1 });
  const [b, setB] = useState<Pick>({ kind: 'year', year: y0 });
  const pa = useMemo(() => toPeriod(a), [a]), pb = useMemo(() => toPeriod(b), [b]);
  const ra = useAsync(() => periodReview(pa, 10), [pa, filter]);
  const rb = useAsync(() => periodReview(pb, 10), [pb, filter]);
  if (ra.error || rb.error) return <ErrorBox message={ra.error ?? rb.error ?? ''} />;
  if (!ra.data || !rb.data) return <Loading />;
  const A = ra.data, B = rb.data;
  const delta = (x: number, y: number, fmt: (v: number) => string) => { const d = y - x; return <span className={d > 0 ? 'text-moss' : d < 0 ? 'text-coral' : 'text-dust'}>{d > 0 ? '+' : ''}{fmt(d)}</span>; };
  const setArt = new Set(A.topArtists.map((x) => x.artistId)); const setBrt = new Set(B.topArtists.map((x) => x.artistId));
  const both = A.topArtists.filter((x) => setBrt.has(x.artistId)); const onlyA = A.topArtists.filter((x) => !setBrt.has(x.artistId)); const onlyB = B.topArtists.filter((x) => !setArt.has(x.artistId));
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Compare" title={<>{A.label} <span className="text-dust">vs</span> {B.label}</>} meta="Two periods side by side. Pick anything: years, months, the last 30 days, a custom range." />
      <div className="grid gap-6 md:grid-cols-2">
        <Picker pick={a} onChange={setA} years={years} months={A.monthsAvailable} />
        <Picker pick={b} onChange={setB} years={years} months={B.monthsAvailable} />
      </div>
      <section className="mt-6 grid gap-6 md:grid-cols-2">
        {[A, B].map((r, i) => (
          <Card key={i} title={r.label}>
            <div className="flex items-start gap-6">
              <div className="min-w-0 flex-1">
                <p className="num font-display text-4xl">{fmtInt(r.hours)} h</p>
                <ul className="num mt-2 space-y-1 text-sm text-dust">
                  <li>{fmtInt(r.plays)} plays on {fmtInt(r.days)} days</li>
                  <li>{fmtInt(r.artists)} artists · {fmtInt(r.newArtists)} new</li>
                  <li>skipped {fmtPct(r.skipRate)} · late {fmtPct(r.lateShare)}</li>
                  <li>{r.shapes[0] ? `mostly ${SHAPE_LABELS[r.shapes[0].shape]?.label.toLowerCase()}` : ''}</li>
                </ul>
              </div>
              <div className="w-40 shrink-0"><ClockFace data={r.clock} size={160} /></div>
            </div>
          </Card>
        ))}
      </section>
      <div className="mt-6 grid gap-6 md:grid-cols-3">
        <Card title="What changed">
          <ul className="num space-y-2 text-sm">
            <li className="flex justify-between"><span className="text-dust">Hours</span>{delta(A.hours, B.hours, (v) => fmtHours(Math.abs(v)).replace(' h', ' h'))}</li>
            <li className="flex justify-between"><span className="text-dust">Plays per day</span>{delta(A.plays / Math.max(A.days, 1), B.plays / Math.max(B.days, 1), (v) => Math.abs(v).toFixed(1))}</li>
            <li className="flex justify-between"><span className="text-dust">Artists</span>{delta(A.artists, B.artists, (v) => fmtInt(Math.abs(v)))}</li>
            <li className="flex justify-between"><span className="text-dust">New artists</span>{delta(A.newArtists, B.newArtists, (v) => fmtInt(Math.abs(v)))}</li>
            <li className="flex justify-between"><span className="text-dust">Skip rate</span>{delta(A.skipRate, B.skipRate, (v) => fmtPct(Math.abs(v)))}</li>
            <li className="flex justify-between"><span className="text-dust">Late-night share</span>{delta(A.lateShare, B.lateShare, (v) => fmtPct(Math.abs(v)))}</li>
          </ul>
        </Card>
        <Card title="Top-10 overlap" subtitle={`${both.length} artists in both top tens.`}>
          <ul className="space-y-1 text-sm">{both.map((x) => <li key={x.artistId}><Link to={artistHref(x.artistId)} className="hover:text-amber">{x.artist}</Link></li>)}</ul>
        </Card>
        <Card title="Swapped out / in">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="mb-1 text-xs text-coral">Only in {A.label}</p><ul className="space-y-1">{onlyA.map((x) => <li key={x.artistId} className="truncate"><Link to={artistHref(x.artistId)} className="hover:text-amber">{x.artist}</Link></li>)}</ul></div>
            <div><p className="mb-1 text-xs text-moss">Only in {B.label}</p><ul className="space-y-1">{onlyB.map((x) => <li key={x.artistId} className="truncate"><Link to={artistHref(x.artistId)} className="hover:text-amber">{x.artist}</Link></li>)}</ul></div>
          </div>
        </Card>
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {[A, B].map((r, i) => <Card key={i} title={`Top tracks · ${r.label}`}><ol className="space-y-1 text-sm">{r.topTracks.map((t, j) => <li key={t.trackId} className="flex gap-2 truncate"><span className="num w-5 text-xs text-dust">{j + 1}</span><Link to={trackHref(t.trackId)} className="truncate hover:text-amber">{t.track}</Link><span className="truncate text-xs text-dust">{t.artist}</span></li>)}</ol></Card>)}
      </div>
    </div>
  );
}

function Picker({ pick, onChange, years, months }: { pick: Pick; onChange: (p: Pick) => void; years: number[]; months: string[] }) {
  const cls = (on: boolean) => `num rounded-full px-3 py-1 text-xs ${on ? 'bg-amber text-ink' : 'border border-line text-dust hover:text-cream'}`;
  const [from, setFrom] = useState(pick.from ?? ''); const [to, setTo] = useState(pick.to ?? '');
  const yr = pick.kind === 'year' ? pick.year : pick.kind === 'month' ? Number(pick.month!.slice(0, 4)) : null;
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => onChange({ kind: 'last', days: 30 })} className={cls(pick.kind === 'last')}>Last 30 days</button>
        {years.map((y) => <button key={y} onClick={() => onChange({ kind: 'year', year: y })} className={cls(yr === y && pick.kind === 'year')}>{y}</button>)}
      </div>
      {yr && <div className="mt-2 flex flex-wrap gap-1">{months.filter((m) => m.startsWith(String(yr))).sort().map((m) => <button key={m} onClick={() => onChange({ kind: 'month', month: m })} className={cls(pick.kind === 'month' && pick.month === m)}>{new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'short' })}</button>)}</div>}
      <div className="mt-2 flex items-center gap-2 text-xs">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="num rounded-lg border border-line bg-ink px-2 py-1" aria-label="From" />
        <span className="text-dust">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="num rounded-lg border border-line bg-ink px-2 py-1" aria-label="To" />
        <button disabled={!from || !to || from > to} onClick={() => onChange({ kind: 'custom', from, to })} className={cls(pick.kind === 'custom') + ' disabled:opacity-40'}>Custom</button>
      </div>
    </div>
  );
}
