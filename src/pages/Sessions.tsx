import { C } from '@/lib/theme';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DEFAULT_SESSION_FILTERS, PAGE, getSessionDetail, getSessionsOverview, listSessions, type SessionFilters } from '@/lib/sessionQueries';
import { useAsync, useDebounced, useFilter } from '@/lib/hooks';
import { QueueButton } from '@/components/QueueButton';
import { chaosColor, chaosWord } from '@/components/Lists';
const sceneHue = (sc: string) => { let h = 0; for (const c of sc) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
import { DAY_PART_LABELS, SHAPE_LABELS, SHAPE_RULES, artistHref, fmtDate, fmtHours, fmtInt, fmtMs, fmtPct, fmtTime, trackHref } from '@/lib/format';
import { Card, Empty, ErrorBox, Loading, Sleeve, StatCard } from '@/components/Card';
import { invoke } from '@/lib/bridge';
import { SessionCard, ShapeDot } from '@/components/Lists';
import { SessionShapes } from '@/components/charts/SessionShapes';
import { WeekHourHeatmap } from '@/components/charts/WeekHourHeatmap';
import { Histogram, RateBars, StackedYears, YearLines } from '@/components/charts/Bars';

const SHAPE_KEYS = Object.keys(SHAPE_LABELS);
const shapeColors = Object.fromEntries(SHAPE_KEYS.map((k) => [k, SHAPE_LABELS[k].color]));
const shapeLabels = Object.fromEntries(SHAPE_KEYS.map((k) => [k, SHAPE_LABELS[k].label]));
const mins = (m: number) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);

export function SessionsPage() {
  const { id } = useParams();
  if (id) return <SessionDetailPage id={id} />;
  return <SessionsOverviewPage />;
}

