import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { composeNotes, dailyMinutes, mondayOf, notesPrompt, weekExtras, weekFacts, weeklyHours, type NoteLength } from '@/lib/notesQueries';
import { useAsync, useFilter } from '@/lib/hooks';
import { localToday } from '@/lib/queries';
import { artistHref, fmtHours, fmtInt, fmtPct, fmtStamp } from '@/lib/format';
import { fmtDuration, inflight, onJobsChange, writeWithModel, writings, writtenPeriods, type Writing } from '@/lib/llm';
import { invoke } from '@/lib/bridge';
import { C } from '@/lib/theme';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { confirmDialog, toast } from '@/components/Overlay';

/**
 * Liner Notes (INS-13, facts-first). Phase 10d: a calendar to pick any week (days tinted by minutes, weeks with a
 * written note marked), "Write with your local model" — it rephrases the week's facts, never changes a number — and
 * every version it writes is kept (llm_writings), so a week is written once and re-opened instantly. A slow machine
 * can take minutes: the job keeps running if you leave the page, and saves itself when it finishes.
 */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s: string, n: number) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };

export function NotesPage() {
  const { filter } = useFilter();
  const today = localToday();
  const [start, setStart] = useState(() => mondayOf(addDays(today, -7)));
  const [month, setMonth] = useState(() => start.slice(0, 7));
  const [tick, setTick] = useState(0);
  const { data: f, error } = useAsync(() => weekFacts(start), [start, filter]);
  const written = useAsync(() => writtenPeriods('notes'), [tick]);
  const pick = (ws: string) => { setStart(ws); setMonth(ws.slice(0, 7)); };
  const thisWeek = mondayOf(today);
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker={<>Stories · Liner Notes · week of {f?.label ?? '…'}</>}
        title={!f ? 'Writing…' : f.plays ? `${fmtHours(f.hours)}, ${f.topArtists[0] ? `mostly ${f.topArtists[0].artist}` : 'quietly'}` : 'A quiet week'}
        meta="A weekly note written from the numbers — by rules, or by your local model. The facts it draws on sit alongside so you can check every line." />
      <CalendarCard month={month} setMonth={setMonth} selected={start} onPick={pick} written={written.data ?? new Set()} thisWeek={thisWeek} />
      {error ? <ErrorBox message={error} /> : !f ? <Loading label="Reading the week…" /> : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[1.45fr_1fr]">
          <NoteCard key={start} weekStart={start} facts={f} onSaved={() => setTick((t) => t + 1)} />
          <Card title="Fact sheet">
            <ul className="num space-y-1.5 text-sm text-dust">
              <li>hours <span className="text-cream">{fmtHours(f.hours)}</span> · last week {fmtHours(f.prevHours)}</li>
              <li>plays <span className="text-cream">{fmtInt(f.plays)}</span> · days {f.days} · artists {fmtInt(f.artists)} · new {f.newArtists}</li>
              <li>skip rate <span className="text-cream">{fmtPct(f.skipRate)}</span> · last week {fmtPct(f.prevSkipRate)} · late {fmtPct(f.lateShare)}</li>
              {f.topArtists.map((a, i) => <li key={a.artistId}>#{i + 1} <Link to={artistHref(a.artistId)} className="text-cream hover:text-amber">{a.artist}</Link> {fmtHours(a.hours)}{a.prevRank ? ` (was #${a.prevRank})` : ' (new)'}</li>)}
              {f.topTrack && <li>top track <span className="text-cream">{f.topTrack.track}</span> {f.topTrack.plays}×</li>}
              {f.obsession && <li>obsession <span className="text-cream">{f.obsession.artist}</span> {f.obsession.plays} vs usual {f.obsession.usual.toFixed(1)}/wk</li>}
              {f.comebacks.map((c) => <li key={c.artistId}>comeback <Link to={artistHref(c.artistId)} className="text-cream hover:text-amber">{c.artist}</Link> after {c.daysSilent} d</li>)}
              {f.loudestDay && <li>loudest <Link to={`/day/${f.loudestDay.day}`} className="text-cream hover:text-amber">{f.loudestDay.day}</Link> {fmtInt(f.loudestDay.minutes)} min</li>}
              {f.milestones.map((m, i) => <li key={i}>milestone · {m.description}</li>)}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- calendar
function CalendarCard({ month, setMonth, selected, onPick, written, thisWeek }: { month: string; setMonth: (m: string) => void; selected: string; onPick: (ws: string) => void; written: Set<string>; thisWeek: string }) {
  const { filter } = useFilter();
  const year = Number(month.slice(0, 4));
  const first = new Date(month + '-01T00:00:00');
  const gridStart = mondayOf(month + '-01');
  const nextMonth = iso(new Date(first.getFullYear(), first.getMonth() + 1, 1));
  const gridEnd = addDays(mondayOf(addDays(nextMonth, -1)), 7);
  const days = useAsync(() => dailyMinutes(gridStart, gridEnd), [gridStart, gridEnd, filter]);
  const weeks = useAsync(() => weeklyHours(year), [year, filter]);
  const shift = (n: number) => setMonth(iso(new Date(first.getFullYear(), first.getMonth() + n, 1)).slice(0, 7));
  const rows: string[][] = [];
  for (let w = gridStart; w < gridEnd; w = addDays(w, 7)) rows.push([0, 1, 2, 3, 4, 5, 6].map((i) => addDays(w, i)));
  const maxDay = Math.max(30, ...Object.values(days.data ?? {}));
  const strip = useMemo(() => { const out: string[] = []; for (let w = mondayOf(`${year}-01-01`); w < `${year + 1}-01-01`; w = addDays(w, 7)) out.push(w); return out; }, [year]);
  const maxWeek = Math.max(1, ...Object.values(weeks.data ?? {}));
  const today = localToday();
  const monthName = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return (
    <Card title="Pick a week" subtitle="Days are tinted by how much you listened; a pen marks weeks your local model has already written up." aside={
      <div className="flex items-center gap-1 text-sm">
        <button onClick={() => shift(-12)} className="rounded-full px-2 text-dust hover:text-cream" aria-label="Previous year">«</button>
        <button onClick={() => shift(-1)} className="rounded-full px-2 text-dust hover:text-cream" aria-label="Previous month">‹</button>
        <span className="w-36 text-center font-display text-lg">{monthName}</span>
        <button onClick={() => shift(1)} className="rounded-full px-2 text-dust hover:text-cream" aria-label="Next month">›</button>
        <button onClick={() => shift(12)} className="rounded-full px-2 text-dust hover:text-cream" aria-label="Next year">»</button>
        <button onClick={() => onPick(thisWeek)} className="ml-2 rounded-full border border-line px-3 py-0.5 text-xs text-dust hover:text-cream">this week</button>
      </div>}>
      <div className="mb-5" aria-label={`Weeks of ${year}`}>
        <div className="flex h-10 items-end gap-[2px]">
          {strip.map((w) => {
            const h = weeks.data?.[w] ?? 0; const on = w === selected; const future = w > today;
            return <button key={w} onClick={() => !future && onPick(w)} disabled={future} title={`Week of ${w}: ${fmtHours(h)}${written.has(w) ? ' · written' : ''}`} className="relative flex-1 rounded-t-sm transition-opacity hover:opacity-100"
              style={{ height: `${Math.max(6, (h / maxWeek) * 100)}%`, background: on ? C.coral : written.has(w) ? C.amber : C.dust, opacity: future ? 0.12 : on ? 1 : written.has(w) ? 0.85 : 0.35 }} />;
          })}
        </div>
        <div className="num mt-1 flex justify-between text-[10px] text-dust">{['Jan', 'Apr', 'Jul', 'Oct', 'Dec'].map((m) => <span key={m}>{m}</span>)}</div>
      </div>
      <div className="grid grid-cols-[repeat(7,minmax(0,1fr))] gap-1.5 text-center text-[11px] text-dust">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d}>{d}</span>)}</div>
      <div className="mt-1 space-y-1.5">
        {rows.map((wk) => {
          const ws = wk[0]; const on = ws === selected; const future = ws > today;
          const hrs = wk.reduce((a, d) => a + (days.data?.[d] ?? 0), 0) / 60;
          return (
            <button key={ws} disabled={future} onClick={() => onPick(ws)} className={`group relative grid w-full grid-cols-[repeat(7,minmax(0,1fr))] gap-1.5 rounded-xl p-1 transition ${on ? 'bg-coral/10 ring-1 ring-coral' : future ? 'opacity-30' : 'hover:bg-raised/60'}`} aria-pressed={on} aria-label={`Week of ${ws}, ${fmtHours(hrs)}`}>
              {wk.map((d) => {
                const m = days.data?.[d] ?? 0; const inMonth = d.slice(0, 7) === month; const t = Math.sqrt(Math.min(1, m / maxDay));
                return (
                  <span key={d} className={`relative flex h-11 flex-col items-start justify-between rounded-lg px-1.5 py-1 text-left ${inMonth ? '' : 'opacity-40'}`} style={{ background: `color-mix(in srgb, ${C.amber} ${Math.round(t * 55)}%, ${C.raised})` }} title={`${d}: ${fmtInt(m)} min`}>
                    <span className={`num text-[11px] ${d === today ? 'rounded-full bg-cream px-1 text-ink' : 'text-cream'}`}>{Number(d.slice(8))}</span>
                    {m > 0 && <span className="num text-[9px] text-cream/70">{m >= 60 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m)}m`}</span>}
                  </span>
                );
              })}
              {written.has(ws) && <span className="absolute -right-1 -top-1 rounded-full bg-amber px-1.5 text-[10px] text-ink" title="Written by your local model">✎</span>}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the note
function NoteCard({ weekStart, facts, onSaved }: { weekStart: string; facts: Awaited<ReturnType<typeof weekFacts>>; onSaved: () => void }) {
  const [tick, setTick] = useState(0);
  const saved = useAsync(() => writings('notes', weekStart), [weekStart, tick]);
  const [view, setView] = useState<string | 'rules' | null>(null);    // writing id, 'rules', or null = default
  const [length, setLength] = useState<NoteLength>('standard');
  const [err, setErr] = useState<string | null>(null);
  const [, force] = useState(0);
  const key = `notes:${weekStart}`;
  const job = inflight(key);
  useEffect(() => onJobsChange(() => force((x) => x + 1)), []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!job) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [job]);
  useEffect(() => { job?.promise.then((w) => { setView(w.id); setTick((t) => t + 1); onSaved(); }).catch((e) => setErr(String(e))); }, [job]); // eslint-disable-line react-hooks/exhaustive-deps

  const write = async () => {
    setErr(null);
    try {
      const extras = await weekExtras(weekStart);
      const p = notesPrompt(facts, extras, length);
      writeWithModel({ key, kind: 'notes', periodKey: weekStart, messages: p.messages, facts: p.facts, temperature: 0.6, numPredict: p.numPredict });
      force((x) => x + 1);
    } catch (e) { setErr(String(e)); }
  };
  const list = saved.data ?? [];
  const current: Writing | undefined = view === 'rules' ? undefined : list.find((w) => w.id === view) ?? list[0];
  const rules = composeNotes(facts);
  const del = async (w: Writing) => { if (!(await confirmDialog('Delete this version of the note?', { confirm: 'Delete' }))) return; await invoke('writing_delete', { id: w.id }); setView(null); setTick((t) => t + 1); onSaved(); };
  const pin = async (w: Writing) => { await invoke('writing_pin', { id: w.id, pinned: !w.pinned }); setTick((t) => t + 1); toast(w.pinned ? 'Unpinned.' : 'Pinned — this version opens first.', 'ok'); };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast('Copied.', 'ok'); } catch { /* blocked */ } };
  return (
    <Card title="The note" aside={
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select value={length} onChange={(e) => setLength(e.target.value as NoteLength)} disabled={!!job} className="rounded-lg border border-line bg-ink px-2 py-1" aria-label="Length"><option value="short">short</option><option value="standard">standard</option><option value="long">long</option></select>
        <button disabled={!!job || facts.plays === 0} onClick={() => void write()} className="rounded-full bg-amber px-4 py-1.5 text-sm font-medium text-ink disabled:opacity-40">{job ? 'Writing…' : list.length ? 'Write another version' : 'Write with your local model'}</button>
      </div>}>
      {(list.length > 0) && (
        <div className="mb-4 flex flex-wrap gap-1.5 text-xs" role="tablist" aria-label="Versions">
          {list.map((w, i) => <button key={w.id} role="tab" aria-selected={current?.id === w.id} onClick={() => setView(w.id)} className={`rounded-full px-3 py-1 ${current?.id === w.id ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{w.pinned ? '★ ' : ''}{i === 0 && !w.pinned ? 'latest' : fmtStamp(w.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</button>)}
          <button role="tab" aria-selected={view === 'rules'} onClick={() => setView('rules')} className={`rounded-full px-3 py-1 ${view === 'rules' ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>from the numbers</button>
        </div>
      )}
      {job && <div className="mb-4 rounded-xl border border-amber/40 bg-amber/5 px-4 py-3 text-sm"><span className="text-amber">Your model is writing this week up</span> <span className="num text-dust">· {fmtDuration(now - job.started)}</span><p className="mt-1 text-xs text-dust">You can leave this page — it keeps going and saves itself. On a slow machine this can take a few minutes; the limit is in Settings → Local model.</p></div>}
      {err && <div className="mb-4"><ErrorBox message={err} /></div>}
      {current ? (
        <>
          <div className="space-y-4 whitespace-pre-line font-display text-lg leading-relaxed">{current.text}</div>
          <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-dust">
            <span>written by <span className="text-cream">{current.model}</span> · {fmtStamp(current.createdAt)}{current.ms ? ` · took ${fmtDuration(current.ms)}` : ''}</span>
            <button onClick={() => void copy(current.text)} className="hover:text-cream">copy</button>
            <button onClick={() => void pin(current)} className="hover:text-cream">{current.pinned ? 'unpin' : 'pin'}</button>
            <button onClick={() => void del(current)} className="hover:text-coral">delete</button>
          </div>
          <p className="mt-2 text-[11px] text-dust/70">Saved on this machine, so this week never needs writing again. The model saw only the fact sheet (and the week's songs, moods, scenes and weather); check any line against it.</p>
        </>
      ) : (
        <>
          <div className="space-y-4 font-display text-lg leading-relaxed">{rules.map((n, i) => <p key={i}>{n}</p>)}</div>
          <p className="mt-6 text-xs text-dust">{list.length ? 'Composed by rules from the same facts.' : 'Composed by rules. “Write with your local model” turns the same facts into a column — it may rephrase, it never changes a number — and keeps it.'}</p>
        </>
      )}
    </Card>
  );
}
