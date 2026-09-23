import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { YearLines } from '@/components/charts/Bars';
import { adventurousness, energyByHour, featureCoverage, featureExtremes, featuresByYear, keyWheel, keysBySeason } from '@/lib/featureQueries';
import { fmtInt, fmtPct, trackHref } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';
import { C } from '@/lib/theme';

/**
 * Phase 9g — "Sound": what your listening sounds like, from FreqBlog audio features (tempo, key, energy, loudness).
 * Empty state points at Services. Valence/mood are deliberately absent — FreqBlog itself calls them coarse.
 */
export function SoundSection() {
  const { filter } = useFilter();
  const cov = useAsync(featureCoverage, [filter]);
  const years = useAsync(featuresByYear, [filter]);
  const hours = useAsync(energyByHour, [filter]);
  const seasons = useAsync(keysBySeason, [filter]);
  const wheel = useAsync(keyWheel, [filter]);
  const adv = useAsync(adventurousness, [filter]);
  const ext = useAsync(() => featureExtremes(3), [filter]);
  if (cov.error) return <Card title="Sound"><ErrorBox message={cov.error} /></Card>;
  if (!cov.data) return <Card title="Sound"><Loading label="Reading audio features…" /></Card>;
  if (cov.data.featured === 0) return <Card title="Sound" subtitle="Tempo, key, energy and loudness of what you play — needs the FreqBlog connector."><p className="text-sm text-dust">No audio features yet. Connect FreqBlog on <Link to="/services" className="underline hover:text-cream">Services</Link> (free key); features fill in a batch every six hours, most-played first.</p></Card>;
  const c = cov.data;
  const peakHour = hours.data?.length ? hours.data.reduce((a, b) => (b.energy > a.energy ? b : a)) : null;
  const calmHour = hours.data?.length ? hours.data.filter((h) => h.plays >= 20).reduce((a, b) => (b.energy < a.energy ? b : a), hours.data[0]) : null;
  const w = wheel.data ?? [];
  return (
    <div className="space-y-6">
      <Card title="Sound" subtitle={`Tempo, key, energy and loudness across ${fmtInt(c.featured)} of the ${fmtInt(c.played)} tracks you've played (${fmtPct(c.share)})${c.missed ? `; ${fmtInt(c.missed)} aren't in FreqBlog's catalogue` : ''}. Play-weighted under the lens.`}>
        {years.error ? <ErrorBox message={years.error} /> : !years.data ? <Loading /> : years.data.length < 2 ? <p className="text-sm text-dust">Needs two years of featured plays for the lines.</p> : (
          <div className="grid gap-6 lg:grid-cols-2">
            <div><p className="mb-1 text-xs text-dust">Tempo by year (mean BPM)</p><YearLines rows={years.data} series={[{ key: 'bpm', label: 'BPM', color: C.amber, values: years.data.map((y) => y.bpm), format: (v) => `${Math.round(v)}` }]} /></div>
            <div><p className="mb-1 text-xs text-dust">Energy and minor-key share by year</p><YearLines rows={years.data} series={[{ key: 'e', label: 'Energy', color: C.coral, values: years.data.map((y) => y.energy), format: (v) => v.toFixed(2) }, { key: 'm', label: 'Minor keys', color: C.violet, values: years.data.map((y) => y.minorShare), format: fmtPct }]} /></div>
          </div>
        )}
      </Card>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Energy through the day" subtitle="Mean energy of what you play, by hour.">
          {!hours.data ? <Loading /> : hours.data.length === 0 ? <p className="text-sm text-dust">—</p> : (
            <div>
              <svg viewBox="0 0 240 80" className="w-full" role="img" aria-label="Energy by hour of day">
                {hours.data.map((h) => <rect key={h.hour} x={h.hour * 10} y={78 - h.energy * 70} width="8" height={h.energy * 70} fill={h === peakHour ? C.coral : C.amber} opacity={0.4 + Math.min(0.6, h.plays / Math.max(1, ...hours.data!.map((x) => x.plays)))}><title>{h.hour}:00 · energy {h.energy.toFixed(2)} · {Math.round(h.bpm)} BPM · {fmtInt(h.plays)} plays</title></rect>)}
              </svg>
              <p className="num mt-1 text-xs text-dust">{peakHour && `Peak ${peakHour.hour}:00 (${peakHour.energy.toFixed(2)})`}{calmHour && calmHour !== peakHour && ` · calmest ${calmHour.hour}:00 (${calmHour.energy.toFixed(2)})`}</p>
            </div>
          )}
        </Card>
        <Card title="Keys by season" subtitle="Share of plays in a minor key, with mean tempo.">
          {!seasons.data ? <Loading /> : (
            <ul className="space-y-2 text-sm">{seasons.data.map((s) => <li key={s.season} className="flex items-center gap-3"><span className="w-16 capitalize">{s.season}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-violet/80" style={{ width: `${Math.round(s.minorShare * 100)}%` }} /></div><span className="num w-28 text-right text-xs text-dust">{fmtPct(s.minorShare)} minor · {Math.round(s.bpm)} bpm</span></li>)}</ul>
          )}
        </Card>
        <Card title="Adventurousness" subtitle="How widely you roam across tempo × key. 0 = one cell, 1 = everywhere evenly.">
          {!adv.data ? <Loading /> : (
            <div>
              <p className="num font-display text-4xl">{(adv.data.score * 100).toFixed(0)}<span className="text-base text-dust"> / 100</span></p>
              <p className="num mt-1 text-xs text-dust">{adv.data.binsUsed} of {adv.data.binsTotal} tempo × key cells visited · {adv.data.entropyBits.toFixed(1)} bits</p>
              {adv.data.byYear.length > 1 && <YearLines rows={adv.data.byYear} series={[{ key: 's', label: 'Adventurousness', color: C.moss, values: adv.data.byYear.map((y) => y.score), format: (v) => (v * 100).toFixed(0) }]} />}
            </div>
          )}
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Card title="Your keys" subtitle="Plays by key and mode.">
          {w.length === 0 ? <p className="text-sm text-dust">—</p> : <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">{w.slice(0, 12).map((k) => <li key={k.key} className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate">{k.key}{k.camelot && <span className="num ml-1 text-[10px] text-dust">{k.camelot}</span>}</span><span className="num text-xs text-dust">{fmtPct(k.share)}</span></li>)}</ul>}
        </Card>
        <Card title="Extremes" subtitle="Among tracks you've played three times or more.">
          {!ext.data ? <Loading /> : (
            <div className="grid gap-4 sm:grid-cols-2 text-sm">
              {([['Fastest', ext.data.fastest, (t: { bpm: number | null }) => `${Math.round(t.bpm ?? 0)} bpm`], ['Slowest', ext.data.slowest, (t: { bpm: number | null }) => `${Math.round(t.bpm ?? 0)} bpm`], ['Most energetic', ext.data.loudest, (t: { energy: number | null }) => `energy ${(t.energy ?? 0).toFixed(2)}`], ['Quietest', ext.data.quietest, (t: { energy: number | null }) => `energy ${(t.energy ?? 0).toFixed(2)}`]] as const).map(([title, list, fmt]) => (
                <div key={title}><p className="mb-1 text-xs text-dust">{title}</p><ul className="space-y-1">{list.slice(0, 3).map((t) => <li key={t.trackId} className="flex items-baseline gap-2"><Link to={trackHref(t.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{t.track} <span className="text-xs text-dust">{t.artist}</span></Link><span className="num shrink-0 text-xs text-dust">{fmt(t)}</span></li>)}</ul></div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <p className="text-[11px] text-dust/70">Tempo, key, energy and loudness are FreqBlog's full-coverage fields. Its perceptual estimates — valence, mood, danceability — are stored but not charted: the service itself calls them coarse.</p>
    </div>
  );
}
