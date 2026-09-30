import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { confirmDialog, toast } from '@/components/Overlay';
import { invoke } from '@/lib/bridge';
import { useAsync, useFilter } from '@/lib/hooks';
import { localToday } from '@/lib/queries';
import { fmtStamp } from '@/lib/format';
import { fmtDuration, inflight, onJobsChange, writeWithModel, writings, type Writing } from '@/lib/llm';
import { ALL_TIME, periodFor, roastDossier, roastMessages, roastReceipts, type Heat, type Period } from '@/lib/roastQueries';

/**
 * Phase 9i — Roast Me (Stories). The receipts come from your record and work without any model.
 * Phase 10d: roast a year, a month or a week as well as the whole record; ~16 more niche receipts (streaks, 3 a.m.
 * anthems, the commute DJ, weekday-vs-weekend you, intros you can't sit through, what your lyrics are about…); the
 * local model gets a full dossier of the period — top artists, songs, albums, hours by day part and weekday, scenes,
 * tags, lyric moods and themes, new discoveries, plus the receipts — and is told to find the jokes *between* the facts.
 * Its routines are kept, like Liner Notes. It roasts the listening, never the listener.
 */
const HEATS: { id: Heat; label: string; blurb: string }[] = [
  { id: 'mild', label: 'Mild', blurb: 'a friend teasing' },
  { id: 'medium', label: 'Medium', blurb: 'playful, some bite' },
  { id: 'spicy', label: 'Spicy', blurb: 'comedy-club roast' },
];
const KINDS: { id: Period['kind']; label: string }[] = [{ id: 'all', label: 'All time' }, { id: 'year', label: 'A year' }, { id: 'month', label: 'A month' }, { id: 'week', label: 'A week' }];

