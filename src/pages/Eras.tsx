import { C } from '@/lib/theme';
import { Link } from 'react-router-dom';
import * as I from '@/lib/insightQueries';
import { useAsync, useFilter } from '@/lib/hooks';
import { SHAPE_LABELS, artistHref, fmtDate, fmtHours, fmtInt, fmtMs, fmtPct, trackHref } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { RankedBars, TrackList } from '@/components/Lists';
import { ClockFace } from '@/components/charts/ClockFace';
import { YearLines } from '@/components/charts/Bars';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { useMemo, useState } from 'react';
import { spanTracks } from '@/lib/insightQueries';
import { genreThreads, threadTracks, type GenreThread } from '@/lib/threadQueries';
import { eraParamsFromSettings, matchingPreset } from '@/lib/eraParams';
import { EraChart, type EraView } from '@/components/charts/EraChart';
import { useSettings } from '@/lib/hooks';
import { sceneTracks, scenes, spanDeepCuts } from '@/lib/phase7Queries';
import type { TrackRow } from '@/lib/types';

export function ErasPage() {
  const { filter } = useFilter();
  const canon = useAsync(() => Promise.all([I.lateNightCanon('track'), I.lateNightCanon('artist')]), [filter]);
  const obs = useAsync(() => I.obsessions(), [filter]);
  const life = useAsync(I.lifecycle, [filter]);
  const skips = useAsync(I.skipForensics, [filter]);
  const seas = useAsync(I.seasonality, [filter]);
  const pers = useAsync(I.personas, [filter]);
  const settings = useSettings();
  const eraParams = useMemo(() => eraParamsFromSettings(settings.data ?? []), [settings.data]);
  const eras = useAsync(() => I.eras(eraParams), [filter, eraParams]);
  const eraWeeks = useAsync(() => I.eraDiagnostic(eraParams, null), [filter, eraParams]);
  const threads = useAsync(() => genreThreads(), [filter]);
  const [eraView, setEraView] = useState<EraView>('areas');
  const [picked, setPicked] = useState<string | null>(null);
  const [retYear, setRetYear] = useState<number | null>(null);
  const sc = useAsync(scenes, [filter]);

  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Eras" title="The chapters of your listening" meta="Eras and genre threads first; then the behavioural detectors — obsessions, comebacks, skips, seasons — that colour them in." />

      <Section title="Eras" subtitle="Stretches of weeks where the same artists ruled, stitched from ISO weeks whose top-40 mixes look alike. Underneath, genre threads: tags that carried a real share of your listening for weeks on end, free to overlap the eras and each other." state={eras}>
        {(rows) => (
          <div>
            <div className="mb-6">
              {eraWeeks.data ? <EraChart weeks={eraWeeks.data} eras={rows} threads={threads.data ?? []} view={eraView} onView={setEraView} onPick={(s) => { setPicked(s.key); document.getElementById(`span-${s.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }} /> : <Loading label="Drawing the timeline…" />}
            </div>
            {rows.length === 0 ? <Muted>Your weeks don't cluster into eras — you change it up faster than the detector can follow. Loosen the similarity threshold in Settings.</Muted> : (
              <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
                <ol className="relative ml-3 border-l border-line pl-6">
                  {rows.map((e) => (
                    <li key={e.start} id={`span-era:${e.start}`} className={`relative mb-5 rounded-lg transition ${picked === `era:${e.start}` ? 'bg-raised/60 -mx-2 px-2 py-1' : ''}`}>
                      <span className="absolute -left-[31px] top-1.5 h-2.5 w-2.5 rounded-full bg-amber" />
                      <p className="num text-xs text-dust">{fmtDate(e.start, { month: 'short', day: 'numeric', year: 'numeric' })} → {fmtDate(e.end, { month: 'short', day: 'numeric', year: 'numeric' })} · {e.weeks} weeks · {fmtHours(e.hours)}{e.skipRate >= 0.18 ? ` · skipped ${Math.round(e.skipRate * 100)}%` : ''}{e.noveltyRate >= 0.5 ? ` · ${Math.round(e.noveltyRate * 100)}% new to you` : ''}</p>
                      <p className="font-display text-2xl">{e.name}{e.inProgress && <span className="ml-3 inline-block whitespace-nowrap align-middle rounded-full border border-amber/50 px-2 py-0.5 font-sans text-[10px] uppercase tracking-wide text-amber">in progress</span>}</p>
                      <p className="mt-0.5 text-sm text-dust">{e.topArtists.map((a, i) => <span key={a.artistId}>{i > 0 ? (i === e.topArtists.length - 1 ? ' & ' : ', ') : ''}<Link to={artistHref(a.artistId)} className="hover:text-amber">{a.artist}</Link></span>)} · {seasonWord(e.start, e.end)}</p>
                      <EraExport era={e} />
                    </li>
                  ))}
                </ol>
                <div>
                  <p className="mb-2 text-xs text-dust">Genre threads — a tag holding 8%+ of a week's listening for 3+ weeks running. Independent of the eras, so they overlap freely.</p>
                  {threads.error ? <ErrorBox message={threads.error} /> : !threads.data ? <Muted>Looking for threads…</Muted> : threads.data.length === 0 ? <Muted>No thread long enough yet. Threads need tags — connect Last.fm or MusicBrainz — and a genre that held on for a few weeks.</Muted> : (
                    <ul className="space-y-3">
                      {threads.data.map((t) => (
                        <li key={t.tag + t.start} id={`span-thread:${t.tag}:${t.start}`} className={`rounded-xl border border-line bg-ink/40 p-3 transition ${picked === `thread:${t.tag}:${t.start}` ? 'border-amber/60' : ''}`}>
                          <p className="num text-xs text-dust">{fmtDate(t.start, { month: 'short', day: 'numeric', year: 'numeric' })} → {fmtDate(t.end, { month: 'short', day: 'numeric', year: 'numeric' })} · {t.weeks} weeks · {fmtHours(t.hours)} · peak {Math.round(t.peakShare * 100)}%</p>
                          <p className="font-display text-lg"><span className="capitalize">{t.tag}</span> thread{t.inProgress && <span className="ml-2 align-middle rounded-full border border-amber/50 px-2 py-0.5 font-sans text-[10px] uppercase tracking-wide text-amber">live</span>}</p>
                          <p className="mt-0.5 truncate text-sm text-dust">{t.topArtists.map((a, i) => <span key={a.artistId}>{i > 0 ? ', ' : ''}<Link to={artistHref(a.artistId)} className="hover:text-amber">{a.artist}</Link></span>)}</p>
                          <ThreadExport t={t} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Section>
      <EraDiagnostic params={eraParams} presetName={matchingPreset(eraParams)?.name ?? null} />

      <Section title="Scenes" subtitle="Clusters of artists that share tags or origin — afrobeat, Turkish, post-punk. Needs Last.fm or MusicBrainz tags; origins arrive from MusicBrainz." state={sc}>
        {(rows) => rows.length === 0 ? <Muted>No scenes yet — connect Last.fm or MusicBrainz and let tags fill in.</Muted> : (
          <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {rows.map((s) => <li key={s.scene} className="rounded-xl border border-line bg-ink/40 p-4"><p className="font-display text-xl capitalize">{s.scene.replace('-', ' ')}</p><p className="num text-xs text-dust">{s.artists} artists · {fmtHours(s.hours)} · {fmtPct(s.share)} of your listening</p><p className="mt-1 truncate text-sm text-dust">{s.lead.join(', ')}</p><SceneExport scene={s.scene} /></li>)}
          </ul>
        )}
      </Section>

      <Section title="Obsessions" subtitle="Weeks where an artist ran at five times their usual pace, 15+ plays. Half-life is how long until the fever broke." state={obs}>
        {(rows) => rows.length === 0 ? <Muted>No week where one artist took over. Steady hands.</Muted> : (
          <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {rows.map((o) => (
              <li key={o.artistId + o.weekStart} className="rounded-xl border border-line bg-ink/40 p-4">
                <p className="num text-xs text-dust">week of {fmtDate(o.weekStart)}</p>
                <p className="mt-1 font-display text-xl"><Link to={artistHref(o.artistId)} className="hover:text-amber">{o.artist}</Link></p>
                <p className="num mt-1 text-sm">{o.plays} plays{o.expected > 0 ? <span className="text-dust"> · usual pace {o.expected.toFixed(0)}/week</span> : <span className="text-dust"> · out of nowhere</span>}</p>
                <p className="mt-1 text-xs text-dust">{o.peakTrack ? <>mostly <em>{o.peakTrack}</em> · </> : null}{o.halfLifeDays === null ? 'never really faded' : `half-life ${o.halfLifeDays} days`}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Comebacks and lifecycles" subtitle="Status compares your last 90 days to the 90 before. Comebacks are artists silent for 6+ months you played this month." state={life}>
        {(l) => (
          <div className="grid gap-6 lg:grid-cols-[1fr_1fr_1.2fr]">
            <LifeList title="Comebacks" rows={l.returned} render={(x) => `quiet ${x.daysSilent >= 180 ? `${Math.round(x.daysSilent / 30)} months` : `${x.daysSilent} days`}, ${fmtHours(x.hours)} all time`} accent="text-moss" />
            <div>
              <LifeList title="Rising" rows={l.rising} render={(x) => `${fmtHours(x.recentHours)} last 90 days vs ${fmtHours(x.priorHours)} before`} accent="text-amber" />
              <div className="mt-5"><LifeList title="Fading" rows={l.fading} render={(x) => `${fmtHours(x.recentHours)} last 90 days vs ${fmtHours(x.priorHours)} before`} accent="text-coral" /></div>
            </div>
            <div>
              <p className="text-xs text-dust">Retention — of the artists you found each year (5+ plays), how many you still played in the last 12 months</p>
              <ul className="mt-2 space-y-1.5">
                {l.retention.map((r) => (
                  <li key={r.year}>
                    <button onClick={() => setRetYear(retYear === r.year ? null : r.year)} className="flex w-full items-center gap-3 text-left text-sm hover:text-cream">
                      <span className="num w-10 text-dust">{r.year}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-moss/80" style={{ width: `${(r.stillPlayed / Math.max(r.discovered, 1)) * 100}%` }} /></div>
                      <span className="num w-24 text-right text-xs text-dust">{r.stillPlayed}/{r.discovered} · {fmtPct(r.stillPlayed / Math.max(r.discovered, 1))}</span>
                      <span className="text-xs text-dust">{retYear === r.year ? '▾' : '▸'}</span>
                    </button>
                    {retYear === r.year && <RetentionDetail year={r.year} />}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-dust">Gone quiet (6+ months): {l.dormant.slice(0, 6).map((x, i) => <span key={x.artistId}>{i > 0 ? ', ' : ''}<Link to={artistHref(x.artistId)} className="hover:text-amber">{x.artist}</Link></span>)}</p>
            </div>
          </div>
        )}
      </Section>

      <Section title="Skip forensics" subtitle="The ones you can't quit skipping, the moments you always bail, and your patience over the years." state={skips}>
        {(s) => (
          <div className="grid gap-6 lg:grid-cols-3">
            <div>
              <p className="mb-2 text-xs text-dust">Keep playing, keep skipping — 10+ plays, skipped 60%+</p>
              {s.cantQuit.length ? <TrackList data={s.cantQuit} /> : <Muted>Nothing you both keep and keep skipping.</Muted>}
            </div>
            <div>
              <p className="mb-2 text-xs text-dust">Consistent early exits — you bail at the same second, every time</p>
              {s.earlyExits.length ? (
                <ul className="divide-y divide-line/60 text-sm">
                  {s.earlyExits.map((e) => <li key={e.trackId} className="py-2"><Link to={trackHref(e.trackId)} className="hover:text-amber">{e.track}</Link><span className="ml-2 text-xs text-dust">{e.artist}</span><p className="num text-xs text-dust">bail at {fmtMs(e.meanMs)}{e.durationMs ? ` of ${fmtMs(e.durationMs)}` : ''} · {e.n} times · ±{Math.round(e.sdMs / 1000)}s</p></li>)}
                </ul>
              ) : <Muted>No track where the skip point is that consistent.</Muted>}
            </div>
            <div>
              <p className="mb-2 text-xs text-dust">Patience by year</p>
              <YearLines rows={s.byYear} series={[
                { key: 's', label: 'Skip rate', color: C.coral, values: s.byYear.map((y) => y.skipRate), format: fmtPct },
                { key: 'u', label: 'Plays under 30 s', color: C.dust, values: s.byYear.map((y) => y.under30), format: fmtPct },
              ]} />
            </div>
          </div>
        )}
      </Section>

      <Section title="The 3 AM canon" subtitle="What you reach for between 11 PM and 4 AM, ranked by how much more likely it is then than at any other hour." state={canon}>
        {([tracks, artists]) => tracks.length === 0 && artists.length === 0 ? <Muted>Not much of a night owl — at least not when you're actually there. Flip the lens to Everything to include the all-nighters.</Muted> : (
          <div className="grid gap-6 lg:grid-cols-2">
            <div><CanonList title="Songs" rows={tracks} href={(r) => trackHref(r.id)} />{tracks.length > 0 && <div className="mt-2"><MakePlaylistButton small name="The 3 AM canon" tracks={tracks.map((r) => ({ trackId: r.id, track: r.name, artistId: r.artistId, artist: r.artist ?? '', plays: r.latePlays, hours: 0, skipRate: 0 }))} kind="insight" note="insight:canon" /></div>}</div>
            <CanonList title="Artists" rows={artists} href={(r) => artistHref(r.id)} />
          </div>
        )}
      </Section>

      <Section title="Two of you" subtitle="Weekday you and weekend you rarely agree." state={pers}>
        {(p) => (
          <div className="grid gap-6 lg:grid-cols-2">
            <PersonaCol label="Weekdays" p={p.weekday} />
            <PersonaCol label="Weekends" p={p.weekend} />
            {p.commute && (
              <div className="lg:col-span-2 rounded-xl border border-line bg-ink/40 p-4">
                <p className="text-xs text-dust">Commute signature</p>
                <p className="mt-1 font-display text-xl">{p.commute.window} <span className="text-base text-dust">· {fmtHours(p.commute.hours)} of sessions started in this window</span></p>
                <p className="mt-1 text-sm text-dust">Fills it: {p.commute.topArtists.map((a, i) => <span key={a.artistId}>{i > 0 ? ', ' : ''}<Link to={artistHref(a.artistId)} className="text-cream hover:text-amber">{a.artist}</Link></span>)}</p>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Seasons" subtitle="Artists you play at least twice as much in one season as their share would predict, across 2+ years." state={seas}>
        {(s) => !s.enough ? <Muted>Needs at least two years of listening.</Muted> : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {(['winter', 'spring', 'summer', 'autumn'] as const).map((k) => (
              <div key={k}>
                <p className="mb-2 font-display text-lg capitalize">{k}</p>
                {s[k].length ? <ul className="space-y-1 text-sm">{s[k].map((a) => <li key={a.artistId} className="flex justify-between gap-2"><Link to={artistHref(a.artistId)} className="truncate hover:text-amber">{a.artist}</Link><span className="num shrink-0 text-xs text-dust">×{a.index.toFixed(1)}</span></li>)}</ul> : <Muted>—</Muted>}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section<T>({ title, subtitle, state, children }: { title: string; subtitle: string; state: { data: T | null; error: string | null; loading: boolean }; children: (d: T) => React.ReactNode }) {
  return (
    <div className="mt-6">
      <Card title={title} subtitle={subtitle}>
        {state.error ? <ErrorBox message={state.error} /> : state.data === null ? <Loading label="Computing…" /> : children(state.data)}
      </Card>
    </div>
  );
}
const Muted = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-dust">{children}</p>;

function LifeList({ title, rows, render, accent }: { title: string; rows: I.Lifecycle[]; render: (x: I.Lifecycle) => string; accent: string }) {
  return (
    <div>
      <p className={`text-xs ${accent}`}>{title}</p>
      {rows.length ? <ul className="mt-2 divide-y divide-line/60 text-sm">{rows.map((x) => <li key={x.artistId} className="py-1.5"><Link to={artistHref(x.artistId)} className="hover:text-amber">{x.artist}</Link><p className="num text-xs text-dust">{render(x)}</p></li>)}</ul> : <Muted>—</Muted>}
    </div>
  );
}
function CanonList({ title, rows, href }: { title: string; rows: I.CanonRow[]; href: (r: I.CanonRow) => string }) {
  return (
    <div>
      <p className="mb-2 text-xs text-dust">{title}</p>
      {rows.length ? <ul className="divide-y divide-line/60 text-sm">{rows.map((r) => <li key={r.id} className="flex items-baseline justify-between gap-3 py-1.5"><span className="truncate"><Link to={href(r)} className="hover:text-amber">{r.name}</Link>{r.artist ? <span className="ml-2 text-xs text-dust">{r.artist}</span> : null}</span><span className="num shrink-0 text-xs text-dust">{r.latePlays} late · ×{r.lift.toFixed(1)}</span></li>)}</ul> : <Muted>—</Muted>}
    </div>
  );
}
function PersonaCol({ label, p }: { label: string; p: I.Persona }) {
  const top = p.shapes[0];
  return (
    <div className="rounded-xl border border-line bg-ink/40 p-4">
      <div className="flex items-start gap-4">
        <div className="w-28 shrink-0"><ClockFace data={p.clock} size={140} /></div>
        <div className="min-w-0 flex-1">
          <p className="font-display text-xl">{label}</p>
          <p className="num text-xs text-dust">{fmtHours(p.hours)} · skips {fmtPct(p.skipRate)}{top ? ` · mostly ${SHAPE_LABELS[top.shape]?.label.toLowerCase() ?? top.shape}` : ''}</p>
        </div>
      </div>
      <div className="mt-3"><RankedBars data={p.topArtists} /></div>
    </div>
  );
}
function EraExport({ era }: { era: I.Era }) {
  const [tracks, setTracks] = useState<TrackRow[] | null>(null);
  const endExcl = era.endExclusive;
  const [deep, setDeep] = useState<TrackRow[] | null>(null);
  if (tracks) return <div className="mt-2 flex flex-wrap items-center gap-3"><MakePlaylistButton small label={`Export era · ${tracks.length} tracks`} name={era.name} tracks={tracks} kind="insight" description={`${fmtDate(era.start, { month: 'short', day: 'numeric', year: 'numeric' })} → ${fmtDate(era.end, { month: 'short', day: 'numeric', year: 'numeric' })}. ${fmtHours(era.hours)}. Made with Deep Cuts.`} note={`era:${era.start}:${endExcl}`} poolRange={[era.start, endExcl]} />
    {deep ? <span className="text-xs text-dust">also in rotation: {deep.slice(0, 8).map((t, i) => <span key={t.trackId}>{i > 0 ? ' · ' : ''}<Link to={trackHref(t.trackId)} className="hover:text-amber">{t.track}</Link></span>)}</span> : <button onClick={() => spanDeepCuts(era.start, endExcl, 10, 12).then(setDeep)} className="text-xs text-dust hover:text-amber">also in rotation…</button>}</div>;
  return <button onClick={() => spanTracks(era.start, endExcl, 30).then(setTracks)} className="mt-2 text-xs text-dust hover:text-amber">Export era as playlist</button>;
}
function ThreadExport({ t }: { t: GenreThread }) {
  const [tracks, setTracks] = useState<TrackRow[] | null>(null);
  if (tracks) return <div className="mt-2"><MakePlaylistButton small label={`Export thread · ${tracks.length} tracks`} name={`${t.tag} thread · ${fmtDate(t.start, { month: 'short', year: 'numeric' })}`} tracks={tracks} kind="insight" note={`thread:${t.tag}:${t.start}:${t.endExclusive}`} pool={tracks} /></div>;
  return <button onClick={() => threadTracks(t.tag, t.start, t.endExclusive, 30).then(setTracks)} className="mt-2 text-xs text-dust hover:text-amber">Export thread as playlist</button>;
}
function SceneExport({ scene }: { scene: string }) {
  const [tracks, setTracks] = useState<TrackRow[] | null>(null);
  if (tracks) return <div className="mt-2"><MakePlaylistButton small label={`Export · ${tracks.length}`} name={`${scene.replace('-', ' ')} · Deep Cuts`} tracks={tracks} kind="insight" note={`scene:${scene}`} pool={tracks} /></div>;
  return <button onClick={() => sceneTracks(scene, 30).then(setTracks)} className="mt-2 text-xs text-dust hover:text-amber">Export scene as playlist</button>;
}
function seasonWord(start: string, end: string) {
  const m = Number(start.slice(5, 7)), e = Number(end.slice(5, 7));
  const s = (mm: number) => (mm === 12 || mm <= 2 ? 'winter' : mm <= 5 ? 'spring' : mm <= 8 ? 'summer' : 'autumn');
  const a = s(m), b = s(e);
  return a === b ? `${a}` : `${a} into ${b}`;
}
export { fmtInt };

/** Phase 9: the artists behind one retention bar — who went quiet, who stayed. */
function RetentionDetail({ year }: { year: number }) {
  const { filter } = useFilter();
  const d = useAsync(() => I.retentionDetail(year), [year, filter]);
  const [showAll, setShowAll] = useState(false);
  if (!d.data) return <p className="ml-13 mt-1 text-xs text-dust">Looking back…</p>;
  const quiet = d.data.filter((a) => !a.stillPlayed), kept = d.data.filter((a) => a.stillPlayed);
  const shown = showAll ? quiet : quiet.slice(0, 8);
  return (
    <div className="ml-13 mt-2 rounded-xl border border-line bg-ink/40 p-3 text-xs">
      <p className="text-dust"><span className="text-coral">Went quiet</span> — {quiet.length} artists from {year} you haven't played in a year, biggest first</p>
      <ul className="mt-1.5 space-y-1">
        {shown.map((a) => <li key={a.artistId} className="flex items-baseline gap-3"><Link to={artistHref(a.artistId)} className="min-w-0 flex-1 truncate hover:text-amber">{a.artist}</Link><span className="num text-dust">{fmtHours(a.hours)} · {fmtInt(a.plays)} plays</span><span className="num w-28 text-right text-dust">silent {Math.round(a.daysSilent / 30)} mo</span></li>)}
      </ul>
      {quiet.length > 8 && <button onClick={() => setShowAll(!showAll)} className="mt-1.5 text-dust hover:text-cream">{showAll ? 'fewer' : `all ${quiet.length}`}</button>}
      {kept.length > 0 && <p className="mt-3 text-dust"><span className="text-moss">Still with you</span> — {kept.slice(0, 10).map((a, i) => <span key={a.artistId}>{i > 0 ? ', ' : ''}<Link to={artistHref(a.artistId)} className="hover:text-amber">{a.artist}</Link></span>)}{kept.length > 10 ? ` and ${kept.length - 10} more` : ''}</p>}
    </div>
  );
}

/** Phase 9: why the era boundaries fall where they do. Collapsed by default; the numbers the owner needs to tune the detector on a real record (the sliders live in Settings). */
function EraDiagnostic({ params, presetName }: { params: I.EraParams; presetName: string | null }) {
  const { filter } = useFilter();
  const [open, setOpen] = useState(false);
  const d = useAsync(() => (open ? I.eraDiagnostic(params, 52) : Promise.resolve([])), [open, filter, params]);
  return (
    <div className="-mt-4 mb-8 ml-9">
      <button onClick={() => setOpen(!open)} className="text-xs text-dust hover:text-cream">{open ? '▾' : '▸'} how the boundaries were drawn (last 52 weeks)</button>
      {open && d.data && (
        <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-ink/40 p-3 text-xs">
          <p className="mb-2 text-dust">Each week's hours under the current lens and how similar its top-40 artist mix is to the week before (cosine, 0–1). A new era opens when similarity drops below <span className="num text-cream">{params.similarity}</span> or the gap exceeds <span className="num text-cream">{params.maxGapWeeks}</span> weeks; runs shorter than <span className="num text-cream">{params.minWeeks}</span> weeks are folded into a neighbour; weeks under <span className="num text-cream">{params.floorH} h</span> are ignored. {presetName ? <>Preset: <span className="text-cream">{presetName}</span>.</> : 'Custom tuning.'} <Link to="/settings" className="underline hover:text-cream">Tune in Settings</Link>.</p>
          <table className="num w-full text-left"><thead><tr className="text-dust"><th className="pr-3 font-normal">week of</th><th className="pr-3 font-normal">hours</th><th className="pr-3 font-normal">similarity</th><th className="pr-3 font-normal">top artist</th></tr></thead>
            <tbody>{d.data.map((m) => <tr key={m.week} className={m.breaks ? 'text-amber' : ''}><td className="pr-3">{m.week}{m.breaks ? ' ⟵' : ''}</td><td className="pr-3">{m.hours.toFixed(1)}</td><td className="pr-3">{m.cosToPrev == null ? '—' : m.cosToPrev.toFixed(3)}</td><td className="pr-3 font-sans">{m.topArtist ?? ''}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}
