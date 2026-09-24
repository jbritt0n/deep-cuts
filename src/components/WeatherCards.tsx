import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { artistHref, fmtInt, fmtPct } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';
import { geocode, setWeatherPlace, syncWeather, weatherPlace, type Place } from '@/lib/weather';
import { weatherSummary } from '@/lib/weatherQueries';

/** Phase 9k — Settings → Record → Weather: pick a place (Open-Meteo geocoding), then history backfills. */
export function WeatherSettingsCard() {
  const [tick, setTick] = useState(0);
  const place = useAsync(weatherPlace, [tick]);
  const sum = useAsync(weatherSummary, [tick]);
  const [q, setQ] = useState(''); const [hits, setHits] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(String(e)); } finally { setBusy(false); setTick((t) => t + 1); } };
  const sync = () => run(async () => { const n = await syncWeather((m) => setMsg(m)); setMsg(n ? `Stored ${fmtInt(n)} days of weather.` : 'Weather is up to date.'); });
  return (
    <Card title="Weather" subtitle="Your listening against the weather where you live — history for the whole record and the 7-day forecast, from Open-Meteo (free, no key). Used by Moods & Forecast.">
      {err && <div className="mb-2"><ErrorBox message={err} /></div>}{msg && <p className="mb-2 text-xs text-moss">{msg}</p>}
      <p className="text-sm">{place.data ? <>📍 {place.data.name} <span className="num text-xs text-dust">({place.data.lat.toFixed(2)}, {place.data.lon.toFixed(2)})</span></> : <span className="text-dust">No place set yet.</span>}
        {sum.data?.days ? <span className="num ml-2 text-xs text-dust">· {fmtInt(sum.data.days)} days observed{sum.data.observedFrom ? `, ${sum.data.observedFrom.slice(0, 10)} → ${sum.data.observedTo?.slice(0, 10)}` : ''}</span> : null}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) void run(async () => setHits(await geocode(q.trim()))); }} placeholder="Search a city (e.g. Detroit)" className="min-w-[12rem] flex-1 rounded-lg border border-line bg-ink px-3 py-1.5 text-sm" />
        <button disabled={busy || !q.trim()} onClick={() => run(async () => setHits(await geocode(q.trim())))} className="rounded-full border border-line px-3 py-1.5 text-xs text-dust hover:text-cream disabled:opacity-40">Search</button>
        {place.data && <button disabled={busy} onClick={sync} className="rounded-full border border-amber/60 px-3 py-1.5 text-xs text-amber hover:bg-amber/10 disabled:opacity-40">{busy ? 'Working…' : 'Sync weather now'}</button>}
        {place.data && <button disabled={busy} onClick={() => run(async () => { await setWeatherPlace(null); setMsg('Place cleared. Stored weather is kept.'); })} className="rounded-full px-2 text-xs text-dust hover:text-coral">Clear place</button>}
      </div>
      {hits && (hits.length === 0 ? <p className="mt-2 text-xs text-dust">No matches.</p> : (
        <ul className="mt-2 divide-y divide-line/50 text-sm">{hits.map((h) => (
          <li key={`${h.lat},${h.lon}`} className="flex items-center gap-2 py-1.5"><span className="min-w-0 flex-1 truncate">{h.name}<span className="text-xs text-dust">{[h.admin1, h.country].filter(Boolean).length ? ` · ${[h.admin1, h.country].filter(Boolean).join(', ')}` : ''}</span></span>
            <button disabled={busy} onClick={() => run(async () => { await setWeatherPlace(h); setHits(null); setQ(''); const n = await syncWeather((m) => setMsg(m)); setMsg(`Set to ${h.name}. Stored ${fmtInt(n)} days of weather.`); })} className="rounded-full border border-line px-2 text-xs text-dust hover:text-amber">use this</button></li>))}</ul>
      ))}
      <p className="mt-3 text-[11px] text-dust/70">Weather data by Open-Meteo.com (CC BY 4.0). Only this one place is used — days abroad keep home weather; Atlas → Listening abroad covers where you were.</p>
    </Card>
  );
}

