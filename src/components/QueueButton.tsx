import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { invoke, listen } from '@/lib/bridge';

/**
 * Phase 9b (design brief §5): one small "queue on Spotify" icon button that every track row imports,
 * so any new list surface gets it for free. All three outcomes people will actually hit live here —
 * queued ✓, "nothing is playing", "reconnect Spotify once" — rather than being re-implemented per page.
 *
 * `QueueProvider` reads the Spotify connector once (connected? has the playback scope?) so the button
 * can render disabled with the right hint instead of failing on click, and keeps a short-lived toast.
 */
type Outcome = { status: 'queued' | 'no_device' | 'needs_reauth' | 'not_connected' | 'quota' | 'unqueueable' | 'error'; message: string };
type Ctx = { connected: boolean; canQueue: boolean; ready: boolean; queue: (trackId: string) => Promise<Outcome> };
const QueueContext = createContext<Ctx>({ connected: false, canQueue: false, ready: false, queue: async () => ({ status: 'not_connected', message: 'Spotify is not connected.' }) });
export const useQueue = () => useContext(QueueContext);

export function QueueProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ connected: false, canQueue: false, ready: false });
  const [toast, setToast] = useState<Outcome | null>(null);
  const timer = useRef<number | null>(null);
  const load = () => invoke<{ service: string; extra?: Record<string, unknown> }[]>('get_connectors')
    .then((rows) => { const sp = rows.find((r) => r.service === 'spotify'); setState({ connected: Boolean(sp?.extra?.connected), canQueue: Boolean(sp?.extra?.canQueue), ready: true }); })
    .catch(() => setState((s) => ({ ...s, ready: true })));
  useEffect(() => { load(); let un: (() => void) | undefined; listen('data:changed', load).then((u) => { un = u; }); return () => un?.(); }, []);
  const queue = async (trackId: string): Promise<Outcome> => {
    let o: Outcome;
    try { o = await invoke<Outcome>('queue_track', { trackId }); } catch (e) { o = { status: 'error', message: String(e) }; }
    if (o.status === 'needs_reauth' || o.status === 'not_connected') load();
    setToast(o);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), o.status === 'queued' ? 2500 : 6000);
    return o;
  };
  return (
    <QueueContext.Provider value={{ ...state, queue }}>
      {children}
      {toast && (
        <div role="status" className={`fixed bottom-5 right-6 z-50 max-w-sm rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur ${toast.status === 'queued' ? 'border-moss/50 bg-ink/90 text-moss' : 'border-amber/50 bg-ink/90 text-cream'}`}>
          {toast.status === 'queued' ? '✓ ' : ''}{toast.message}{toast.status === 'needs_reauth' || toast.status === 'not_connected' ? <> <Link to="/services" className="underline hover:text-amber">Open Services</Link></> : null}
        </div>
      )}
    </QueueContext.Provider>
  );
}

/** Icon button. Disabled (not erroring) for tracks without a Spotify id; explains itself on hover. `always` keeps it visible even when Spotify isn't connected (hidden by default in that case to keep lists quiet). */
export function QueueButton({ trackId, className = '', always = false, size = 14 }: { trackId: string | null | undefined; className?: string; always?: boolean; size?: number }) {
  const { connected, canQueue, ready, queue } = useQueue();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const local = !trackId || trackId.startsWith('local:');
  if (!ready || (!connected && !always)) return null;
  const title = local ? 'No Spotify id for this track — can\'t queue it' : !connected ? 'Connect Spotify in Services to queue tracks' : !canQueue ? 'Reconnect Spotify once in Services to enable queueing' : done ? 'Queued' : 'Add to your Spotify queue';
  const click = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (local || busy) return;
    setBusy(true);
    const o = await queue(trackId!);
    setBusy(false);
    if (o.status === 'queued') { setDone(true); window.setTimeout(() => setDone(false), 2500); }
  };
  return (
    <button type="button" onClick={click} disabled={local || busy} aria-label={title} title={title}
      className={`inline-flex shrink-0 items-center justify-center rounded-full border p-1 transition ${done ? 'border-moss text-moss' : local || !connected ? 'border-line/60 text-dust/40' : !canQueue ? 'border-amber/40 text-amber/70 hover:text-amber' : 'border-line text-dust hover:border-amber hover:text-amber'} disabled:cursor-not-allowed ${className}`}>
      {done ? (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M3 8.5l3 3 7-7" /></svg>
      ) : busy ? (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className="spin"><circle cx="8" cy="8" r="5.5" strokeDasharray="20 14" /></svg>
      ) : (
        // "add to the end of a list": three lines, a plus tucked at the bottom right
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M2.5 4h11M2.5 8h11M2.5 12h5.5M12 9.5v5M9.5 12h5" /></svg>
      )}
    </button>
  );
}
