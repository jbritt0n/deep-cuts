/**
 * The one place the UI touches the host. In the Tauri app this is `invoke` /
 * `listen`; in `vite --mode browser` it talks to dev-server.mjs so the UI can
 * be iterated in a normal browser against a DuckDB file.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) return tauriInvoke<T>(cmd, args);
  const res = await fetch(`http://localhost:4747/${cmd}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (inTauri) return tauriListen<T>(event, (e) => handler(e.payload));
  // Browser dev: poll a tiny event queue.
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      try {
        const r = await fetch(`http://localhost:4747/_events?name=${encodeURIComponent(event)}`);
        const items = (await r.json()) as T[];
        items.forEach(handler);
      } catch { /* server down */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  void tick();
  return () => { stopped = true; };
}
