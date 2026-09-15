import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { inTauri, invoke } from '@/lib/bridge';
import type { TrackRow } from '@/lib/types';
import { search, topTracks } from '@/lib/queries';
import { useDebounced } from '@/lib/hooks';
import { settingBool } from '@/lib/settings';
import { QueueButton } from './QueueButton';

/**
 * PLY-10: the one preview used by every "Make playlist" button. Remove tracks
 * (a replacement is suggested from the same pool), add more from suggestions or
 * by searching the archive, edit name/description, choose visibility (private
 * by default), create.
 */
type Draft = { name: string; description: string; kind: string; tracks: TrackRow[]; note?: string; poolRange?: [string, string]; pool?: TrackRow[] };
type Ctx = { open: (d: Draft) => void };
const PMContext = createContext<Ctx>({ open: () => {} });
export const usePlaylistMaker = () => useContext(PMContext);

export function PlaylistMakerProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  return (
    <PMContext.Provider value={{ open: setDraft }}>
      {children}
      {draft && <PlaylistDialog draft={draft} onClose={() => setDraft(null)} />}
    </PMContext.Provider>
  );
}

export function MakePlaylistButton({ name, tracks, kind = 'list_export', description = '', note, small = false, poolRange, pool, label = 'Make playlist' }: {
  name: string; tracks: TrackRow[]; kind?: string; description?: string; note?: string; small?: boolean; poolRange?: [string, string]; pool?: TrackRow[]; label?: string;
}) {
  const { open } = usePlaylistMaker();
  const usable = tracks.filter((t) => !t.trackId.startsWith('local:'));
  if (!usable.length) return null;
  return (
    <button onClick={() => open({ name, description, kind, tracks: usable, note, poolRange, pool })}
      className={small ? 'text-xs text-dust hover:text-amber' : 'rounded-full border border-line px-4 py-2 text-sm text-dust transition hover:border-dust hover:text-cream'}>
      {label}
    </button>
  );
}

function PlaylistDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const [name, setName] = useState(draft.name);
  const [desc, setDesc] = useState(draft.description);
  const [pub, setPub] = useState(() => settingBool('playlist_default_public', false)); // Phase 9c: owner default, still per-playlist
  const [tracks, setTracks] = useState(draft.tracks);
  const [pool, setPool] = useState<TrackRow[]>(draft.pool ?? []);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [found, setFound] = useState<TrackRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; added: number; on_spotify?: number | null; duplicates_dropped?: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastRemoved, setLastRemoved] = useState<TrackRow | null>(null);

  // Suggestion pool: the next-best tracks from the same context (by hours), or all-time if no range.
  useEffect(() => {
    if (draft.pool) return;
    topTracks(Math.max(80, draft.tracks.length * 3), draft.poolRange, 'hours').then(setPool).catch(() => {});
  }, [draft]);
  useEffect(() => {
    if (dq.trim().length < 2) { setFound([]); return; }
    search(dq).then((r) => setFound(r.tracks.filter((t) => !t.trackId.startsWith('local:')))).catch(() => {});
  }, [dq]);

  const inList = new Set(tracks.map((t) => t.trackId));
  const suggestions = pool.filter((t) => !inList.has(t.trackId) && !t.trackId.startsWith('local:'));
  const remove = (t: TrackRow) => { setTracks(tracks.filter((x) => x.trackId !== t.trackId)); setLastRemoved(t); };
  const add = (t: TrackRow) => { if (!inList.has(t.trackId)) setTracks([...tracks, t]); };
  const replaceWith = (t: TrackRow) => { add(t); setLastRemoved(null); };
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await invoke<{ url: string; added: number }>('create_playlist', { playlist: { name, description: desc, public: pub, kind: draft.kind, track_ids: tracks.map((t) => t.trackId), source_note: draft.note ?? null } });
      setResult(r);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const Row = ({ t, action, actionLabel }: { t: TrackRow; action: () => void; actionLabel: string }) => (
    <li className="flex items-center gap-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate">{t.track}<span className="ml-2 text-xs text-dust">{t.artist}</span></span>
      <span className="num shrink-0 text-[11px] text-dust">{t.plays ? `${t.plays}×` : ''}</span>
      <QueueButton trackId={t.trackId} size={12} />
      <button onClick={action} className={`shrink-0 text-xs ${actionLabel === 'remove' ? 'text-dust hover:text-coral' : 'text-dust hover:text-moss'}`}>{actionLabel}</button>
    </li>
  );

  return (
    <div role="dialog" aria-modal className="fixed inset-0 z-50 grid place-items-center bg-ink/80 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="grid max-h-[88vh] w-full max-w-4xl grid-rows-[auto_1fr_auto] overflow-hidden rounded-2xl border border-line bg-surface" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-line p-6">
          <p className="text-xs text-dust">New Spotify playlist · {tracks.length} tracks</p>
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full bg-transparent font-display text-2xl focus:outline-none" aria-label="Playlist name" />
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" className="mt-1 w-full bg-transparent text-sm text-dust placeholder:text-dust/50 focus:outline-none" aria-label="Description" />
        </div>
        <div className="grid min-h-0 gap-0 md:grid-cols-[1.2fr_1fr]">
          <div className="min-h-0 overflow-y-auto border-r border-line px-6 py-3">
            <p className="text-xs text-dust">In the playlist</p>
            {lastRemoved && suggestions[0] && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber/30 bg-amber/5 px-3 py-2 text-xs">
                <span className="text-dust">Removed <span className="text-cream">{lastRemoved.track}</span>. Replace with</span>
                <button onClick={() => replaceWith(suggestions[0])} className="rounded-full bg-amber px-2.5 py-1 font-medium text-ink">{suggestions[0].track} — {suggestions[0].artist}</button>
                <button onClick={() => setLastRemoved(null)} className="text-dust hover:text-cream">no thanks</button>
              </div>
            )}
            <ol className="divide-y divide-line/60">{tracks.map((t) => <Row key={t.trackId} t={t} action={() => remove(t)} actionLabel="remove" />)}</ol>
            {!tracks.length && <p className="py-6 text-center text-sm text-dust">Empty — add from the right.</p>}
          </div>
          <div className="min-h-0 overflow-y-auto px-6 py-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your archive to add a song…" className="w-full rounded-full border border-line bg-ink px-4 py-1.5 text-sm placeholder:text-dust/50" aria-label="Search tracks to add" />
            {found.length > 0 && <><p className="mt-3 text-xs text-dust">Search results</p><ul className="divide-y divide-line/60">{found.filter((t) => !inList.has(t.trackId)).slice(0, 12).map((t) => <Row key={t.trackId} t={t} action={() => add(t)} actionLabel="add" />)}</ul></>}
            <p className="mt-3 text-xs text-dust">Suggestions from the same {draft.poolRange ? 'period' : 'archive'}, next by hours{suggestions.length ? ` · ${suggestions.length}` : ''}</p>
            {suggestions.length ? <ul className="divide-y divide-line/60">{suggestions.slice(0, 25).map((t) => <Row key={t.trackId} t={t} action={() => add(t)} actionLabel="add" />)}</ul> : <p className="py-3 text-sm text-dust">Loading…</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-line p-6">
          <label className="flex items-center gap-2 text-sm text-dust">
            <span className={`relative inline-block h-5 w-9 cursor-pointer rounded-full transition ${pub ? 'bg-amber' : 'bg-raised'}`} onClick={() => setPub(!pub)} role="switch" aria-checked={pub} tabIndex={0} onKeyDown={(e) => e.key === ' ' && setPub(!pub)}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-cream transition ${pub ? 'left-[18px]' : 'left-0.5'}`} />
            </span>
            {pub ? 'Public on your profile' : 'Private (default)'}
          </label>
          <div className="ml-auto flex items-center gap-3">
            <button onClick={onClose} className="text-sm text-dust hover:text-cream">{result ? 'Close' : 'Cancel'}</button>
            {!result && <button disabled={busy || !tracks.length || !name.trim()} onClick={create} className="rounded-full bg-amber px-5 py-2 text-sm font-medium text-ink disabled:opacity-40">{busy ? 'Creating…' : `Create on Spotify · ${tracks.length}`}</button>}
          </div>
          {err && <p className="w-full text-xs text-coral">{err}{!inTauri ? ' (needs the desktop app connected to Spotify)' : ''}</p>}
          {result && <p className="w-full text-sm text-moss">Created with {result.added} tracks{result.on_spotify != null && result.on_spotify < result.added ? <span className="text-amber"> — Spotify shows {result.on_spotify}; it dropped ids it no longer serves (see Activity)</span> : null}{result.duplicates_dropped ? ` · ${result.duplicates_dropped} duplicate${result.duplicates_dropped === 1 ? "" : "s"} removed` : ""}. <a href={result.url} target="_blank" rel="noreferrer" className="underline">Open in Spotify</a></p>}
        </div>
      </div>
    </div>
  );
}