function SessionsOverviewPage() {
  const { filter } = useFilter();
  const [f, setF] = useState<SessionFilters>(DEFAULT_SESSION_FILTERS);
  const [qText, setQText] = useState('');
  const dq = useDebounced(qText, 300);
  useEffect(() => { setF((cur) => (cur.q === dq ? cur : { ...cur, q: dq, page: 0 })); }, [dq]);
  const [heatMetric, setHeatMetric] = useState<'sessions' | 'minutes'>('sessions');
  const ov = useAsync(getSessionsOverview, [filter]);
  const list = useAsync(() => listSessions(f), [f, filter]);
  const o = ov.data;

  const shapeYears = useMemo(() => {
    if (!o) return [];
    const m = new Map<number, Record<string, number>>();
    for (const r of o.shapesByYear) { if (!m.has(r.year)) m.set(r.year, {}); m.get(r.year)![r.shape] = r.count; }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([year, values]) => ({ year, values }));
  }, [o]);
  const attentionYears = useMemo(() => (o ? o.byYear.map((y) => ({ year: y.year, values: { attended: Math.round(y.attendedHours), unattended: Math.round(y.unattendedHours) } })) : []), [o]);

  if (ov.error) return <ErrorBox message={ov.error} />;
  if (!o) return <Loading />;
  const totalAtt = o.attention.active + o.attention.drifting + o.attention.unattended || 1;
  const set = (patch: Partial<SessionFilters>) => setF({ ...f, ...patch, page: 0 });

  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Sessions" title="How you listen"
        meta={<>{fmtInt(o.count)} sessions of two or more plays · median {mins(o.medianMin)} · one in ten runs past {mins(o.p90Min)} · {fmtInt(o.marathonCount)} marathons of 3 h+</>}>
        <p className="mt-4 max-w-2xl text-sm text-dust">
          A session is a run of plays with no long gap: 30 minutes, 45 late at night, an hour in the car. Each one gets a shape from how you behaved inside it — skips, repeats, new songs, one artist or many.
        </p>
      </Sleeve>

      <section className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
        <StatCard label="Completion" value={fmtPct(o.completion)} footnote="how much of each song you let play" accent />
        <StatCard label="Skip rate" value={fmtPct(o.skipRate)} footnote="plays ended with a skip" />
        <StatCard label="Novelty" value={fmtPct(o.noveltyRate)} footnote="plays that were first-ever plays" />
        <StatCard label="Repeats" value={fmtPct(o.repeatRate)} footnote="same song straight again" />
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-[1fr_1.3fr]">
        <Card title="Shapes" subtitle="Click a shape to list those sessions below." aside={<span className="num text-xs text-dust">{fmtInt(o.count)} total</span>}>
          <SessionShapes data={o.shapes} onPick={(shape) => { set({ shape: f.shape === shape ? null : shape }); document.getElementById('explorer')?.scrollIntoView({ behavior: 'smooth' }); }} />
        </Card>
        <Card title="Shapes by year" subtitle="Share of sessions. Watch a taste change habits.">
          <StackedYears rows={shapeYears} keys={SHAPE_KEYS} colors={shapeColors} labels={shapeLabels} />
          <details className="mt-4 text-xs text-dust">
            <summary className="cursor-pointer hover:text-cream">How shapes are decided</summary>
            <p className="mt-2">A session is a run of plays with no gap longer than 30 minutes (45 after 11 PM, 60 in the car; a device switch within 5 minutes stays in the same session). Then the first matching rule, top to bottom, gives it a shape:</p>
            <ol className="mt-2 space-y-1">{SHAPE_RULES.map((r) => <li key={r.shape} className="flex gap-2"><ShapeDot shape={r.shape} /><span><span className="text-cream">{SHAPE_LABELS[r.shape].label}</span> — {r.rule}</span></li>)}</ol>
            <p className="mt-2">Novelty = first-ever plays. Entropy = how spread out the artists are (0 bits = one artist; 3 bits ≈ eight artists evenly). Skips = ended with the forward or back button.</p>
          </details>
        </Card>
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-[1.3fr_1fr]">
        <Card title="When sessions start" subtitle="Weekday × hour."
          aside={<div className="flex overflow-hidden rounded-full border border-line text-xs">{(['sessions', 'minutes'] as const).map((m) => <button key={m} onClick={() => setHeatMetric(m)} className={`px-3 py-1 ${heatMetric === m ? 'bg-raised text-cream' : 'text-dust'}`}>{m}</button>)}</div>}>
          <WeekHourHeatmap data={o.heat} metric={heatMetric} />
        </Card>
        <Card title="How long they run" subtitle={`Median ${mins(o.medianMin)}. The tail on the right is the marathons.`}>
          <Histogram data={o.lengthHist.map((h) => ({ label: h.bucket, value: h.count }))} highlight={(i) => o.lengthHist[i].lo >= 180} />
        </Card>
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-2">
        <Card title="Attention" subtitle="Hours you were around for vs. autoplay running on without you.">
          <div className="flex h-3 overflow-hidden rounded-full bg-raised">
            <div className="bg-amber" style={{ width: `${(o.attention.active / totalAtt) * 100}%` }} title={`active ${fmtHours(o.attention.active)}`} />
            <div className="bg-amber/50" style={{ width: `${(o.attention.drifting / totalAtt) * 100}%` }} title={`drifting ${fmtHours(o.attention.drifting)}`} />
            <div className="bg-violet/70" style={{ width: `${(o.attention.unattended / totalAtt) * 100}%` }} title={`unattended ${fmtHours(o.attention.unattended)}`} />
          </div>
          <ul className="num mt-3 grid grid-cols-3 gap-2 text-xs text-dust">
            <li><span className="inline-block h-2 w-2 rounded-full bg-amber" /> Active · {fmtHours(o.attention.active)}</li>
            <li><span className="inline-block h-2 w-2 rounded-full bg-amber/50" /> Drifting · {fmtHours(o.attention.drifting)}</li>
            <li><span className="inline-block h-2 w-2 rounded-full bg-violet/70" /> Unattended · {fmtHours(o.attention.unattended)}</li>
          </ul>
          <div className="mt-5"><StackedYears rows={attentionYears} keys={['attended', 'unattended']} colors={{ attended: C.amber, unattended: C.violet }} labels={{ attended: 'Hours you were there for', unattended: 'Autoplay without you' }} /></div>
          <p className="mt-3 text-xs text-dust">Unattended = no click, skip, back, app open or stop for longer than the attention gap (Settings, default 120 min). The Attentive lens at the top hides those plays everywhere.</p>
        </Card>
        <Card title="Your patience, year by year" subtitle="Completion, skip rate and novelty per session, averaged.">
          <YearLines rows={o.byYear} series={[
            { key: 'c', label: 'Completion', color: C.amber, values: o.byYear.map((y) => y.completion), format: fmtPct },
            { key: 's', label: 'Skip rate', color: C.coral, values: o.byYear.map((y) => y.skipRate), format: fmtPct },
            { key: 'n', label: 'Novelty', color: C.moss, values: o.byYear.map((y) => y.noveltyRate), format: fmtPct },
          ]} />
          <ul className="num mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-dust sm:grid-cols-3">
            {o.byYear.map((y) => <li key={y.year}>{y.year} · {fmtInt(y.sessions)} sessions · median {mins(y.medianMin)}</li>)}
          </ul>
        </Card>
      </section>

      <section className="mt-6">
        <Card title="Chaos" subtitle={`How jarring your genre jumps are, session by session — the average tag-vector distance between consecutive artists (0 coherent, 1 jarring). Scored for ${fmtPct(o.chaosCoverage)} of sessions; the rest need tags.`}>
          {o.chaosByYear.length === 0 && o.chaosByDayPart.length === 0 ? <p className="text-sm text-dust">No scored sessions yet — connect Last.fm or MusicBrainz and rebuild.</p> : (
            <div className="grid gap-6 md:grid-cols-3">
              <div><p className="mb-2 text-xs text-dust">By year — more or less coherent over time</p>{o.chaosByYear.length > 1 ? <YearLines rows={o.chaosByYear} series={[{ key: 'c', label: 'Chaos', color: C.coral, values: o.chaosByYear.map((y) => y.chaos), format: (v) => v.toFixed(2) }]} /> : <p className="text-sm text-dust">Needs two years.</p>}</div>
              <div><p className="mb-2 text-xs text-dust">By time of day</p><RateBars data={['morning', 'midday', 'evening', 'night', 'late'].map((k) => o.chaosByDayPart.find((d) => d.dayPart === k)).filter(Boolean).map((d) => ({ label: DAY_PART_LABELS[d!.dayPart], value: d!.chaos, note: `${fmtInt(d!.sessions)} sessions` }))} format={(v) => v.toFixed(2)} /></div>
              <div><p className="mb-2 text-xs text-dust">By shape — album rides should sit low, shuffle wanders high</p><RateBars data={o.chaosByShape.map((x) => ({ label: SHAPE_LABELS[x.shape]?.label ?? x.shape, value: x.chaos, note: `${fmtInt(x.sessions)} sessions` }))} format={(v) => v.toFixed(2)} /></div>
            </div>
          )}
        </Card>
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-2">
        <Card title="Skip forensics" subtitle="Where and when you bail.">
          <p className="mb-2 text-xs text-dust">By time of day</p>
          <RateBars data={['morning', 'midday', 'evening', 'night', 'late'].map((k) => o.skipByDayPart.find((d) => d.dayPart === k)).filter(Boolean).map((d) => ({ label: DAY_PART_LABELS[d!.dayPart], value: d!.skipRate, note: `${fmtInt(d!.plays)} plays` }))} format={fmtPct} />
          <p className="mb-2 mt-5 text-xs text-dust">By device</p>
          <RateBars data={o.skipByPlatform.map((p) => ({ label: p.platform, value: p.skipRate, note: `${fmtInt(p.plays)} plays` }))} format={fmtPct} />
        </Card>
        <Card title="Gateways and closers" subtitle="The songs you use to start, and the ones you end on.">
          <div className="grid gap-6 sm:grid-cols-2">
            <Edge title="Opens the most sessions" rows={o.openers} />
            <Edge title="Closes the most sessions" rows={o.closers} />
            <Edge title="Starts your mornings" rows={o.morningOpeners} />
            <Edge title="You fall asleep to" rows={o.lateClosers} />
          </div>
        </Card>
      </section>

      <div id="explorer" className="mt-10">
        <Card title="Every session" subtitle="Filter, sort, open."
          aside={<span className="num text-xs text-dust">{list.data ? `${fmtInt(list.data.total)} match` : ''}</span>}>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
            <Sel value={f.shape ?? ''} onChange={(v) => set({ shape: v || null })} label="Any shape" options={SHAPE_KEYS.map((k) => [k, SHAPE_LABELS[k].label])} />
            <Sel value={f.dayPart ?? ''} onChange={(v) => set({ dayPart: v || null })} label="Any time of day" options={Object.entries(DAY_PART_LABELS)} />
            <Sel value={f.platform ?? ''} onChange={(v) => set({ platform: v || null })} label="Any device" options={o.platforms.map((p) => [p, p])} />
            <Sel value={f.attention ?? ''} onChange={(v) => set({ attention: v || null })} label="Any attention" options={[['active', 'Active'], ['drifting', 'Drifting'], ['unattended', 'Unattended']]} />
            <Sel value={String(f.minTracks)} onChange={(v) => set({ minTracks: Number(v) })} label="" options={[['1', '1+ plays'], ['3', '3+ plays'], ['6', '6+ plays'], ['12', '12+ plays'], ['30', '30+ plays']]} />
            <Sel value={f.sort} onChange={(v) => set({ sort: v as SessionFilters['sort'] })} label="" options={[['recent', 'Most recent'], ['oldest', 'Oldest first'], ['longest', 'Longest'], ['most_tracks', 'Most plays'], ['skippiest', 'Skippiest'], ['chaotic', 'Most chaotic'], ['smoothest', 'Smoothest']]} />
            <input value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Artist or track in the session" className="rounded-full border border-line bg-transparent px-3 py-1.5 text-dust placeholder:text-dust/60 focus:text-cream" />
            {(f.shape || f.dayPart || f.platform || f.attention || f.q) && <button onClick={() => { setQText(''); setF(DEFAULT_SESSION_FILTERS); }} className="text-dust hover:text-cream">clear</button>}
          </div>
          {list.error ? <ErrorBox message={list.error} /> : !list.data ? <Loading label="Listing…" /> : list.data.rows.length === 0 ? <Empty>No sessions match.</Empty> : (
            <>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {list.data.rows.map((s) => <SessionCard key={s.sessionId} s={s} href={`/sessions/${s.sessionId}`} />)}
              </div>
              <div className="num mt-4 flex items-center justify-between text-xs text-dust">
                <button disabled={f.page === 0} onClick={() => setF({ ...f, page: f.page - 1 })} className="disabled:opacity-30 hover:text-cream">← previous</button>
                <span>page {f.page + 1} of {Math.max(1, Math.ceil(list.data.total / PAGE))}</span>
                <button disabled={(f.page + 1) * PAGE >= list.data.total} onClick={() => setF({ ...f, page: f.page + 1 })} className="disabled:opacity-30 hover:text-cream">next →</button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function Sel({ value, onChange, label, options }: { value: string; onChange: (v: string) => void; label: string; options: (readonly [string, string])[] | string[][] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-full border border-line bg-transparent px-3 py-1.5 text-dust hover:text-cream">
      {label && <option value="">{label}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function Edge({ title, rows }: { title: string; rows: { trackId: string; track: string; artist: string; count: number }[] }) {
  return (
    <div>
      <p className="text-xs text-dust">{title}</p>
      {rows.length ? <ul className="mt-1 divide-y divide-line/60 text-sm">{rows.slice(0, 5).map((r) => <li key={r.trackId} className="flex justify-between gap-3 py-1.5"><Link to={trackHref(r.trackId)} className="truncate hover:text-amber">{r.track}<span className="ml-2 text-xs text-dust">{r.artist}</span></Link><span className="num shrink-0 text-xs text-dust">{r.count}×</span></li>)}</ul> : <p className="mt-1 text-sm text-dust">—</p>}
    </div>
  );
}

function SessionDetailPage({ id }: { id: string }) {
  const nav = useNavigate();
  const { data: d, error, loading } = useAsync(() => getSessionDetail(id), [id]);
  if (error) return <ErrorBox message={error} />;
  if (loading && !d) return <Loading />;
  if (!d) return <Empty>That session isn't in the record any more (sessions are rebuilt after every import).</Empty>;
  const s = d.session;
  const meta = SHAPE_LABELS[s.shape] ?? { label: s.shape, note: '' };
  const durMin = (new Date(s.endAt.replace(' ', 'T')).getTime() - new Date(s.startAt.replace(' ', 'T')).getTime()) / 60000;
  const maxMs = Math.max(...d.plays.map((p) => p.msPlayed), 1);
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker={<><button onClick={() => nav(-1)} className="hover:text-amber">← back</button> · <Link to={`/day/${s.startAt.slice(0, 10)}`} className="hover:text-amber">{fmtDate(s.startAt)}</Link> · {DAY_PART_LABELS[s.dayPart]}{s.platform ? ` · ${s.platform}` : ''}</>}
        title={<span className="flex items-center gap-3"><ShapeDot shape={s.shape} />{meta.label}<span className="text-2xl text-dust">· {fmtTime(s.startAt)} → {fmtTime(s.endAt)}</span></span>}
        meta={<>{mins(durMin)} on the clock · {fmtHours(s.totalMs / 3600000)} of music · {s.trackCount} plays · {s.uniqueArtists} artists · {s.skipCount} skips · {s.interactions} interactions{s.attention !== 'active' ? <span className="text-violet"> · {s.attention}: {fmtHours(s.unattendedMs / 3600000)} unattended</span> : null}</>}>
        <p className="mt-3 text-sm text-dust">{meta.note}.</p>
        <div className="mt-3 flex gap-3 text-xs">
          {s.attention !== 'unattended' ? <button onClick={() => invoke('set_session_attention', { startAt: s.startAt, attention: 'unattended' })} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream">Mark unattended</button>
            : <button onClick={() => invoke('set_session_attention', { startAt: s.startAt, attention: 'active' })} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream">Mark as listened</button>}
          <span className="text-dust/70">Recomputes the record; the Attentive lens follows.</span>
        </div>
      </Sleeve>
      <section className="grid gap-4 sm:grid-cols-2 md:grid-cols-5">
        <StatCard label="Completion" value={fmtPct(s.completionRate)} footnote={s.completionSource === 'duration' ? 'from real lengths' : s.completionSource === 'estimate' ? 'from your longest full plays' : 'from skip rate'} />
        <StatCard label="Skip rate" value={fmtPct(s.skipRate)} />
        <StatCard label="Novelty" value={fmtPct(s.noveltyRate)} footnote="first-ever plays" />
        <StatCard label="Repeats" value={fmtPct(s.repeatRate)} />
        <StatCard label="Variety" value={s.artistEntropy.toFixed(1)} footnote="artist entropy, bits" />
      </section>
      {s.chaos != null && (
        <section className="mt-4 rounded-2xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-sm"><span className="font-display text-xl" style={{ color: chaosColor(s.chaos) }}>{s.chaos.toFixed(2)}</span> <span className="text-dust">chaos · {chaosWord(s.chaos)}</span></p><p className="text-xs text-dust">Each segment is one play, coloured by the artist's scene family; a colour change is a genre jump. Chaos is the average tag-vector distance across those jumps.</p></div>
          <div className="mt-3 flex h-6 w-full overflow-hidden rounded-md" role="img" aria-label="Genre transitions play by play">
            {d.plays.map((p) => <span key={p.position} title={`${p.track} — ${p.artist}${p.scene ? ` · ${p.scene}` : ' · no scene'}`} className="min-w-[2px] flex-1 border-r border-ink/60" style={{ background: p.scene ? `hsl(${sceneHue(p.scene)} 40% 45%)` : 'transparent', backgroundImage: p.scene ? undefined : 'repeating-linear-gradient(45deg, transparent 0 3px, rgba(255,255,255,.08) 3px 6px)' }} />)}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dust">{[...new Set(d.plays.map((p) => p.scene).filter(Boolean))].map((sc) => <span key={sc} className="flex items-center gap-1 capitalize"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: `hsl(${sceneHue(sc!)} 40% 45%)` }} />{sc!.replace('-', ' ')}</span>)}{d.plays.some((p) => !p.scene) && <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm border border-line" />no scene yet</span>}</div>
        </section>
      )}
      <section className="mt-6 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <Card title="Run-through" subtitle="Bar length is how long each play ran. Red is a skip, violet is autoplay you weren't there for.">
          <ol className="divide-y divide-line/60">
            {d.plays.map((p) => (
              <li key={p.position} className={`flex items-center gap-3 py-1.5 text-sm ${!p.attended ? 'text-dust' : ''}`}>
                <span className="num w-6 shrink-0 text-right text-xs text-dust">{p.position}</span>
                <span className="num w-16 shrink-0 text-xs text-dust">{fmtTime(p.playedAt)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    {p.trackId ? <Link to={trackHref(p.trackId)} className={`truncate hover:text-amber ${p.skipped ? 'line-through decoration-coral/60' : ''}`}>{p.track}</Link> : <span className="truncate">{p.track}</span>}
                    {p.isFirstPlay && <span className="shrink-0 text-[10px] text-moss">first play</span>}
                  </div>
                  <div className="flex items-baseline gap-2 text-xs text-dust">
                    {p.artistId ? <Link to={artistHref(p.artistId)} className="truncate hover:text-amber">{p.artist}</Link> : <span className="truncate">{p.artist}</span>}
                    {p.startReason && p.startReason !== 'trackdone' && <span className="text-dust/60">· {p.startReason}</span>}
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full" style={{ width: `${(p.msPlayed / maxMs) * 100}%`, background: p.skipped ? C.coral : p.attended ? C.amber : C.violet }} /></div>
                </div>
                <span className="num w-12 shrink-0 text-right text-xs text-dust">{fmtMs(p.msPlayed)}</span>
                <QueueButton trackId={p.trackId} />
              </li>
            ))}
          </ol>
        </Card>
        <Card title="Who was in it">
          <ul className="space-y-2 text-sm">{d.artists.map((a) => <li key={a.artistId} className="flex justify-between"><Link to={artistHref(a.artistId)} className="truncate hover:text-amber">{a.artist}</Link><span className="num text-xs text-dust">{a.plays} plays</span></li>)}</ul>
        </Card>
      </section>
    </div>
  );
}
