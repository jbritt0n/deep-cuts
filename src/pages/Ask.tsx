import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke } from '@/lib/bridge';
import { SUGGESTIONS, askArchive, currentModel, llmStatus, type AskTurn, type LlmStatus } from '@/lib/ask';
import { useFilter } from '@/lib/hooks';
import { fmtInt } from '@/lib/format';
import { Card, Sleeve } from '@/components/Card';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { QueueButton } from '@/components/QueueButton';
import { ExploreSearch } from '@/pages/Explore';
import { WordsPlaylist } from '@/components/WordsPlaylist';

/**
 * Phase 9e — Ask the Archive. A conversation with your own record, answered by a local model (Ollama) that writes
 * read-only SQL, gets the rows back, and narrates them. Every answer shows its work: the SQL, the rows, the
 * timing. Answers that list tracks can become a playlist or go straight to the Spotify queue.
 */
export function AskPage() {
  const { filter } = useFilter();
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [model, setModel] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const refresh = () => llmStatus().then((s) => { setStatus(s); if (s.models.length && !model) setModel(currentModel(s.models)); }).catch((e) => setStatus({ reachable: false, url: '', models: [], error: String(e) }));
  useEffect(() => { refresh(); const t = window.setInterval(refresh, 30000); return () => window.clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns.length, busy]);

  const ask = async (question: string) => {
    if (!question.trim() || !model || busy) return;
    setQ(''); setBusy(question);
    const turn = await askArchive(question.trim(), model, turns);
    setTurns((t) => [...t, turn]); setBusy(null);
  };
  const pickModel = (m: string) => { setModel(m); invoke('set_setting', { key: 'ollama_model', value: m }).catch(() => {}); };
  const ready = !!status?.reachable && !!model;

  return (
    <div className="mx-auto max-w-5xl">
      <Sleeve kicker="Ask the archive" title="Ask your record anything" meta={<>A local model reads the schema, writes one read-only query, and narrates what comes back. Nothing leaves this machine. The lens ({filter.attentiveOnly ? 'attentive' : 'everything'}{filter.fromYear ? `, ${filter.fromYear}–${filter.toYear ?? 'now'}` : ''}) applies.</>}>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
          <span className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${status?.reachable ? 'border-moss/50 text-moss' : 'border-coral/50 text-coral'}`}><span className={`inline-block h-2 w-2 rounded-full ${status?.reachable ? 'bg-moss' : 'bg-coral'}`} />{status == null ? 'checking Ollama…' : status.reachable ? `Ollama at ${status.url}` : `Ollama not reachable at ${status.url || 'the configured URL'}`}</span>
          {status?.reachable && status.models.length > 0 && <label className="flex items-center gap-2 text-dust">model <select value={model} onChange={(e) => pickModel(e.target.value)} className="rounded-lg border border-line bg-ink px-2 py-1 text-cream">{status.models.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>}
          {status?.reachable && status.models.length === 0 && <span className="text-dust">Ollama is up but has no models — run <span className="num text-cream">ollama pull llama3.1</span> (or any model) and it will appear here.</span>}
          {status && !status.reachable && <span className="text-dust">Start it with <span className="num text-cream">ollama serve</span>, or set the URL in <Link to="/settings?tab=connectors" className="underline hover:text-cream">Settings → Connectors</Link>.{status.error ? ` (${status.error.slice(0, 120)})` : ''}</span>}
          <button onClick={refresh} className="text-dust hover:text-cream">recheck</button>
        </div>
      </Sleeve>

      {/* Phase 9h: the Explore search at the top — works with or without a local model */}
      <section className="mb-8" aria-label="Search your record">
        <div className="mb-2 flex items-baseline justify-between"><h2 className="font-display text-2xl">Search</h2><Link to="/explore/lists" className="text-xs text-dust hover:text-cream">full-page search →</Link></div>
        <ExploreSearch big={false} autoFocus={!!status && !status.reachable} />
      </section>
      <section className="mb-8"><WordsPlaylist /></section>
      <h2 className="mb-3 font-display text-2xl">Ask {status && !status.reachable && <span className="align-middle text-xs font-sans text-dust">— needs a local model (Ollama)</span>}</h2>

      {turns.length === 0 && !busy && (
        <Card title="Things to try" subtitle="Questions the record can answer. Follow-ups work — ask, then say “and in 2024?”.">
          <ul className="grid gap-2 sm:grid-cols-2">{SUGGESTIONS.map((s) => <li key={s}><button disabled={!ready} onClick={() => ask(s)} className="w-full rounded-xl border border-line px-3 py-2 text-left text-sm text-dust transition hover:border-dust hover:text-cream disabled:opacity-40">{s}</button></li>)}</ul>
        </Card>
      )}

      <div className="space-y-6">
        {turns.map((t) => <Turn key={t.id} t={t} onFollowUp={ask} />)}
        {busy && <div className="rounded-2xl border border-line bg-surface p-5"><p className="font-display text-xl">{busy}</p><p className="mt-2 flex items-center gap-2 text-sm text-dust"><span className="spin inline-block h-3 w-3 rounded-full border border-dust border-t-transparent" />Writing the query, running it, reading the rows… a local model takes a moment.</p></div>}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="sticky bottom-4 mt-6 flex items-center gap-2 rounded-2xl border border-line bg-surface/95 p-2 shadow-glow backdrop-blur">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ready ? 'Ask the record…' : 'Connect Ollama to start asking'} disabled={!ready || !!busy} className="flex-1 bg-transparent px-3 py-2 text-sm placeholder:text-dust/60" aria-label="Your question" />
        {turns.length > 0 && <button type="button" onClick={() => setTurns([])} className="text-xs text-dust hover:text-cream">clear</button>}
        <button type="submit" disabled={!ready || !!busy || !q.trim()} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">Ask</button>
      </form>
    </div>
  );
}

function Turn({ t, onFollowUp }: { t: AskTurn; onFollowUp: (q: string) => void }) {
  const [showSql, setShowSql] = useState(false);
  const [showRows, setShowRows] = useState(t.rowCount > 0 && t.rowCount <= 12);
  return (
    <article className="rounded-2xl border border-line bg-surface p-5">
      <p className="font-display text-xl">{t.question}</p>
      {t.error && <p className="mt-2 rounded-xl border border-coral/40 bg-coral/5 px-3 py-2 text-sm text-coral">{t.error}</p>}
      {t.narrative && <p className="mt-3 max-w-3xl text-[15px] leading-relaxed">{t.narrative}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-dust">
        {t.sql && <button onClick={() => setShowSql(!showSql)} className="hover:text-cream">{showSql ? '▾' : '▸'} SQL</button>}
        {t.rowCount > 0 && <button onClick={() => setShowRows(!showRows)} className="hover:text-cream">{showRows ? '▾' : '▸'} {fmtInt(t.rowCount)} row{t.rowCount === 1 ? '' : 's'}</button>}
        <span className="num">{(t.ms / 1000).toFixed(1)} s · {t.model}{t.attempts > 1 ? ` · repaired once` : ''}</span>
        {t.explanation && <span className="text-dust/70">{t.explanation}</span>}
        {t.tracks && t.tracks.length > 0 && <span className="ml-auto flex items-center gap-2"><MakePlaylistButton small label={`Playlist · ${t.tracks.length}`} name={`Ask the archive · ${t.question.slice(0, 60)}`} tracks={t.tracks} kind="insight" note={`ask:${t.question.slice(0, 120)}`} pool={t.tracks} /></span>}
      </div>
      {showSql && t.sql && <pre className="num mt-3 overflow-x-auto rounded-xl border border-line bg-ink/60 p-3 text-xs text-dust">{t.sql}</pre>}
      {showRows && t.rowCount > 0 && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="num w-full text-left text-xs">
            <thead><tr className="bg-ink/40 text-dust">{t.columns.map((c) => <th key={c} className="px-2 py-1.5 font-normal">{c}</th>)}{t.tracks && <th />}</tr></thead>
            <tbody>{t.rows.slice(0, 60).map((r, i) => <tr key={i} className="border-t border-line/60">{t.columns.map((c) => <td key={c} className="max-w-[22rem] truncate px-2 py-1 font-sans" title={String(r[c] ?? '')}>{cell(r[c], c)}</td>)}{t.tracks && <td className="px-2 py-1"><QueueButton trackId={String(r[t.columns.find((c) => /^track_?id$/i.test(c)) ?? ''] ?? '')} /></td>}</tr>)}</tbody>
          </table>
          {t.rowCount > 60 && <p className="px-2 py-1.5 text-[11px] text-dust">first 60 of {fmtInt(t.rowCount)}</p>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">{followUps(t).map((f) => <button key={f} onClick={() => onFollowUp(f)} className="rounded-full border border-line px-2 py-0.5 text-dust hover:text-cream">{f}</button>)}</div>
    </article>
  );
}

function cell(v: unknown, col: string): React.ReactNode {
  if (v == null) return <span className="text-dust/50">—</span>;
  if (typeof v === 'number') return Number.isInteger(v) ? fmtInt(v) : v.toFixed(2);
  const s = String(v);
  if (/^artist_?id$/i.test(col)) return <Link to={`/artist/${encodeURIComponent(s)}`} className="hover:text-amber">{s.replace(/^name:/, '')}</Link>;
  if (/^track_?id$/i.test(col)) return <Link to={`/track/${encodeURIComponent(s)}`} className="hover:text-amber">{s.slice(0, 12)}…</Link>;
  if (/^album_?id$/i.test(col)) return <Link to={`/album/${encodeURIComponent(s)}`} className="hover:text-amber">{s.slice(0, 12)}…</Link>;
  return s;
}
function followUps(t: AskTurn): string[] {
  const out: string[] = [];
  if (t.rowCount > 0) { out.push('And the year before that?'); out.push('Break that down by month'); }
  if (t.tracks?.length) out.push('Which of those do I skip most?');
  if (!t.rowCount && !t.error) out.push('Show me the closest thing you can find');
  return out.slice(0, 3);
}
