import { C } from '@/lib/theme';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { decadeMix, halfLives, tasteDrift } from '@/lib/phase4Queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { artistHref, fmtHours, fmtPct } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { StackedYears, YearLines } from '@/components/charts/Bars';

export function DriftPage() {
  const { filter } = useFilter();
  const drift = useAsync(tasteDrift, [filter]);
  const [minHours, setMinHours] = useState(10);
  const hl = useAsync(() => halfLives(minHours, 40), [minHours, filter]);
  const dec = useAsync(decadeMix, [filter]);
  if (drift.error) return <ErrorBox message={drift.error} />;
  if (!drift.data) return <Loading />;
  const d = drift.data;
  const xs = d.positions.map((p) => p.x), ys = d.positions.map((p) => p.y);
  const sx = (x: number) => 60 + ((x - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs) || 1)) * 440;
  const sy = (y: number) => 40 + ((y - Math.min(...ys)) / (Math.max(...ys) - Math.min(...ys) || 1)) * 220;
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Taste drift" title="How far is this year from the last?" meta="Each year is a vector of artist shares. Closer points sound more alike. Lines connect consecutive years; the label is their similarity (1 = identical)." />
      <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Map of your years">
          <svg viewBox="0 0 560 300" className="w-full" role="img" aria-label="Years positioned by taste similarity">
            {d.positions.slice(1).map((p, i) => { const q = d.positions[i]; return <line key={p.year} x1={sx(q.x)} y1={sy(q.y)} x2={sx(p.x)} y2={sy(p.y)} stroke={C.line} strokeWidth={2} />; })}
            {d.positions.slice(1).map((p, i) => { const q = d.positions[i]; return <text key={`l${p.year}`} x={(sx(q.x) + sx(p.x)) / 2} y={(sy(q.y) + sy(p.y)) / 2 - 6} fontSize={9} fill={C.dust} textAnchor="middle" fontFamily="var(--font-mono)">{d.adjacent[i].similarity.toFixed(2)}</text>; })}
            {d.positions.map((p) => (
              <g key={p.year}>
                <circle cx={sx(p.x)} cy={sy(p.y)} r={6 + Math.sqrt(p.hours) / 2} fill={C.amber} fillOpacity={0.85}><title>{`${p.year} · ${fmtHours(p.hours)} · ${p.top.join(', ')}`}</title></circle>
                <text x={sx(p.x)} y={sy(p.y) + 28 + Math.sqrt(p.hours) / 2} fontSize={11} fill={C.cream} textAnchor="middle" fontFamily="var(--font-mono)">{p.year}</text>
              </g>
            ))}
          </svg>
          <ul className="num mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-dust sm:grid-cols-3">{d.positions.map((p) => <li key={p.year}><span className="text-cream">{p.year}</span> · {p.top.join(', ')}</li>)}</ul>
        </Card>
        <Card title="Year to year" subtitle="Similarity of consecutive years. Dips are the pivots.">
          <YearLines rows={d.adjacent.map((a) => ({ year: a.to }))} series={[{ key: 's', label: 'Similarity to previous year', color: C.moss, values: d.adjacent.map((a) => a.similarity), format: (v) => v.toFixed(2) }]} />
          {d.adjacent.length > 0 && (() => { const min = d.adjacent.reduce((m, a) => (a.similarity < m.similarity ? a : m)); const max = d.adjacent.reduce((m, a) => (a.similarity > m.similarity ? a : m)); return <p className="mt-3 text-sm text-dust">Biggest pivot: <span className="text-cream">{min.from} → {min.to}</span> ({min.similarity.toFixed(2)}). Steadiest: <span className="text-cream">{max.from} → {max.to}</span> ({max.similarity.toFixed(2)}).</p>; })()}
        </Card>
      </section>

      <div className="mt-6">
        <Card title="Half-life explorer" subtitle="From each artist's peak month, how long until your monthly hours fell below half — for good." aside={<label className="flex items-center gap-2 text-xs text-dust">artists with ≥ <select value={minHours} onChange={(e) => setMinHours(Number(e.target.value))} className="num rounded-full border border-line bg-transparent px-2 py-1">{[5, 10, 20, 40].map((n) => <option key={n} value={n}>{n} h</option>)}</select></label>}>
          {!hl.data ? <Loading label="Fitting curves…" /> : (
            <ul className="grid gap-3 md:grid-cols-2">
              {hl.data.map((h) => { const max = Math.max(...h.curve.map((c) => c.hours), 0.1); const pts = h.curve.slice(0, 36); return (
                <li key={h.artistId} className="flex items-center gap-4 rounded-xl border border-line bg-ink/40 p-3">
                  <svg viewBox="0 0 120 36" className="h-9 w-32 shrink-0" aria-hidden><polyline fill="none" stroke={h.status === 'current' ? C.moss : h.status === 'holding' ? C.amber : C.violet} strokeWidth={1.5} points={pts.map((c, i) => `${(i / Math.max(pts.length - 1, 1)) * 120},${34 - (c.hours / max) * 32}`).join(' ')} /></svg>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm"><Link to={artistHref(h.artistId)} className="hover:text-amber">{h.artist}</Link> <span className="text-xs text-dust">· {fmtHours(h.totalHours)}</span></p>
                    <p className="num text-xs text-dust">peak {h.peakMonth.slice(0, 7)} at {h.peakHours.toFixed(1)} h · {h.halfLifeDays === null ? 'never halved' : `half-life ${h.halfLifeDays} days`} · <span className={h.status === 'current' ? 'text-moss' : h.status === 'faded' ? 'text-violet' : 'text-amber'}>{h.status}</span></p>
                  </div>
                </li>
              ); })}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Listening age and decade mix" subtitle={dec.data && dec.data.coverage > 0 ? `Release dates known for ${fmtPct(dec.data.coverage)} of plays.` : 'Needs release dates from Spotify enrichment — connect Spotify in Services and this fills in over a day or two.'}>
          {dec.data && dec.data.coverage > 0.05 ? (
            <div className="grid gap-6 md:grid-cols-2">
              <StackedYears rows={dec.data.byYear.map((y) => ({ year: y.year, values: y.decades }))} keys={dec.data.decades} colors={Object.fromEntries(dec.data.decades.map((d, i) => [d, `hsl(${30 + i * 28} 60% ${45 + (i % 2) * 10}%)`]))} labels={Object.fromEntries(dec.data.decades.map((d) => [d, d]))} />
              <YearLines rows={dec.data.byYear} series={[{ key: 'age', label: 'Average age of what you play (years)', color: C.amber, values: dec.data.byYear.map((y) => y.avgAge ?? 0), format: (v) => `${v.toFixed(1)} y` }]} />
            </div>
          ) : <p className="text-sm text-dust">Nothing to show yet.</p>}
        </Card>
      </div>
    </div>
  );
}
