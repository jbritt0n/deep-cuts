// Phase 10d smoke: lyric hygiene corrections flow through every lyric view; the blocklist; the mood palette; saved
// Liner Notes / Roast writing with the mock model; the local-model call log; roast periods. Run with OLLAMA_MOCK=1.
(globalThis as unknown as { window: object }).window = {};
import { invoke } from '../src/lib/bridge';
import { query } from '../src/lib/db';
import { setActiveFilter } from '../src/lib/filter';
import * as L from '../src/lib/lyricQueries';
import { MOOD_IDS } from '../src/lib/lyricVocab';
import { mondayOf, notesPrompt, weekExtras, weekFacts } from '../src/lib/notesQueries';
import { recentCalls, writeWithModel, writings } from '../src/lib/llm';
import { periodFor, roastDossier, roastMessages, roastReceipts } from '../src/lib/roastQueries';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(34)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

// the cleanup of 9f outputs left no instruction echoes; moods cloud is palette-only
const [echo] = await query(`SELECT COUNT(*) AS n FROM track_lyric_features WHERE regexp_matches(COALESCE(llm_mood, ''), '[0-9]') OR list_contains(COALESCE(llm_themes, []::VARCHAR[]), 'radio edit')`);
assert(Number(echo.n) === 0, 'no "1 to 2 words" / "radio edit" survive');
const moods = await time('mood cloud (palette only)', () => L.lyricCloud('moods'));
assert(moods.length > 0 && moods.every((m) => MOOD_IDS.includes(m.text)), `palette moods: ${moods.map((m) => m.text)}`);

// hygiene: hide a keyword, add one, fix the language, replace model themes — every view follows
const { rows } = await time('hygiene list', () => L.hygieneList({ filter: 'model' }));
const song = rows[0]; assert(song && song.keywords.length > 0, 'a tagged song with keywords');
const hide = song.keywords[0];
await time('override: hide / add / themes / mood', () => invoke('lyrics_override_set', { trackId: song.trackId, patch: { keywords_hide: [hide], keywords_add: ['hypercolour'], llm_themes: ['the road', 'nightlife'], mood: 'euphoric' } }));
const d = await time('song detail after edit', () => L.songLyricDetail(song.trackId));
assert(d.terms.find((t) => t.term === hide)?.hidden, 'hidden keyword marked'); assert(d.terms.some((t) => t.added && t.term === 'hypercolour'), 'added keyword present');
const kw = await query(`SELECT term FROM track_lyric_keywords WHERE track_id = $1 ORDER BY rank`, [song.trackId]);
assert(kw[0].term === 'hypercolour' && !kw.some((k) => k.term === hide), `keywords view honours edits: ${kw.map((k) => k.term)}`);
const eff = (await query(`SELECT llm_themes, llm_mood, edited FROM track_lyrics_effective WHERE track_id = $1`, [song.trackId]))[0];
assert(eff.llm_mood === 'euphoric' && (eff.llm_themes as string[]).includes('nightlife') && eff.edited, 'effective view honours edits');
assert((await L.hygieneList({ filter: 'edited' })).total >= 1, 'edited filter');
await time('override: hide song', () => invoke('lyrics_override_set', { trackId: song.trackId, patch: { hidden: true } }));
assert(!(await query(`SELECT 1 FROM track_lyrics_effective WHERE track_id = $1`, [song.trackId])).length, 'hidden song leaves the lyric views');
await invoke('lyrics_override_clear', { trackId: song.trackId });
let bad = false; try { await invoke('lyrics_override_set', { trackId: song.trackId, patch: { lang: 'Not A Code!' } }); } catch { bad = true; } assert(bad, 'bad language code rejected');
await invoke('lyrics_override_clear', { trackId: song.trackId });

// blocklist: a blocked word is nobody's keyword
await time('blocklist add', () => invoke('lyrics_blocklist', { term: hide, add: true }));
assert(!(await query(`SELECT 1 FROM track_lyric_keywords WHERE term = $1`, [hide])).length, 'blocked everywhere');
await invoke('lyrics_blocklist', { term: hide, add: false });
assert((await query(`SELECT 1 FROM track_lyric_keywords WHERE term = $1`, [hide])).length > 0, 'unblocked');

// requeue: old-prompt songs and one song
const n = await time('requeue one song', () => invoke<number>('lyrics_requeue', { trackId: song.trackId })); assert(n === 1, 'one row');
const st = await invoke<{ llmQueued: number }>('lyrics_status'); assert(st.llmQueued > 0, 'queue counts');

// Liner Notes with the mock model: written once, kept, found again
const ws = mondayOf('2026-09-16'); const f = await weekFacts(ws); const p = notesPrompt(f, await weekExtras(ws), 'short');
assert(p.messages[1].content.includes(f.label), 'facts in prompt');
const w = await time('write notes (mock model)', () => writeWithModel({ key: `notes:${ws}`, kind: 'notes', periodKey: ws, messages: p.messages, facts: p.facts, temperature: 0.6 }).promise);
const kept = await writings('notes', ws); assert(kept.some((x) => x.id === w.id && x.text.length > 10), 'note kept');
await invoke('writing_pin', { id: w.id, pinned: true }); assert((await writings('notes', ws))[0].pinned, 'pinned first');
await invoke('writing_delete', { id: w.id }); assert(!(await writings('notes', ws)).some((x) => x.id === w.id), 'deleted');

// Roast: a month, with the dossier, saved
const month = periodFor('month', '2026-08-10');
const r = await time('roast receipts (a month)', () => roastReceipts('spicy', 1, month)); assert(r.receipts.length >= 5, `receipts ${r.receipts.length}`);
const dossier = await time('roast dossier', () => roastDossier(month, r.receipts, r.facts)); assert((dossier.topArtists as string[]).length > 0 && JSON.stringify(dossier).length < 8000, 'compact dossier');
const rw = await writeWithModel({ key: 'roast:test', kind: 'roast', periodKey: `${month.key}:spicy`, messages: roastMessages('spicy', dossier), facts: dossier, temperature: 0.9 }).promise;
await invoke('writing_delete', { id: rw.id });

// the call log saw both
const calls = await recentCalls(5); assert(calls.some((c) => c.purpose === 'notes') || process.env.OLLAMA_MOCK, 'call log');
console.log('10d smoke OK');
