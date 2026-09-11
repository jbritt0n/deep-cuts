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
import { useState } from 'react';
import { spanTracks } from '@/lib/insightQueries';
import type { TrackRow } from '@/lib/types';

export function InsightsPage() {
  const { filter } = useFilter();
  const canon = useAsync(() => Promise.all([I.lateNightCanon('track'), I.lateNightCanon('artist')]), [filter]);
  const obs = useAsync(() => I.obsessions(), [filter]);
  const life = useAsync(I.lifecycle, [filter]);
  const skips = useAsync(I.skipForensics, [filter]);
  const seas = useAsync(I.seasonality, [filter]);
  const pers = useAsync(I.personas, [filter]);
  const eras = useAsync(() => I.eras(), [filter]);

  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Insights" title="What the record says about you" meta="Every card is computed from behaviour alone: skips, repeats, timing, loyalty. No genres needed." />

      <Section title="Eras" subtitle="Stretches of months where the same artists ruled. Adjacent months with similar top-40 mixes are stitched together." state={eras}>
        {(rows) => rows.length === 0 ? <Muted>Your months don't cluster into eras — you change it up faster than the detector can follow.</Muted> : (
          <ol className="relative ml-3 border-l border-line pl-6">
            {rows.map((e) => (
              <li key={e.start} className="relative mb-5">
                <span className="absolute -left-[31px] top-1.5 h-2.5 w-2.5 rounded-full bg-amber" />
                <p className="num text-xs text-dust">{fmtDate(e.start, { month: 'short', year: 'numeric' })} → {fmtDate(e.end, { month: 'short', year: 'numeric' })} · {e.months} months · {fmtHours(e.hours)}{e.skipRate >= 0.18 ? ` · skipped ${Math.round(e.skipRate * 100)}%` : ''}{e.noveltyRate >= 0.5 ? ` · ${Math.round(e.noveltyRate * 100)}% new to you` : ''}</p>
                <p className="font-display text-2xl">{e.name}</p>
                <p className="mt-0.5 text-sm text-dust">{e.topArtists.map((a, i) => <span key={a.artistId}>{i > 0 ? (i === e.topArtists.length - 1 ? ' & ' : ', ') : ''}<Link to={artistHref(a.artistId)} className="hover:text-amber">{a.artist}</Link></span>)} · {seasonWord(e.start, e.end)}</p>
                <EraExport era={e} />
              </li>
            ))}
          </ol>
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
                  <li key={r.year} className="flex items-center gap-3 text-sm">
                    <span className="num w-10 text-dust">{r.year}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-moss/80" style={{ width: `${(r.stillPlayed / Math.max(r.discovered, 1)) * 100}%` }} /></div>
                    <span className="num w-24 text-right text-xs text-dust">{r.stillPlayed}/{r.discovered} · {fmtPct(r.stillPlayed / Math.max(r.discovered, 1))}</span>
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
  const endExcl = (() => { const d = new Date(era.end + 'T00:00:00'); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; })();
  if (tracks) return <div className="mt-2"><MakePlaylistButton small label={`Export era · ${tracks.length} tracks`} name={era.name} tracks={tracks} kind="insight" description={`${fmtDate(era.start, { month: 'short', year: 'numeric' })} → ${fmtDate(era.end, { month: 'short', year: 'numeric' })}. ${fmtHours(era.hours)}. Made with Deep Cuts.`} note={`era:${era.start}:${endExcl}`} poolRange={[era.start, endExcl]} /></div>;
  return <button onClick={() => spanTracks(era.start, endExcl, 30).then(setTracks)} className="mt-2 text-xs text-dust hover:text-amber">Export era as playlist</button>;
}
function seasonWord(start: string, end: string) {
  const m = Number(start.slice(5, 7)), e = Number(end.slice(5, 7));
  const s = (mm: number) => (mm === 12 || mm <= 2 ? 'winter' : mm <= 5 ? 'spring' : mm <= 8 ? 'summer' : 'autumn');
  const a = s(m), b = s(e);
  return a === b ? `${a}` : `${a} into ${b}`;
}
export { fmtInt };
