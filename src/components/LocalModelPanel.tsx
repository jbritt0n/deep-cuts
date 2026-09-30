import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke } from '@/lib/bridge';
import { useAsync, useSettings } from '@/lib/hooks';
import { callStats, fmtDuration, recentCalls, type TestReply } from '@/lib/llm';
import { currentModel, type LlmStatus } from '@/lib/ask';
import { fmtInt, fmtStamp } from '@/lib/format';
import { loadSettings } from '@/lib/settings';
import { Card, ErrorBox } from '@/components/Card';
import { confirmDialog, toast } from '@/components/Overlay';

/**
 * Phase 10d — Settings → Local model. One place for everything Ollama: where it is, which model, how long it may take,
 * how much it holds in mind, what it's used for, and a log of how long each job actually took on this machine.
 * Values are read by the Rust controller on every call (llm.rs `LlmConfig`), so a change applies to the next request.
 */
type Knob = { key: string; label: string; def: number; options: { v: number; l: string }[]; why: string };
const KNOBS: Knob[] = [
  { key: 'llm_timeout_s', label: 'Timeout per reply', def: 900, why: 'How long one answer may take before Deep Cuts gives up. On an older CPU a lyric tag or a Liner Note can take several minutes; the old fixed limit was 240 s.',
    options: [{ v: 120, l: '2 min' }, { v: 240, l: '4 min' }, { v: 600, l: '10 min' }, { v: 900, l: '15 min' }, { v: 1800, l: '30 min' }, { v: 3600, l: '1 hour' }, { v: 7200, l: '2 hours' }] },
  { key: 'llm_num_ctx', label: 'Context window', def: 4096, why: 'How many tokens the model holds in mind (prompt + reply). Smaller is faster and needs less memory; 2048 is plenty for lyric tagging, Roast and Liner Notes like 4096.',
    options: [{ v: 1024, l: '1K' }, { v: 2048, l: '2K' }, { v: 4096, l: '4K' }, { v: 8192, l: '8K' }, { v: 16384, l: '16K' }, { v: 32768, l: '32K' }] },
  { key: 'llm_keep_alive_min', label: 'Keep the model loaded', def: 30, why: 'After a reply, how long Ollama keeps the model in memory. Loading is often the slowest step on an old disk — keep it loaded if you have the RAM.',
    options: [{ v: 0, l: 'unload now' }, { v: 5, l: '5 min' }, { v: 30, l: '30 min' }, { v: 120, l: '2 h' }, { v: -1, l: 'always' }] },
  { key: 'llm_num_predict', label: 'Longest reply', def: 700, why: 'A cap on reply length in tokens (~¾ of a word each). Lyric tags use their own 400. Lower = faster Roasts and Notes.',
    options: [{ v: 300, l: '300' }, { v: 500, l: '500' }, { v: 700, l: '700' }, { v: 1000, l: '1000' }, { v: 1500, l: '1500' }, { v: -1, l: 'no cap' }] },
  { key: 'llm_num_thread', label: 'CPU threads', def: 0, why: 'Leave on auto unless the machine is busy with other work while tagging; fewer threads keeps the desktop responsive.',
    options: [{ v: 0, l: 'auto' }, { v: 1, l: '1' }, { v: 2, l: '2' }, { v: 4, l: '4' }, { v: 6, l: '6' }, { v: 8, l: '8' }] },
];
const PRESETS: { id: string; label: string; blurb: string; values: Record<string, number> }[] = [
  { id: 'slow', label: 'Old or slow PC', blurb: '30 min timeout · 2K context · stay loaded · short replies', values: { llm_timeout_s: 1800, llm_num_ctx: 2048, llm_keep_alive_min: -1, llm_num_predict: 500, llm_num_thread: 0 } },
  { id: 'balanced', label: 'Balanced', blurb: '15 min · 4K · 30 min loaded', values: { llm_timeout_s: 900, llm_num_ctx: 4096, llm_keep_alive_min: 30, llm_num_predict: 700, llm_num_thread: 0 } },
  { id: 'fast', label: 'Fast machine', blurb: '4 min · 8K · longer replies', values: { llm_timeout_s: 240, llm_num_ctx: 8192, llm_keep_alive_min: 30, llm_num_predict: 1000, llm_num_thread: 0 } },
];
const PURPOSES: Record<string, string> = { lyrics: 'Lyric tagging', ask: 'Ask the archive', words: 'Playlist from words', roast: 'Roast Me', notes: 'Liner Notes', test: 'Test', chat: 'Other' };

