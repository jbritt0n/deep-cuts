import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { QueueButton } from '@/components/QueueButton';
import { ForecastAccuracyCard } from '@/components/ForecastCard';
import { MoodStations } from '@/pages/Moods';
import { backtest, dayForecast, fronts, logForecast, weekOutlook, CALL_MIN_N, CALL_MIN_P } from '@/lib/forecastQueries';
import { artistHref, fmtInt, fmtPct, trackHref } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';
import { C } from '@/lib/theme';

/**
 * Phase 9h — Moods & Forecast (owner: "a page that predicts what I'll listen to today / this week … weather/radio
 * themed"). Everything is a probability from your own record: the weekday habit (last 26 same weekdays) blended
 * half-and-half with the recent trend (last 14 days). The verification section replays the model on the last
 * four weeks using only what it could have known that morning, so its accuracy is visible on day one.
 */
const PALETTE = [C.amber, C.coral, C.moss, C.violet, '#7FC8A9', '#F2C27B', '#E48FB0', '#8FB3E4', '#C9A77F'];
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const sceneColor = (s: string | null) => (s ? PALETTE[hash(s) % PALETTE.length] : C.line);

export function MoodsForecastPage() {
  const { filter } = useFilter();
  const loc = useLocation();
  const today = useAsync(() => dayForecast(), [filter]);
  const week = useAsync(() => weekOutlook(), [filter]);
  const fr = useAsync(() => fronts(), [filter]);
  const bt = useAsync(() => backtest(28), [filter]);
  useEffect(() => { if (today.data && !today.data.logged && !filter.fromYear && !filter.toYear) void logForecast(today.data); }, [today.data, filter]);
  useEffect(() => { if (loc.hash && today.data) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: 'start' }); }, [loc.hash, today.data]);

  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Moods & Forecast · DCFM" title="The listening weather" meta="What's likely on the air today and this week, from your own habits and where they're heading. A spread of chances, never one song — then the ten stations you actually tune to." />

      {/* ---------- Today's broadcast */}
      <section id="forecast" className="scroll-mt-4">
        {today.error ? <ErrorBox message={today.error} /> : !today.data ? <Loading label="Reading the barometer…" /> : <Broadcast d={today.data} />}
      </section>

      {/* ---------- 7-day outlook */}
      <section className="mt-6">
        <Card title="7-day outlook" subtitle={week.data ? `Each day from its weekday profile over the last 26 weeks${Math.abs(week.data.trend - 1) >= 0.1 ? `, scaled by your recent volume (${week.data.trend > 1 ? '+' : ''}${Math.round((week.data.trend - 1) * 100)}% vs usual over the last four weeks)` : ''}.` : 'The week ahead.'}>
          {week.error ? <ErrorBox message={week.error} /> : !week.data ? <Loading /> : (
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {week.data.days.map((d, i) => (
                <li key={d.date} className={`rounded-xl border p-3 ${i === 0 ? 'border-amber/60 bg-amber/5' : 'border-line bg-ink/30'}`}>
                  <p className="text-xs text-dust">{i === 0 ? 'Today' : d.weekdayName.slice(0, 3)} <span className="num">{d.date.slice(5)}</span></p>
                  <p className="mt-1 text-3xl leading-none" aria-hidden>{d.condition.glyph}</p>
                  <p className="mt-1 text-xs">{d.condition.label}</p>
                  <p className="num mt-1 text-[11px] text-dust">{fmtPct(d.pAny)} · ~{fmtInt(d.minutes)} min</p>
                  {d.scenes[0] && <p className="mt-1 truncate text-[11px]" title={d.scenes.map((s) => `${s.label} ${fmtPct(s.p)}`).join(' · ')}><span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: sceneColor(d.scenes[0].scene) }} />{d.scenes[0].label}</p>}
                  {d.topArtist && <p className="truncate text-[11px] text-dust" title={`most-played artist on ${d.weekdayName}s`}>{d.topArtist}</p>}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>

      {/* ---------- Fronts */}
      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Warm fronts moving in" subtitle="Scenes and artists taking a bigger share of the last four weeks than of the twelve before.">
          {fr.error ? <ErrorBox message={fr.error} /> : !fr.data ? <Loading /> : <FrontList list={fr.data.warm} warm />}
        </Card>
        <Card title="Cold fronts" subtitle="What's losing ground — still around, but less on the air.">
          {fr.error ? <ErrorBox message={fr.error} /> : !fr.data ? <Loading /> : <FrontList list={fr.data.cold} />}
        </Card>
      </section>

      {/* ---------- Verification */}
      <section id="verification" className="mt-6 grid scroll-mt-4 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="How the forecast did — last four weeks" subtitle="Replayed each morning using only what it could have known then. Hits = of its ten likeliest artists, how many you actually played that day; the baseline just names your ten biggest artists.">
          {bt.error ? <ErrorBox message={bt.error} /> : !bt.data ? <Loading label="Replaying the last four weeks…" /> : (
            <div>
              <p className="text-sm">{bt.data.verdict}</p>
              <div className="mt-3 flex flex-wrap gap-6">
                <Stat label="forecast hit rate" value={fmtPct(bt.data.hitRate)} />
                <Stat label="baseline (your top 10)" value={fmtPct(bt.data.baselineRate)} />
                <Stat label="“will I listen?” Brier" value={bt.data.brierAny.toFixed(3)} hint="0 = perfect, 0.25 = coin flip" />
              </div>
              <ol className="mt-4 max-h-[min(22rem,45vh)] space-y-1 overflow-y-auto pr-1 text-sm">
                {bt.data.days.map((d) => (
                  <li key={d.date} className="flex items-center gap-2">
                    <span className="num w-20 shrink-0 text-xs text-dust">{d.weekdayName.slice(0, 3)} {d.date.slice(5)}</span>
                    {d.listened ? (
                      <>
                        <span className="flex gap-0.5" title={d.predicted.map((p) => `${p.hit ? '✓' : '·'} ${p.artist} (${fmtPct(p.p)})`).join('\n')}>{d.predicted.map((p) => <span key={p.artistId} className={`inline-block h-3 w-2 rounded-sm ${p.hit ? 'bg-moss' : 'bg-raised'}`} />)}</span>
                        <span className="num w-14 text-right text-xs">{d.hits}/10</span>
                        <span className="num w-20 text-right text-[11px] text-dust">base {d.baselineHits}/10</span>
                      </>
                    ) : <span className="text-xs text-dust">silent day · forecast said {fmtPct(d.pAny)} chance</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Card>
        <ForecastAccuracyCard />
      </section>

      {/* ---------- The dial */}
      <section className="mt-10">
        <div className="mb-4"><p className="text-sm text-dust">On the dial</p><h2 className="font-display text-3xl">Your ten stations</h2><p className="mt-1 max-w-3xl text-sm text-dust">Weekday and weekend, five parts of the day. Each station is what you actually reach for then — artists ranked by how much more they show up in that slot than usual.</p></div>
        <MoodStations />
      </section>
    </div>
  );
}

function Broadcast({ d }: { d: Awaited<ReturnType<typeof dayForecast>> }) {
  const maxP = Math.max(0.01, ...d.hourly.map((h) => h.p));
  const scenesInRadar = [...new Map(d.hourly.filter((h) => h.scene && h.p > 0.1).map((h) => [h.scene!, h.label!])).entries()].slice(0, 6);
  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <Card title={`Today's broadcast · ${d.weekdayName}`} subtitle={`From your last ${d.sameDays} ${d.weekdayName}s (${d.activeDays} with listening) and the last 14 days (${d.recentActive} with listening).`}>
        <div className="flex items-start gap-4">
          <span className="text-6xl leading-none" aria-hidden>{d.condition.glyph}</span>
          <div className="min-w-0">
            <p className="font-display text-2xl leading-tight">{d.headline}</p>
            <p className="num mt-2 text-sm text-dust">{fmtPct(d.pAny)} chance of listening · about {fmtInt(d.expectedMinutes)} min on a typical {d.weekdayName}</p>
          </div>
        </div>
        <div className="mt-5">
          <p className="mb-1 text-xs text-dust">Hour-by-hour radar — chance you're listening, coloured by the scene that usually leads</p>
          <svg viewBox="0 0 480 90" className="w-full" role="img" aria-label="Chance of listening by hour">
            {d.hourly.map((h) => { const hh = (h.p / maxP) * 64; return <g key={h.hour}><rect x={h.hour * 20 + 2} y={70 - hh} width="16" height={Math.max(1, hh)} rx="3" fill={sceneColor(h.scene)} opacity={0.35 + 0.65 * (h.p / maxP)}><title>{h.hour}:00 · {fmtPct(h.p)}{h.label ? ` · ${h.label}` : ''}</title></rect>{h.hour % 3 === 0 && <text x={h.hour * 20 + 10} y="86" fontSize="10" textAnchor="middle" fill={C.dust}>{h.hour}</text>}</g>; })}
          </svg>
          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-dust">{scenesInRadar.map(([k, l]) => <span key={k} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: sceneColor(k) }} />{l}</span>)}</div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {d.slotOutlook.map((s) => <div key={s.slot} className="rounded-lg border border-line bg-ink/30 px-3 py-2"><p className="text-xs capitalize text-dust">{s.slot}</p><p className="num text-sm">{fmtPct(s.p)}</p><p className="truncate text-[11px]" style={{ color: sceneColor(s.scene) }}>{s.label ?? '—'}</p></div>)}
        </div>
        {d.calls.length > 0 ? <p className="mt-4 rounded-lg border border-amber/40 bg-amber/5 px-3 py-2 text-sm">High-confidence call: {d.calls.map((c) => `${c.label} (${c.hits} of your last ${c.n} ${d.weekdayName}s)`).join(' · ')}.</p>
          : <p className="mt-4 text-[11px] text-dust/70">No high-confidence call — that needs {fmtPct(CALL_MIN_P)} over at least {CALL_MIN_N} {d.weekdayName}s.</p>}
      </Card>
      <Card title="On air today" subtitle="Likeliest artists and songs — weekday habit blended with the last two weeks." aside={d.tracks.length > 0 ? <MakePlaylistButton small label={`Tune in · ${d.tracks.length}`} name={`DCFM · ${d.weekdayName} forecast`} kind="insight" description={`The songs Deep Cuts expects you to reach for on a ${d.weekdayName}.`} tracks={d.tracks} /> : undefined}>
        <ul className="space-y-1.5 text-sm">
          {d.artists.slice(0, 8).map((a) => (
            <li key={a.artistId} className="flex items-center gap-2" title={`weekday ${fmtPct(a.pWeekday)} · recent ${fmtPct(a.pRecent)}`}>
              <Link to={artistHref(a.artistId)} className="w-40 shrink-0 truncate hover:text-amber">{a.artist}</Link>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/80" style={{ width: `${Math.round(a.p * 100)}%` }} /></div>
              <span className="num w-10 text-right text-xs text-dust">{fmtPct(a.p)}</span>
            </li>
          ))}
        </ul>
        <p className="mb-1 mt-5 text-xs text-dust">Songs in the forecast</p>
        <ol className="space-y-1 text-sm">
          {d.tracks.slice(0, 8).map((t) => <li key={t.trackId} className="flex items-center gap-2"><QueueButton trackId={t.trackId} /><Link to={trackHref(t.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{t.track} <span className="text-xs text-dust">{t.artist}</span></Link><span className="num text-[11px] text-dust">{fmtPct(t.p)}</span></li>)}
        </ol>
      </Card>
    </div>
  );
}

function FrontList({ list, warm = false }: { list: { key: string; label: string; recentShare: number; priorShare: number; ratio: number; kind: 'scene' | 'artist' }[]; warm?: boolean }) {
  if (!list.length) return <p className="text-sm text-dust">{warm ? 'Calm skies — nothing is gaining much ground.' : 'Nothing is fading noticeably.'}</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {list.map((f) => (
        <li key={f.kind + f.key} className="flex items-baseline gap-2">
          <span aria-hidden className={warm ? 'text-coral' : 'text-violet'}>{warm ? '▲' : '▼'}</span>
          {f.kind === 'artist' ? <Link to={artistHref(f.key)} className="min-w-0 flex-1 truncate hover:text-amber">{f.label}</Link> : <span className="min-w-0 flex-1 truncate">{f.label} <span className="text-[10px] uppercase tracking-wide text-dust">scene</span></span>}
          <span className="num shrink-0 text-xs text-dust">{fmtPct(f.priorShare)} → {fmtPct(f.recentShare)}</span>
        </li>
      ))}
    </ul>
  );
}

const Stat = ({ label, value, hint }: { label: string; value: string; hint?: string }) => <div title={hint}><p className="num font-display text-3xl">{value}</p><p className="text-xs text-dust">{label}</p></div>;
