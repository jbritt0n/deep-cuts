/**
 * The one place the UI touches the host. In the Tauri app this is `invoke` /
 * `listen`; in `vite --mode browser` it talks to dev-server.mjs so the UI can
 * be iterated in a normal browser against a DuckDB file.
 */
/** Browser mode talks to dev-server.mjs. Same origin when that server also serves the app (Docker); the dev harness on :1420 talks to :4747. */
const API_BASE: string = typeof location !== 'undefined' && location.protocol.startsWith('http') && location.port !== '1420' ? location.origin : 'http://localhost:4747';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { toDeepCutsError } from './errors';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Every failure comes out as a DeepCutsError ("[code] detail") — Phase 10b error envelope, see errors.ts. */
export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) { try { return await tauriInvoke<T>(cmd, args); } catch (e) { throw toDeepCutsError(e); } }
  let res: Response;
  try { res = await fetch(`${API_BASE}/${cmd}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) }); }
  catch (e) { throw toDeepCutsError(`network: could not reach the Deep Cuts server (${String((e as Error)?.message ?? e)})`); }
  if (!res.ok) throw toDeepCutsError(await res.text());
  return (await res.json()) as T;
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (inTauri) return tauriListen<T>(event, (e) => handler(e.payload));
  // Browser dev: poll a tiny event queue.
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      try {
        const r = await fetch(`${API_BASE}/_events?name=${encodeURIComponent(event)}`);
        const items = (await r.json()) as T[];
        items.forEach(handler);
      } catch { /* server down */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  void tick();
  return () => { stopped = true; };
}
