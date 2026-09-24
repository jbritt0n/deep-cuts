import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { useAsync, useFilter } from '@/lib/hooks';
import { llmRoast, roastReceipts, type Heat } from '@/lib/roastQueries';

/**
 * Phase 9i — Roast Me (Stories). The receipts come from your record and work without any model; "Roast me properly"
 * hands only those receipts to the local model for a full routine. It roasts the listening, never the listener.
 */
const HEATS: { id: Heat; label: string; blurb: string }[] = [
  { id: 'mild', label: 'Mild', blurb: 'a friend teasing' },
  { id: 'medium', label: 'Medium', blurb: 'playful, some bite' },
  { id: 'spicy', label: 'Spicy', blurb: 'comedy-club roast' },
];

export function RoastPage() {
  const { filter } = useFilter();
  const [heat, setHeat] = useState<Heat>('medium');
  const [seed, setSeed] = useState(0);
  const r = useAsync(() => roastReceipts(heat, seed), [filter, heat, seed]);
  const [llm, setLlm] = useState<{ text: string; model: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const go = async () => { if (!r.data) return; setBusy(true); setErr(null); setLlm(null); try { setLlm(await llmRoast(heat, r.data.receipts, r.data.facts)); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };

  return (
    <div className="mx-auto max-w-4xl">
      <Sleeve kicker="Stories · Roast Me" title="Your record has notes" meta="Everything below is true. That's what makes it hurt. Your music is fair game; you are not — this only ever roasts the listening." />
      <div className="mb-6 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Heat">
        {HEATS.map((h) => <button key={h.id} role="radio" aria-checked={heat === h.id} onClick={() => { setHeat(h.id); setLlm(null); }} className={`rounded-full px-4 py-1.5 text-sm ${heat === h.id ? 'bg-coral text-ink' : 'border border-line text-dust hover:text-cream'}`} title={h.blurb}>{h.label}</button>)}
        <button onClick={() => setSeed((x) => x + 1)} className="ml-2 rounded-full border border-line px-3 py-1.5 text-xs text-dust hover:text-cream">Different jokes</button>
      </div>

      {r.error ? <ErrorBox message={r.error} /> : !r.data ? <Loading label="Reviewing the evidence…" /> : r.data.receipts.length === 0 ? (
        <Card title="Nothing to roast"><p className="text-sm text-dust">Either your listening is flawless or there isn't enough of it yet. Import your history and come back.</p></Card>
      ) : (
        <ol className="space-y-3">
          {r.data.receipts.map((x, i) => (
            <li key={x.id} className="rounded-2xl border border-line bg-surface p-4">
              <p className="font-display text-xl leading-snug"><span className="mr-2 text-coral">{i + 1}.</span>{x.line}</p>
              <p className="num mt-1 text-xs text-dust">the receipt: {x.link ? <Link to={x.link} className="underline hover:text-cream">{x.receipt}</Link> : x.receipt}</p>
            </li>
          ))}
        </ol>
      )}

      <section className="mt-8">
        <Card title="Roast me properly" subtitle="Your local model writes a full routine from the receipts above — nothing else about you is sent, and nothing leaves this machine." aside={<button disabled={busy || !r.data?.receipts.length} onClick={go} className="rounded-full bg-coral px-4 py-1.5 text-sm font-medium text-ink disabled:opacity-40">{busy ? 'Warming up the mic…' : llm ? 'Again' : 'Roast me'}</button>}>
          {err && <ErrorBox message={err} />}
          {busy && <Loading label="The comic is reading your listening history…" />}
          {llm && (
            <div>
              <div className="space-y-3 whitespace-pre-line text-[15px] leading-relaxed">{llm.text}</div>
              <div className="mt-4 flex items-center gap-3 text-xs text-dust"><span>written by {llm.model} · {heat}</span><button onClick={() => copy(llm.text)} className="rounded-full border border-line px-3 py-1 hover:text-cream">{copied ? 'Copied' : 'Copy'}</button></div>
            </div>
          )}
          {!llm && !busy && !err && <p className="text-sm text-dust">Needs Ollama running with a model chosen in Settings → Connectors. Without one, the receipts above are the whole show.</p>}
        </Card>
      </section>
    </div>
  );
}