export function RoastPage() {
  const { filter } = useFilter();
  const today = localToday();
  const [heat, setHeat] = useState<Heat>('medium');
  const [seed, setSeed] = useState(0);
  const [kind, setKind] = useState<Period['kind']>('all');
  const [anchor, setAnchor] = useState(today);
  const period = kind === 'all' ? ALL_TIME : periodFor(kind, anchor);
  const r = useAsync(() => roastReceipts(heat, seed, period), [filter, heat, seed, period.key]);
  const years: number[] = []; for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 12; y--) years.push(y);
  const step = (n: number) => { const d = new Date(anchor + 'T00:00:00'); if (kind === 'year') d.setFullYear(d.getFullYear() + n); else if (kind === 'month') d.setMonth(d.getMonth() + n); else d.setDate(d.getDate() + 7 * n); const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; if (s <= today) setAnchor(s); };

  return (
    <div className="mx-auto max-w-4xl">
      <Sleeve kicker="Stories · Roast Me" title={kind === 'all' ? 'Your record has notes' : `${period.label[0].toUpperCase()}${period.label.slice(1)} has notes`} meta="Everything below is true. That's what makes it hurt. Your music is fair game; you are not — this only ever roasts the listening." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="radiogroup" aria-label="Period">{KINDS.map((k) => <button key={k.id} role="radio" aria-checked={kind === k.id} onClick={() => setKind(k.id)} className={`rounded-full px-3 py-1.5 text-sm ${kind === k.id ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{k.label}</button>)}</div>
        {kind !== 'all' && (
          <div className="flex items-center gap-1 text-sm">
            <button onClick={() => step(-1)} className="px-2 text-dust hover:text-cream" aria-label="Earlier">‹</button>
            {kind === 'year' && <select value={anchor.slice(0, 4)} onChange={(e) => setAnchor(`${e.target.value}-06-15`)} className="rounded-lg border border-line bg-ink px-2 py-1" aria-label="Year">{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>}
            {kind === 'month' && <input type="month" value={anchor.slice(0, 7)} max={today.slice(0, 7)} onChange={(e) => e.target.value && setAnchor(`${e.target.value}-15`)} className="rounded-lg border border-line bg-ink px-2 py-1" aria-label="Month" />}
            {kind === 'week' && <input type="date" value={anchor} max={today} onChange={(e) => e.target.value && setAnchor(e.target.value)} className="rounded-lg border border-line bg-ink px-2 py-1" aria-label="A day in the week" />}
            <button onClick={() => step(1)} className="px-2 text-dust hover:text-cream" aria-label="Later">›</button>
            {kind === 'week' && <span className="text-xs text-dust">{period.label.replace('the week of ', '')}</span>}
          </div>
        )}
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Heat">
        {HEATS.map((h) => <button key={h.id} role="radio" aria-checked={heat === h.id} onClick={() => setHeat(h.id)} className={`rounded-full px-4 py-1.5 text-sm ${heat === h.id ? 'bg-coral text-ink' : 'border border-line text-dust hover:text-cream'}`} title={h.blurb}>{h.label}</button>)}
        <button onClick={() => setSeed((x) => x + 1)} className="ml-2 rounded-full border border-line px-3 py-1.5 text-xs text-dust hover:text-cream">Different jokes</button>
      </div>

      {r.error ? <ErrorBox message={r.error} /> : !r.data ? <Loading label="Reviewing the evidence…" /> : r.data.receipts.length === 0 ? (
        <Card title="Nothing to roast"><p className="text-sm text-dust">{kind === 'all' ? "Either your listening is flawless or there isn't enough of it yet. Import your history and come back." : 'Not enough listening in this period to build a case. Try a longer one.'}</p></Card>
      ) : (
        <>
          <p className="mb-4 font-display text-2xl italic text-dust">{r.data.opener}</p>
          <ol className="space-y-3">
            {r.data.receipts.map((x, i) => (
              <li key={x.id} className="rounded-2xl border border-line bg-surface p-4">
                <p className="font-display text-xl leading-snug"><span className="mr-2 text-coral">{i + 1}.</span>{x.line}</p>
                <p className="num mt-1 text-xs text-dust">the receipt: {x.link ? <Link to={x.link} className="underline hover:text-cream">{x.receipt}</Link> : x.receipt}</p>
              </li>
            ))}
          </ol>
          <p className="mt-5 rounded-2xl border border-moss/40 bg-moss/5 p-4 font-display text-xl leading-snug">{r.data.closer}</p>
        </>
      )}

      <section className="mt-8">{r.data && r.data.receipts.length > 0 && <ModelRoast heat={heat} period={period} data={r.data} />}</section>
    </div>
  );
}

function ModelRoast({ heat, period, data }: { heat: Heat; period: Period; data: Awaited<ReturnType<typeof roastReceipts>> }) {
  const periodKey = `${period.key}:${heat}`;
  const key = `roast:${periodKey}`;
  const [tick, setTick] = useState(0);
  const saved = useAsync(() => writings('roast', periodKey), [periodKey, tick]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, force] = useState(0);
  const job = inflight(key);
  const [now, setNow] = useState(Date.now());
  useEffect(() => onJobsChange(() => force((x) => x + 1)), []);
  useEffect(() => { setPickedId(null); setErr(null); }, [periodKey]);
  useEffect(() => { if (!job) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [job]);
  useEffect(() => { job?.promise.then((w) => { setPickedId(w.id); setTick((t) => t + 1); }).catch((e) => setErr(String(e))); }, [job]);
  const go = async () => {
    setErr(null);
    try {
      const dossier = await roastDossier(period, data.receipts, data.facts);
      writeWithModel({ key, kind: 'roast', periodKey, messages: roastMessages(heat, dossier), facts: dossier, temperature: heat === 'spicy' ? 0.95 : 0.8 });
      force((x) => x + 1);
    } catch (e) { setErr(String(e)); }
  };
  const list = saved.data ?? [];
  const current: Writing | undefined = list.find((w) => w.id === pickedId) ?? list[0];
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); toast('Copied.', 'ok'); } catch { /* blocked */ } };
  const del = async (w: Writing) => { if (!(await confirmDialog('Delete this routine?', { confirm: 'Delete' }))) return; await invoke('writing_delete', { id: w.id }); setPickedId(null); setTick((t) => t + 1); };
  return (
    <Card title="Roast me properly" subtitle={`Your local model writes a full routine about ${period.label} from a dossier of it — top artists, songs, albums, hours by day part and weekday, scenes, lyric moods and themes, new discoveries and every receipt above. Nothing leaves this machine; every routine is kept.`}
      aside={<button disabled={!!job} onClick={() => void go()} className="rounded-full bg-coral px-4 py-1.5 text-sm font-medium text-ink disabled:opacity-40">{job ? 'Warming up the mic…' : list.length ? 'New routine' : 'Roast me'}</button>}>
      {list.length > 1 && <div className="mb-3 flex flex-wrap gap-1.5 text-xs">{list.map((w, i) => <button key={w.id} onClick={() => setPickedId(w.id)} aria-pressed={current?.id === w.id} className={`rounded-full px-3 py-1 ${current?.id === w.id ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{i === 0 ? 'latest' : fmtStamp(w.createdAt)}</button>)}</div>}
      {job && <div className="mb-4 rounded-xl border border-coral/40 bg-coral/5 px-4 py-3 text-sm"><span className="text-coral">The comic is reading your dossier</span> <span className="num text-dust">· {fmtDuration(now - job.started)}</span><p className="mt-1 text-xs text-dust">Leave the page if you like — it keeps going and saves the routine. The time limit is in Settings → Local model.</p></div>}
      {err && <div className="mb-3"><ErrorBox message={err} /></div>}
      {current ? (
        <div>
          <div className="space-y-3 whitespace-pre-line text-[15px] leading-relaxed">{current.text}</div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-dust"><span>written by {current.model} · {heat} · {fmtStamp(current.createdAt)}{current.ms ? ` · took ${fmtDuration(current.ms)}` : ''}</span><button onClick={() => void copy(current.text)} className="hover:text-cream">copy</button><button onClick={() => void del(current)} className="hover:text-coral">delete</button></div>
        </div>
      ) : !job && !err && <p className="text-sm text-dust">Needs Ollama running with a model chosen in <Link to="/settings?tab=model" className="underline hover:text-cream">Settings → Local model</Link>. Without one, the receipts above are the whole show.</p>}
    </Card>
  );
}
