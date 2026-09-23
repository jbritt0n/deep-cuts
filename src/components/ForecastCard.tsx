import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox } from '@/components/Card';
import { fmtInt, fmtPct } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';
import { CALL_MIN_N, CALL_MIN_P, forecast, forecastAccuracy, logForecast } from '@/lib/forecastQueries';

/** Phase 9g — Today's forecast on the dashboard. Distribution over scenes and day-parts; a named call only above 85 % / 8 exposures. Logs itself once per day. */
export function ForecastCard() {
  const { filter } = useFilter();
  const f = useAsync(forecast, [filter]);
  const [logged, setLogged] = useState(false);
  useEffect(() => { if (f.data && !f.data.logged && !filter.fromYear && !filter.toYear) void logForecast(f.data).then((w) => setLogged(w)); }, [f.data, filter]);
  if (f.error) return <Card title="Today's forecast"><ErrorBox message={f.error} /></Card>;
  if (!f.data) return <Card title="Today's forecast"><p className="text-sm text-dust">Reading the last six months of {new Date().toLocaleDateString('en-US', { weekday: 'long' })}s…</p></Card>;
  const d = f.data;
  const top = d.scenes.slice(0, 5);
  const slot = [...d.slots].sort((a, b) => b.p - a.p)[0];
  return (
    <Card title="Today's forecast" subtitle={`Built from your last ${d.sameDays} ${d.weekdayName}s (${d.activeDays} with listening). A spread, not a guess at one song.`} aside={<Link to="/moods#forecast" className="text-xs text-dust hover:text-amber">full forecast →</Link>}>
      {d.thin ? <p className="text-sm text-dust">Too few {d.weekdayName}s with listening in the window to say much — {d.activeDays} of {d.sameDays}. The forecast firms up as the record grows.</p> : (
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
          <div>
            <p className="num font-display text-3xl">{fmtPct(d.pAny)} <span className="text-base text-dust">chance you listen at all</span></p>
            {slot && slot.p > 0 && <p className="mt-1 text-sm text-dust">Most likely {slot.slot} ({fmtPct(slot.p)}, about {fmtInt(slot.minutes)} min on a typical {d.weekdayName}).</p>}
            <ul className="mt-3 space-y-1.5 text-sm">
              {top.map((s) => <li key={s.scene} className="flex items-center gap-3"><span className="w-36 shrink-0 truncate">{s.label}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/80" style={{ width: `${Math.round(s.p * 100)}%` }} /></div><span className="num w-10 text-right text-xs text-dust">{fmtPct(s.p)}</span></li>)}
              {top.length === 0 && <li className="text-xs text-dust">No scenes filed yet — Settings → Tuning → Scenes.</li>}
            </ul>
          </div>
          <div className="rounded-xl border border-line bg-ink/40 p-3 text-sm">
            {d.calls.length ? (
              <>
                <p className="text-xs uppercase tracking-wide text-dust">High confidence</p>
                <ul className="mt-1 space-y-1">{d.calls.map((c) => <li key={c.kind + c.key}>{c.kind === 'artist' ? <Link to={`/artist/${encodeURIComponent(c.key)}`} className="hover:text-amber">{c.label}</Link> : c.label} — played on {c.hits} of your last {c.n} {d.weekdayName}s: <span className="num text-amber">{fmtPct(c.p)}</span> today.</li>)}</ul>
              </>
            ) : <p className="text-xs text-dust">No high-confidence call today. That mode only names an artist or scene above {fmtPct(CALL_MIN_P)} over at least {CALL_MIN_N} {d.weekdayName}s — most days it stays quiet on purpose.</p>}
            <p className="mt-3 text-[11px] text-dust/70">{d.logged || logged ? 'Logged for today — scored against what you actually play, on Insights.' : filter.fromYear || filter.toYear ? 'Not logged while a year filter is on.' : 'Logging…'}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Phase 9g — Insights: how well does the forecast know you? Brier score per month, skill vs base rate, call hit rate. */
export function ForecastAccuracyCard() {
  const { filter } = useFilter();
  const a = useAsync(forecastAccuracy, [filter]);
  if (a.error) return <Card title="How predictable are you?"><ErrorBox message={a.error} /></Card>;
  if (!a.data) return <Card title="How predictable are you?"><p className="text-sm text-dust">Scoring past forecasts…</p></Card>;
  const d = a.data;
  return (
    <Card title="How predictable are you?" subtitle={`${fmtInt(d.total)} logged forecasts scored against what actually played. Brier 0 = perfect, 0.25 = coin flip; skill > 0 beats "same as always".`}>
      <div id="forecast" />
      <p className="text-sm">{d.verdict}</p>
      {d.brier != null && <p className="num mt-1 text-xs text-dust">Brier {d.brier.toFixed(3)}{d.skill != null ? ` · skill ${(d.skill * 100).toFixed(0)} %` : ''}{d.callHitRate != null ? ` · high-confidence calls right ${fmtPct(d.callHitRate)}` : ''}</p>}
      {d.months.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {d.months.map((m) => <li key={m.month} className="flex items-center gap-3"><span className="num w-16 text-dust">{m.month}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised" title={`Brier ${m.brier.toFixed(3)}`}><div className="h-full rounded-full bg-moss/80" style={{ width: `${Math.round(Math.max(0, 1 - m.brier / 0.25) * 100)}%` }} /></div><span className="num w-28 text-right text-xs text-dust">{m.forecasts} days{m.calls ? ` · ${m.callHits}/${m.calls} calls` : ''}</span></li>)}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-dust/70">A falling line is information too: it means your habits are moving. Forecasts are logged only when no year filter is set, so the scoring is always against your whole record.</p>
    </Card>
  );
}
