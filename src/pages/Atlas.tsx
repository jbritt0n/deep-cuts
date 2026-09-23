import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import world from '@/assets/world-110m.json';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { artistHref, fmtHours, fmtInt, fmtPct } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';
import { countryArtists, originByYear, originSummary, type CountryRow } from '@/lib/originQueries';

type World = { width: number; height: number; sphere: string; paths: Record<string, string>; names: Record<string, string> };
const W = world as World;

/**
 * Phase 9g — Atlas. Where your artists come from (MusicBrainz origins), shaded by hours under the lens.
 * Natural Earth 110m paths baked to a static asset (src/assets/world-110m.json, 175 countries, Natural Earth I
 * projection) — no map library. Hover for the top artists, click for the full list; the table below is the
 * accessible twin of the map and sorts the same way.
 */
export function AtlasPage() {
  const { filter } = useFilter();
  const sum = useAsync(originSummary, [filter]);
  const years = useAsync(originByYear, [filter]);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [metric, setMetric] = useState<'hours' | 'artists'>('hours');
  const artists = useAsync(() => (picked ? countryArtists(picked) : Promise.resolve(null)), [picked, filter]);
  const byCode = useMemo(() => new Map((sum.data?.rows ?? []).map((r) => [r.country, r])), [sum.data]);
  const max = useMemo(() => Math.max(1e-9, ...(sum.data?.rows ?? []).map((r) => (metric === 'hours' ? r.hours : r.artists))), [sum.data, metric]);
  const shade = (r: CountryRow | undefined) => {
    if (!r) return 'var(--c-raised)';
    const v = metric === 'hours' ? r.hours : r.artists;
    const t = Math.pow(v / max, 0.45);   // sqrt-ish so the long tail is visible
    return `color-mix(in srgb, var(--c-amber) ${Math.round(15 + 85 * t)}%, var(--c-raised))`;
  };
  if (sum.error) return <ErrorBox message={sum.error} />;
  if (!sum.data) return <Loading label="Placing your artists…" />;
  const d = sum.data;
  const cur = hover ?? picked;
  const curRow = cur ? byCode.get(cur) : undefined;
  const homeless = d.totalArtists - d.coveredArtists;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <p className="text-sm text-dust">Where it comes from</p>
        <h1 className="mt-1 font-display text-4xl">Atlas</h1>
        <p className="num mt-2 max-w-2xl text-dust">{fmtInt(d.countries)} countries · {fmtPct(d.totalHours ? d.coveredHours / d.totalHours : 0)} of your hours have a known origin ({fmtInt(d.coveredArtists)} of {fmtInt(d.totalArtists)} artists). Origins come from MusicBrainz as it resolves your artists; {homeless > 0 ? `${fmtInt(homeless)} artists are still unplaced and don't colour anything here.` : 'every artist is placed.'}</p>
      </header>

      <Card title="The map" subtitle="Shaded by how much you listen to artists from each country. Hover for the top names; click to open the full list." aside={<div className="flex gap-1 text-xs">{(['hours', 'artists'] as const).map((m) => <button key={m} onClick={() => setMetric(m)} className={`rounded-full px-3 py-1 ${metric === m ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{m}</button>)}</div>}>
        <div className="relative">
          <svg viewBox={`0 0 ${W.width} ${W.height}`} className="w-full" role="img" aria-label="World map shaded by listening hours per country of origin">
            <path d={W.sphere} fill="var(--c-ink)" stroke="var(--c-line)" strokeWidth="1" />
            {Object.entries(W.paths).map(([code, p]) => {
              const r = byCode.get(code);
              const active = cur === code;
              return <path key={code} d={p} fill={shade(r)} stroke={active ? 'var(--c-cream)' : 'var(--c-ink)'} strokeWidth={active ? 1.5 : 0.5} className={r ? 'cursor-pointer' : ''}
                onMouseEnter={() => setHover(code)} onMouseLeave={() => setHover(null)} onClick={() => r && setPicked(picked === code ? null : code)}><title>{W.names[code] ?? code}{r ? ` — ${fmtHours(r.hours)}, ${r.artists} artists` : ' — nothing placed here'}</title></path>;
            })}
          </svg>
          {curRow && (
            <div className="pointer-events-none absolute left-3 top-3 max-w-xs rounded-xl border border-line bg-surface/95 p-3 text-sm shadow-lg">
              <p className="font-display text-lg">{curRow.name}</p>
              <p className="num text-xs text-dust">{fmtHours(curRow.hours)} · {fmtInt(curRow.plays)} plays · {curRow.artists} artist{curRow.artists === 1 ? '' : 's'} · {fmtPct(curRow.share)} of placed hours{curRow.sceneLabel ? ` · mostly ${curRow.sceneLabel}` : ''}</p>
              <p className="mt-1 truncate text-xs">{curRow.topArtists.join(' · ')}</p>
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-dust"><span>less</span><span className="h-2 w-40 rounded-full" style={{ background: 'linear-gradient(to right, color-mix(in srgb, var(--c-amber) 15%, var(--c-raised)), var(--c-amber))' }} /><span>more</span><span className="ml-3 inline-block h-2 w-4 rounded-sm bg-raised" /><span>no artists placed</span></div>
      </Card>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card title="By country" subtitle="The accessible twin of the map — same numbers, sortable by hours or artists.">
          <ol className="max-h-[480px] divide-y divide-line/60 overflow-y-auto text-sm">
            {[...d.rows].sort((a, b) => (metric === 'hours' ? b.hours - a.hours : b.artists - a.artists)).map((r, i) => (
              <li key={r.country} className={`flex items-center gap-3 py-1.5 ${picked === r.country ? 'text-amber' : ''}`}>
                <span className="num w-6 text-xs text-dust">{i + 1}</span>
                <button onClick={() => setPicked(picked === r.country ? null : r.country)} className="min-w-0 flex-1 truncate text-left hover:text-amber">{r.name}<span className="ml-2 text-xs text-dust">{r.sceneLabel ?? ''}</span></button>
                <div className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-raised sm:block"><div className="h-full rounded-full bg-amber/80" style={{ width: `${Math.min(100, ((metric === 'hours' ? r.hours : r.artists) / max) * 100)}%` }} /></div>
                <span className="num w-24 shrink-0 text-right text-xs text-dust">{fmtHours(r.hours)} · {r.artists}</span>
              </li>
            ))}
          </ol>
        </Card>
        <div className="space-y-6">
          <Card title={picked ? `Artists from ${W.names[picked] ?? byCode.get(picked)?.name ?? picked}` : 'Pick a country'} subtitle={picked ? `${byCode.get(picked)?.artists ?? 0} artists, by hours under the lens.` : 'Click a country on the map or in the list.'}>
            {!picked ? <p className="text-sm text-dust">Nothing selected.</p> : !artists.data ? <Loading /> : (
              <ul className="max-h-[320px] divide-y divide-line/60 overflow-y-auto text-sm">
                {artists.data.map((a) => <li key={a.artistId} className="flex items-baseline gap-2 py-1.5"><Link to={artistHref(a.artistId)} className="min-w-0 flex-1 truncate hover:text-amber">{a.artist}{a.city && <span className="ml-2 text-xs text-dust">{a.city}</span>}</Link><span className="num shrink-0 text-xs text-dust" title={`first played ${a.firstPlayed}`}>{fmtHours(a.hours)} · {fmtInt(a.plays)}</span></li>)}
              </ul>
            )}
          </Card>
          <Card title="How the map widened" subtitle="Countries with at least half an hour of listening each year, and the ones that were new that year.">
            {years.error ? <ErrorBox message={years.error} /> : !years.data ? <Loading /> : years.data.length === 0 ? <p className="text-sm text-dust">No placed artists yet.</p> : (
              <ul className="space-y-1.5 text-sm">
                {years.data.map((y) => <li key={y.year} className="flex items-baseline gap-3"><span className="num w-12 text-dust">{y.year}</span><span className="num w-24 shrink-0">{y.countries} countr{y.countries === 1 ? 'y' : 'ies'}</span><span className="min-w-0 flex-1 truncate text-xs text-dust" title={y.newCountries.map((c) => W.names[c] ?? c).join(', ')}>{y.newCountries.length ? `new: ${y.newCountries.slice(0, 6).map((c) => W.names[c] ?? c).join(', ')}${y.newCountries.length > 6 ? ` +${y.newCountries.length - 6}` : ''}` : ''}</span></li>)}
              </ul>
            )}
          </Card>
        </div>
      </section>
      <p className="mt-6 text-xs text-dust/70">Country boundaries: Natural Earth (public domain) via world-atlas, 1:110m. Origins: MusicBrainz artist area, resolved by the MusicBrainz connector; artists with only a city or region resolve to that country. Add or fix an origin by correcting the artist on MusicBrainz — the next enrichment pass picks it up.</p>
    </div>
  );
}
