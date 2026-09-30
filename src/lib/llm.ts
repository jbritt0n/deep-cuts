/**
 * Phase 10d — the frontend side of the local-model controller. Every page that writes with the model (Liner Notes,
 * Roast Me) goes through `writeWithModel`, which picks the model the owner chose, labels the call for the log, times
 * it, and — because a slow machine can take many minutes — keeps the promise in a module-level map so leaving the
 * page doesn't lose the work: come back and the page picks the same job up (`inflight`), and the result is saved to
 * `llm_writings` by the job itself, not by the component.
 */
import { invoke } from './bridge';
import { query, num, str } from './db';
import { currentModel, llmStatus, type ChatMsg } from './ask';

export type Writing = { id: string; kind: 'notes' | 'roast'; periodKey: string; model: string; text: string; facts: unknown; ms: number | null; pinned: boolean; createdAt: string };
export type LlmCall = { calledAt: string; model: string; purpose: string; ms: number; loadMs: number; promptTokens: number; evalTokens: number; ok: boolean; error: string | null };
export type TestReply = { content: string; ms: number; load_ms: number; prompt_tokens: number; eval_tokens: number; tokens_per_s: number; model: string };

type Job = { key: string; started: number; promise: Promise<Writing> };
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
export const onJobsChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const inflight = (key: string) => jobs.get(key) ?? null;

export async function pickModel(): Promise<string> {
  const st = await llmStatus();
  if (!st.reachable) throw new Error(`could not reach Ollama at ${st.url} — start it (ollama serve) or fix the URL in Settings → Local model`);
  if (!st.models.length) throw new Error('Ollama has no models yet (not found) — run `ollama pull qwen2.5:0.5b` (or any model) and pick it in Settings → Local model');
  return currentModel(st.models);
}

/** Run one writing job (or join the one already running for this key); saves what the model wrote. */
export function writeWithModel(opts: { key: string; kind: 'notes' | 'roast'; periodKey: string; messages: ChatMsg[]; facts: unknown; temperature: number; numPredict?: number }): Job {
  const running = jobs.get(opts.key);
  if (running) return running;
  const started = Date.now();
  const promise = (async () => {
    const model = await pickModel();
    const text = (await invoke<string>('llm_chat', { model, messages: opts.messages, jsonMode: false, temperature: opts.temperature, purpose: opts.kind, numPredict: opts.numPredict ?? null })).trim();
    if (!text) throw new Error('the model returned an empty reply — try again, or raise “Longest reply” in Settings → Local model');
    const ms = Date.now() - started;
    const id = await invoke<string>('writing_save', { kind: opts.kind, periodKey: opts.periodKey, model, text, facts: opts.facts, ms });
    return { id, kind: opts.kind, periodKey: opts.periodKey, model, text, facts: opts.facts, ms, pinned: false, createdAt: new Date().toISOString() } as Writing;
  })().finally(() => { jobs.delete(opts.key); notify(); });
  const job = { key: opts.key, started, promise };
  jobs.set(opts.key, job); notify();
  return job;
}

export async function writings(kind: 'notes' | 'roast', periodKey?: string): Promise<Writing[]> {
  const rows = await query(`SELECT id, kind, period_key, model, text, CAST(facts AS VARCHAR) AS facts, ms, pinned, CAST(created_at AS VARCHAR) AS created_at FROM llm_writings WHERE kind = $1 ${periodKey ? 'AND period_key = $2' : ''} ORDER BY pinned DESC, created_at DESC`, periodKey ? [kind, periodKey] : [kind]);
  return rows.map((r) => ({ id: String(r.id), kind, periodKey: String(r.period_key), model: str(r.model) ?? '', text: String(r.text ?? ''), facts: (() => { try { return JSON.parse(String(r.facts)); } catch { return null; } })(), ms: r.ms == null ? null : num(r.ms), pinned: Boolean(r.pinned), createdAt: String(r.created_at) }));
}
/** Which periods already have something written (for the Liner Notes calendar). */
export async function writtenPeriods(kind: 'notes' | 'roast'): Promise<Set<string>> {
  return new Set((await query(`SELECT DISTINCT period_key FROM llm_writings WHERE kind = $1`, [kind])).map((r) => String(r.period_key)));
}

export async function recentCalls(limit = 40): Promise<LlmCall[]> {
  return (await query(`SELECT CAST(called_at AS VARCHAR) AS at, model, purpose, ms, load_ms, prompt_tokens, eval_tokens, ok, error FROM llm_calls ORDER BY called_at DESC LIMIT ${Math.round(limit)}`)).map((r) => ({
    calledAt: String(r.at), model: String(r.model ?? ''), purpose: String(r.purpose ?? ''), ms: num(r.ms), loadMs: num(r.load_ms), promptTokens: num(r.prompt_tokens), evalTokens: num(r.eval_tokens), ok: Boolean(r.ok), error: str(r.error),
  }));
}
export async function callStats(): Promise<{ purpose: string; n: number; failed: number; median: number; p90: number; max: number }[]> {
  return (await query(`SELECT purpose, COUNT(*) AS n, COUNT(*) FILTER (WHERE NOT ok) AS failed, median(ms) FILTER (WHERE ok) AS med, quantile_cont(ms, 0.9) FILTER (WHERE ok) AS p90, MAX(ms) AS mx FROM llm_calls WHERE called_at > now() - INTERVAL 30 DAY GROUP BY 1 ORDER BY n DESC`))
    .map((r) => ({ purpose: String(r.purpose), n: num(r.n), failed: num(r.failed), median: num(r.med), p90: num(r.p90), max: num(r.mx) }));
}

export const fmtDuration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : ms < 90_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
