import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Phase 10c — app-wide overlays, themed and keyboard-friendly:
 *   confirmDialog(message, opts) → Promise<boolean>   (replaces window.confirm, which ignores the skin)
 *   toast(message, kind)                             (one feedback channel instead of per-page banners)
 *   <OnThisPage />                                   (jump menu on pages with 5+ sections)
 * <OverlayHost /> is mounted once in the Shell.
 */
type Confirm = { id: number; message: string; confirm: string; danger: boolean; resolve: (ok: boolean) => void };
type Toast = { id: number; message: string; kind: 'info' | 'ok' | 'warn' | 'error' };
let seq = 0;

export function confirmDialog(message: string, opts: { confirm?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => window.dispatchEvent(new CustomEvent('deepcuts:confirm', { detail: { id: ++seq, message, confirm: opts.confirm ?? 'Confirm', danger: opts.danger ?? true, resolve } })));
}
export function toast(message: string, kind: Toast['kind'] = 'info') {
  window.dispatchEvent(new CustomEvent('deepcuts:toast', { detail: { id: ++seq, message, kind } }));
}

export function OverlayHost() {
  const [c, setC] = useState<Confirm | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onC = (e: Event) => setC((e as CustomEvent<Confirm>).detail);
    const onT = (e: Event) => { const t = (e as CustomEvent<Toast>).detail; setToasts((x) => [...x.slice(-3), t]); setTimeout(() => setToasts((x) => x.filter((y) => y.id !== t.id)), t.kind === 'error' ? 9000 : 5000); };
    window.addEventListener('deepcuts:confirm', onC); window.addEventListener('deepcuts:toast', onT);
    return () => { window.removeEventListener('deepcuts:confirm', onC); window.removeEventListener('deepcuts:toast', onT); };
  }, []);
  useEffect(() => { if (c) setTimeout(() => ok.current?.focus(), 0); }, [c]);
  const close = (v: boolean) => { c?.resolve(v); setC(null); };
  const tone = { info: 'border-line', ok: 'border-moss/60', warn: 'border-amber/60', error: 'border-coral/60' } as const;
  return (
    <>
      {c && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 px-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') close(false); }}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-msg" className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl">
            <p id="confirm-msg" className="text-sm leading-relaxed">{c.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => close(false)} className="rounded-full border border-line px-4 py-1.5 text-sm text-dust hover:text-cream">Cancel</button>
              <button ref={ok} onClick={() => close(true)} className={`rounded-full px-4 py-1.5 text-sm font-medium text-ink ${c.danger ? 'bg-coral' : 'bg-amber'}`}>{c.confirm}</button>
            </div>
          </div>
        </div>
      )}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => <div key={t.id} role="status" className={`pointer-events-auto rounded-xl border ${tone[t.kind]} bg-surface/95 px-4 py-3 text-sm shadow-lg backdrop-blur`}>{t.message}</div>)}
      </div>
    </>
  );
}

/** Pages with 5+ cards get a small "On this page" menu; each Card title is an anchor (Card.tsx). */
export function OnThisPage() {
  const loc = useLocation();
  const [items, setItems] = useState<{ id: string; label: string }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    const main = document.getElementById('main'); if (!main) return;
    const scan = () => { const hs = [...main.querySelectorAll<HTMLElement>('section[data-card-title]')].map((s) => ({ id: s.id, label: s.dataset.cardTitle ?? '' })).filter((x) => x.id && x.label);
      setItems((prev) => (prev.length === hs.length && prev.every((p, i) => p.id === hs[i].id) ? prev : hs)); };
    scan();
    const mo = new MutationObserver(() => scan()); mo.observe(main, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [loc.pathname, loc.search]);
  if (items.length < 5) return null;
  return (
    <div className="fixed bottom-4 left-[calc(min(13.75rem,20vw)+1rem)] z-30">
      {open && (
        <ul className="mb-2 max-h-[60vh] w-64 overflow-y-auto rounded-xl border border-line bg-surface/95 p-2 text-sm shadow-xl backdrop-blur">
          {items.map((i) => <li key={i.id}><button onClick={() => { document.getElementById(i.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setOpen(false); }} className="w-full truncate rounded-lg px-3 py-1.5 text-left text-cream/90 hover:bg-raised">{i.label}</button></li>)}
        </ul>
      )}
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="rounded-full border border-line bg-surface/95 px-4 py-1.5 text-xs text-dust shadow-lg backdrop-blur hover:text-cream">On this page · {items.length}</button>
    </div>
  );
}
