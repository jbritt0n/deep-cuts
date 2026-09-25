import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_GROUPS, PINNED } from '@/components/Shell';
import { DENSITIES, saveDensity } from '@/lib/display';
import { albumHref, artistHref, trackHref } from '@/lib/format';
import { fuzzyScore } from '@/lib/fuzzy';
import { useDebounced } from '@/lib/hooks';
import { search } from '@/lib/queries';

type Item = { id: string; kind: 'page' | 'setting' | 'action' | 'artist' | 'album' | 'track'; label: string; hint?: string; run: () => void };
const KIND_LABEL: Record<Item['kind'], string> = { page: 'Page', setting: 'Settings', action: 'Action', artist: 'Artist', album: 'Album', track: 'Song' };
const SETTINGS_TABS: [string, string][] = [['look', 'Appearance'], ['record', 'Record'], ['tuning', 'Tuning'], ['connectors', 'Connectors'], ['hygiene', 'Hygiene'], ['privacy', 'Privacy'], ['notforme', 'Not for me']];

/**
 * Phase 10c (Kimi R2) — Ctrl/⌘+K (or "/" when not typing): jump to any page or Settings tab, find any artist, album or
 * song in your record, or run an action. Fuzzy: "mf" → Moods & Forecast. ↑↓ to move, Enter to go, Esc to close.
 */
export function CommandPalette() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const dq = useDebounced(q, 160);
  const [hits, setHits] = useState<Item[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === '/' && !typing && !open) { e.preventDefault(); setOpen(true); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey); window.addEventListener('deepcuts:palette', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('deepcuts:palette', onOpen); };
  }, [open]);
  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  const go = (to: string) => () => { setOpen(false); nav(to); };
  const base: Item[] = useMemo(() => [
    ...PINNED.map((p) => ({ id: `p${p.to}`, kind: 'page' as const, label: p.label, run: go(p.to) })),
    ...NAV_GROUPS.flatMap((g) => g.items.map((p) => ({ id: `p${p.to}`, kind: 'page' as const, label: p.label, hint: g.label, run: go(p.to) }))),
    ...SETTINGS_TABS.map(([k, l]) => ({ id: `s${k}`, kind: 'setting' as const, label: `Settings · ${l}`, run: go(`/settings?tab=${k}`) })),
    ...DENSITIES.map((d) => ({ id: `d${d.id}`, kind: 'action' as const, label: `Display size: ${d.label}`, run: () => { saveDensity(d.id); setOpen(false); } })),
    { id: 'a-refresh', kind: 'action', label: 'Refresh this page', hint: 're-run its queries', run: () => { window.dispatchEvent(new Event('deepcuts:refresh')); setOpen(false); } },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  // record search (artists, albums, songs) once there are 2+ characters
  useEffect(() => {
    let alive = true;
    if (dq.trim().length < 2) { setHits([]); return; }
    search(dq.trim()).then((r) => {
      if (!alive) return;
      setHits([
        ...r.artists.slice(0, 5).map((a) => ({ id: `ar${a.artistId}`, kind: 'artist' as const, label: a.artist, hint: `${a.plays} plays`, run: go(artistHref(a.artistId!)) })),
        ...r.albums.slice(0, 4).map((a) => ({ id: `al${a.albumId}`, kind: 'album' as const, label: a.album, hint: a.artist ?? '', run: go(albumHref(a.albumId!)) })),
        ...r.tracks.slice(0, 6).map((t) => ({ id: `tr${t.trackId}`, kind: 'track' as const, label: t.track, hint: t.artist ?? '', run: go(trackHref(t.trackId!)) })),
      ]);
    }).catch(() => alive && setHits([]));
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);

  const items = useMemo(() => {
    if (!q.trim()) return base.filter((i) => i.kind === 'page').slice(0, 12);
    const scored = base.map((i) => ({ i, s: fuzzyScore(q, i.label) })).filter((x) => x.s != null).sort((a, b) => b.s! - a.s!).slice(0, 8).map((x) => x.i);
    return [...scored, ...hits];
  }, [q, base, hits]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  if (!open) return null;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/70 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div role="dialog" aria-modal="true" aria-label="Go to anything" className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Go to a page, an artist, an album, a song…"
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[sel] ? `pal-${items[sel].id}` : undefined}
          className="w-full border-b border-line bg-transparent px-5 py-4 text-base text-cream outline-none placeholder:text-dust/70" />
        <ul id="palette-list" ref={list} role="listbox" className="max-h-[min(26rem,60vh)] overflow-y-auto p-2">
          {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-dust">{q.trim().length >= 2 ? 'Nothing matches.' : 'Type to search.'}</li>}
          {items.map((it, i) => (
            <li key={it.id} id={`pal-${it.id}`} data-i={i} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); it.run(); }}
              className={`flex cursor-pointer items-baseline gap-3 rounded-lg px-3 py-2 text-sm ${i === sel ? 'bg-raised text-cream' : 'text-cream/90'}`}>
              <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-dust">{KIND_LABEL[it.kind]}</span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="shrink-0 truncate text-[11px] text-dust">{it.hint}</span>}
            </li>
          ))}
        </ul>
        <p className="flex gap-4 border-t border-line px-4 py-2 text-[11px] text-dust"><span><kbd>↑↓</kbd> move</span><span><kbd>Enter</kbd> go</span><span><kbd>Esc</kbd> close</span><span className="ml-auto"><kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>K</kbd> or <kbd>/</kbd> anywhere</span></p>
      </div>
    </div>
  );
}