export function LocalModelPanel() {
  const settings = useSettings();
  const get = (k: string) => settings.data?.find((r) => r.key === k)?.value;
  const [tick, setTick] = useState(0);
  const st = useAsync(() => invoke<LlmStatus>('llm_status'), [get('ollama_url'), tick]);
  const reload = async () => { settings.reload(); await loadSettings(); setTick((t) => t + 1); };
  const save = async (key: string, value: string, note?: string) => { try { await invoke('set_setting', { key, value }); await reload(); if (note) toast(note, 'ok'); } catch (e) { toast(String(e), 'error'); } };

  return (
    <div className="space-y-6">
      <ConnectionCard status={st.data} url={get('ollama_url') ?? ''} model={get('ollama_model') ?? ''} save={save} />
      <PerformanceCard stored={(k, d) => { const v = Number(get(k)); return get(k) != null && get(k) !== '' && Number.isFinite(v) ? v : d; }} structured={get('llm_structured') !== 'false'} save={save} reload={reload} />
      <UsesCard get={get} save={save} />
      <CallLog tick={tick} />
    </div>
  );
}

function ConnectionCard({ status, url, model, save }: { status: LlmStatus | null; url: string; model: string; save: (k: string, v: string, note?: string) => Promise<void> }) {
  const [v, setV] = useState<string | null>(null);
  const val = v ?? url;
  const [test, setTest] = useState<TestReply | null>(null);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const models = status?.models ?? [];
  const chosen = models.length ? currentModel(models) : model;
  const runTest = async () => { setTesting(true); setErr(null); setTest(null); try { setTest(await invoke<TestReply>('llm_test', { model: chosen })); } catch (e) { setErr(String(e)); } finally { setTesting(false); } };
  return (
    <Card title="Ollama" subtitle="Deep Cuts talks to Ollama over HTTP on this machine. Nothing leaves it unless you point this at another one.">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="text-xs text-dust" htmlFor="ollama-url">Address</label>
          <div className="mt-1 flex items-center gap-2"><input id="ollama-url" value={val} onChange={(e) => setV(e.target.value)} placeholder="http://127.0.0.1:11434" className="num min-w-0 flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm" /><button disabled={val === url} onClick={() => { void save('ollama_url', val.trim(), 'Ollama address saved.'); setV(null); }} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">Save</button></div>
          <p className={`mt-2 text-xs ${status?.reachable ? 'text-moss' : 'text-dust'}`}>{!status ? 'checking…' : status.reachable ? `Reachable · ${models.length} model${models.length === 1 ? '' : 's'}` : `Not reachable at ${status.url}${status.error ? ` — ${status.error.slice(0, 100)}` : ''}. Start it with “ollama serve”.`}</p>
          <p className="mt-1 text-[11px] text-dust/70">In Docker: <span className="num">OLLAMA_URL=http://host.docker.internal:11434</span>.</p>
        </div>
        <div>
          <label className="text-xs text-dust" htmlFor="ollama-model">Model</label>
          <div className="mt-1 flex items-center gap-2">
            <select id="ollama-model" value={chosen} disabled={!models.length} onChange={(e) => void save('ollama_model', e.target.value, `Using ${e.target.value}.`)} className="num min-w-0 flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm">
              {!models.length && <option value="">{model || 'no models'}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button disabled={!models.length || testing} onClick={runTest} className="rounded-full border border-line px-4 py-2 text-sm text-dust hover:text-cream disabled:opacity-40">{testing ? 'Testing…' : 'Test'}</button>
          </div>
          {test && <p className="num mt-2 text-xs text-moss">Answered in {fmtDuration(test.ms)}{test.load_ms > 500 ? ` (${fmtDuration(test.load_ms)} of it loading the model)` : ''}{test.tokens_per_s ? ` · ${test.tokens_per_s} tokens/s` : ''}. {test.tokens_per_s > 0 && test.tokens_per_s < 6 ? 'That is slow — the “Old or slow PC” preset below suits this machine.' : ''}</p>}
          {err && <div className="mt-2"><ErrorBox message={err} /></div>}
          <p className="mt-2 text-[11px] text-dust/70">Small models (qwen2.5:0.5b, llama3.2:1b, gemma2:2b) run on almost anything. Lyric tagging now constrains even a 0.5b model to a fixed mood palette and theme list, so small is fine there; Roasts and Notes read better from a 1–3b model if the machine can hold one.</p>
        </div>
      </div>
    </Card>
  );
}

function PerformanceCard({ stored, structured, save, reload }: { stored: (k: string, d: number) => number; structured: boolean; save: (k: string, v: string, note?: string) => Promise<void>; reload: () => Promise<void> }) {
  const current = useMemo(() => Object.fromEntries(KNOBS.map((k) => [k.key, stored(k.key, k.def)])), [stored]);
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const v = draft ?? current;
  const dirty = KNOBS.filter((k) => v[k.key] !== current[k.key]);
  const preset = PRESETS.find((p) => KNOBS.every((k) => p.values[k.key] === v[k.key]))?.id;
  const apply = async () => { for (const k of dirty) await invoke('set_setting', { key: k.key, value: String(v[k.key]) }); await reload(); setDraft(null); toast(`${dirty.length} local-model setting${dirty.length === 1 ? '' : 's'} saved — they apply to the next request.`, 'ok'); };
  return (
    <Card title="Speed and limits" subtitle="Tuned for the machine the model runs on. The timeout used to be a fixed 240 s — too short for an older PC."
      aside={<div className="flex gap-2">{dirty.length > 0 && <button onClick={() => setDraft(null)} className="text-xs text-dust hover:text-cream">discard</button>}<button disabled={!dirty.length} onClick={() => void apply()} className="rounded-full bg-amber px-4 py-1.5 text-xs font-medium text-ink disabled:opacity-40">Apply</button></div>}>
      <div className="mb-5 flex flex-wrap gap-2">
        {PRESETS.map((p) => <button key={p.id} onClick={() => setDraft({ ...v, ...p.values })} aria-pressed={preset === p.id} className={`rounded-xl border px-4 py-2 text-left ${preset === p.id ? 'border-amber text-cream' : 'border-line text-dust hover:text-cream'}`}><span className="block text-sm">{p.label}</span><span className="block text-[11px] text-dust">{p.blurb}</span></button>)}
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        {KNOBS.map((k) => (
          <div key={k.key}>
            <p className="flex items-baseline justify-between text-sm">{k.label}{v[k.key] !== k.def && <button onClick={() => setDraft({ ...v, [k.key]: k.def })} className="text-xs text-dust hover:text-cream" title="Reset">↺</button>}</p>
            <div className="mt-1 flex flex-wrap gap-1" role="radiogroup" aria-label={k.label}>
              {k.options.map((o) => <button key={o.v} role="radio" aria-checked={v[k.key] === o.v} onClick={() => setDraft({ ...v, [k.key]: o.v })} className={`num rounded-full px-3 py-1 text-xs ${v[k.key] === o.v ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{o.l}</button>)}
              {!k.options.some((o) => o.v === v[k.key]) && <span className="num rounded-full bg-raised px-3 py-1 text-xs text-cream">{v[k.key]}</span>}
            </div>
            <p className="mt-1 text-[11px] text-dust/80">{k.why}</p>
          </div>
        ))}
        <div>
          <p className="text-sm">Constrained answers</p>
          <label className="mt-1 flex items-center gap-2 text-xs text-dust"><input type="checkbox" checked={structured} onChange={(e) => void save('llm_structured', String(e.target.checked), e.target.checked ? 'Lyric tags will use a JSON schema.' : 'Lyric tags will use plain JSON mode.')} /> Send a JSON schema so the model can only answer from the palette</label>
          <p className="mt-1 text-[11px] text-dust/80">Needs Ollama 0.5 or newer; older versions fall back automatically. Turn off only if tagging keeps failing.</p>
        </div>
      </div>
    </Card>
  );
}

function UsesCard({ get, save }: { get: (k: string) => string | undefined; save: (k: string, v: string, note?: string) => Promise<void> }) {
  const [tick, setTick] = useState(0);
  const q = useAsync(() => invoke<{ llmEnabled: boolean; llmDone: number; llmQueued: number; llmFailed: number; current: number }>('lyrics_status'), [tick, get('lyrics_llm_enabled')]);
  const lyricsOn = get('lyrics_enabled') === 'true';
  const per = Number(get('llm_lyrics_per_tick') ?? 4), every = Number(get('llm_lyrics_tick_min') ?? 10);
  const rate = per > 0 ? (per * 60) / every : 0;
  const d = q.data;
  const requeue = async () => { if (!(await confirmDialog('Put every song back in the model’s queue? Its current tags stay visible until each song is re-tagged. Songs you locked are skipped.', { confirm: 'Re-tag all' }))) return; const n = await invoke<number>('lyrics_requeue', { trackId: null }); toast(`${fmtInt(n)} songs queued for the local model.`, 'ok'); setTick((t) => t + 1); };
  return (
    <Card title="What it's used for" subtitle="Each feature works without a model; the model adds to it. Page requests always go first — background tagging waits while you're using one.">
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <p className="text-sm">Lyric tagging <span className="text-xs text-dust">(background)</span></p>
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={get('lyrics_llm_enabled') === 'true'} disabled={!lyricsOn} onChange={(e) => void save('lyrics_llm_enabled', String(e.target.checked), e.target.checked ? 'The local model will tag songs in the background.' : 'Background tagging off.')} /> Tag each song's mood, themes, keywords and a one-line summary</label>
          {!lyricsOn && <p className="mt-1 text-xs text-coral">Turn on lyric features in Settings → Connectors first.</p>}
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <label className="text-dust">Songs per round<select value={per} onChange={(e) => void save('llm_lyrics_per_tick', e.target.value)} className="num mt-1 block w-full rounded-lg border border-line bg-ink px-2 py-1 text-cream">{[0, 1, 2, 4, 8, 15, 30].map((n) => <option key={n} value={n}>{n === 0 ? 'paused' : n}</option>)}</select></label>
            <label className="text-dust">Every<select value={every} onChange={(e) => void save('llm_lyrics_tick_min', e.target.value)} className="num mt-1 block w-full rounded-lg border border-line bg-ink px-2 py-1 text-cream">{[2, 5, 10, 20, 30, 60, 120].map((n) => <option key={n} value={n}>{n} min</option>)}</select></label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-dust"><input type="checkbox" checked={get('llm_lyrics_all_langs') === 'true'} onChange={(e) => void save('llm_lyrics_all_langs', String(e.target.checked))} /> Also songs not in English (small models are weaker there)</label>
          {d && <p className="num mt-3 text-xs text-dust">{fmtInt(d.llmDone)} tagged · <span className="text-cream">{fmtInt(d.llmQueued)} waiting</span>{d.llmFailed > 0 && <> · {fmtInt(d.llmFailed)} gave up after 3 tries</>}{rate > 0 && d.llmQueued > 0 && <> · at up to {rate.toFixed(0)} an hour, about {Math.ceil(d.llmQueued / rate)} h to go</>}</p>}
          <div className="mt-2 flex flex-wrap gap-3 text-xs"><button onClick={() => void requeue()} className="text-dust hover:text-cream">Re-tag everything (after changing model)</button><Link to="/lyrics#c-lyric-hygiene" className="text-amber hover:underline">Review tags in Lyrics → Hygiene</Link></div>
        </div>
        <div>
          <p className="text-sm">On request</p>
          <ul className="mt-2 space-y-1.5 text-xs text-dust">
            <li><Link to="/ask" className="text-cream hover:text-amber">Ask the archive</Link> — writes a query, then narrates the rows.</li>
            <li><Link to="/ask" className="text-cream hover:text-amber">Playlist from words</Link> — reads a request into filters.</li>
            <li><Link to="/notes" className="text-cream hover:text-amber">Liner Notes</Link> — writes the week up; kept, so a week is written once.</li>
            <li><Link to="/roast" className="text-cream hover:text-amber">Roast Me</Link> — a routine from the whole dossier for a year, month or week.</li>
          </ul>
          <p className="mt-3 text-[11px] text-dust/70">The model only ever sees what that feature sends it (facts, receipts, one song's lyrics) — never keys or tokens — and nothing it reads is kept except what it wrote.</p>
        </div>
      </div>
    </Card>
  );
}

function CallLog({ tick }: { tick: number }) {
  const calls = useAsync(() => recentCalls(30), [tick]);
  const stats = useAsync(callStats, [tick]);
  const settings = useSettings();
  const timeout = Number(settings.data?.find((r) => r.key === 'llm_timeout_s')?.value ?? 900) * 1000;
  return (
    <Card title="How long it really takes" subtitle="Every call to the local model in the last 30 days. Use it to set the timeout: comfortably above the slowest successful job.">
      {stats.data && stats.data.length > 0 && (
        <div className="mb-4 overflow-x-auto"><table className="num w-full min-w-[520px] text-left text-xs">
          <thead className="text-dust"><tr><th className="py-1 font-normal">job</th><th className="font-normal">calls</th><th className="font-normal">typical</th><th className="font-normal">slow (p90)</th><th className="font-normal">slowest</th><th className="font-normal">failed</th></tr></thead>
          <tbody>{stats.data.map((s) => <tr key={s.purpose} className="border-t border-line/60"><td className="py-1.5 font-sans text-cream">{PURPOSES[s.purpose] ?? s.purpose}</td><td>{s.n}</td><td>{fmtDuration(s.median)}</td><td>{fmtDuration(s.p90)}</td><td className={s.max > timeout * 0.8 ? 'text-coral' : ''}>{fmtDuration(s.max)}</td><td className={s.failed ? 'text-coral' : ''}>{s.failed}</td></tr>)}</tbody>
        </table></div>
      )}
      {!calls.data ? <p className="text-sm text-dust">Reading the log…</p> : calls.data.length === 0 ? <p className="text-sm text-dust">No calls yet. Press Test above, or open Liner Notes and write a week.</p> : (
        <ol className="max-h-72 divide-y divide-line/60 overflow-y-auto text-xs">
          {calls.data.map((c, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
              <span className="num w-28 shrink-0 text-dust">{fmtStamp(c.calledAt)}</span>
              <span className="w-32 shrink-0">{PURPOSES[c.purpose] ?? c.purpose}</span>
              <span className={`num w-20 shrink-0 ${c.ok ? 'text-cream' : 'text-coral'}`}>{fmtDuration(c.ms)}</span>
              <span className="num text-dust">{c.ok ? `${c.promptTokens} in · ${c.evalTokens} out${c.loadMs > 1000 ? ` · load ${fmtDuration(c.loadMs)}` : ''}` : (c.error ?? 'failed').replace(/^slow_model: /, 'timed out: ').slice(0, 120)}</span>
              <span className="num ml-auto text-dust/60">{c.model}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