/** Phase 9k — Moods & Forecast: how your listening changes with the weather. */
export function WeatherMoodsCard() {
  const { filter } = useFilter();
  const [synced, setSynced] = useState(0);
  // quiet background refresh when a place is set (only missing ranges are fetched)
  useEffect(() => { void weatherPlace().then((p) => (p ? syncWeather().then((n) => { if (n) setSynced((x) => x + 1); }).catch(() => {}) : null)); }, []);
  const s = useAsync(weatherSummary, [filter, synced]);
  if (s.error) return <Card title="Your weather"><ErrorBox message={s.error} /></Card>;
  if (!s.data) return <Card title="Your weather"><Loading /></Card>;
  const d = s.data;
  if (!d.moods.length) return <Card title="Your weather" subtitle="How rain, sun and snow change what you play."><p className="text-sm text-dust">Set your city in <Link to="/settings?tab=record" className="underline hover:text-cream">Settings → Record → Weather</Link>; history for your whole record fills in from Open-Meteo.</p></Card>;
  const maxM = Math.max(...d.moods.map((m) => m.minutesPerDay), 1);
  return (
    <Card title="Your weather" subtitle={`${fmtInt(d.days)} days of ${d.place ? d.place + ' ' : ''}weather against your listening. "vs usual" compares that kind of day with every day, silent days included.`}>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {d.moods.map((m) => (
          <div key={m.bucket} className="rounded-xl border border-line bg-ink/30 p-3 text-sm">
            <p className="flex items-baseline gap-2"><span className="text-2xl" aria-hidden>{m.glyph}</span><span className="font-display text-lg">{m.label}</span><span className="num ml-auto text-[11px] text-dust">{fmtInt(m.days)} days</span></p>
            <div className="mt-2 flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/80" style={{ width: `${(m.minutesPerDay / maxM) * 100}%` }} /></div><span className="num w-32 text-right text-xs">{fmtInt(m.minutesPerDay)} min/day <span className={m.vsAverage >= 0 ? 'text-moss' : 'text-coral'}>{m.vsAverage >= 0 ? '+' : ''}{Math.round(m.vsAverage * 100)}%</span></span></div>
            <p className="num mt-1 text-[11px] text-dust">{[m.skipRate != null ? `skips ${fmtPct(m.skipRate)}` : null, m.bpm ? `${Math.round(m.bpm)} bpm` : null, m.energy != null ? `energy ${m.energy.toFixed(2)}` : null, m.minor != null ? `${fmtPct(m.minor)} minor` : null].filter(Boolean).join(' · ')}</p>
            {m.scenes.length > 0 && <p className="mt-1 text-xs">leans {m.scenes.map((x) => `${x.label} ${x.lift.toFixed(1)}×`).join(', ')}</p>}
            {m.artists.length > 0 && <p className="mt-0.5 truncate text-xs text-dust">{m.artists.map((a, i) => <span key={a.artistId}>{i > 0 && ' · '}<Link to={artistHref(a.artistId)} className="hover:text-amber">{a.artist}</Link></span>)}</p>}
          </div>
        ))}
      </div>
      {d.temps.length > 2 && (
        <div className="mt-4">
          <p className="mb-1 text-xs text-dust">By temperature (daily mean)</p>
          <ul className="space-y-1 text-sm">{d.temps.map((t) => <li key={t.lo} className="flex items-center gap-2"><span className="num w-20 shrink-0 text-xs">{t.band}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-violet/80" style={{ width: `${(t.minutesPerDay / Math.max(...d.temps.map((x) => x.minutesPerDay), 1)) * 100}%` }} /></div><span className="num w-40 text-right text-[11px] text-dust">{fmtInt(t.minutesPerDay)} min/day{t.energy != null ? ` · energy ${t.energy.toFixed(2)}` : ''} · {t.days} d</span></li>)}</ul>
        </div>
      )}
      <p className="mt-3 text-[11px] text-dust/70">Weather data by Open-Meteo.com.</p>
    </Card>
  );
}
