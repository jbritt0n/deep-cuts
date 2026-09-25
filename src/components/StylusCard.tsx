import { confirmDialog } from '@/components/Overlay';
import { useState } from 'react';
import { Card, ErrorBox } from '@/components/Card';
import { invoke } from '@/lib/bridge';
import { query, num, str } from '@/lib/db';
import { fmtDate, fmtInt } from '@/lib/format';
import { useAsync } from '@/lib/hooks';

type Device = { id: string; name: string; tsPrecision: 'exact' | 'minute' | 'hour'; keepPlayer: boolean; keepService: boolean; keepDevice: boolean; paused: boolean; retentionDays: number | null; lastSeen: string | null; accepted: number; duplicates: number; discarded: number; now: string | null };
async function load() {
  const cfg = Object.fromEntries((await query(`SELECT key, value FROM app_meta WHERE key IN ('stylus_enabled', 'stylus_port', 'stylus_lan')`)).map((r) => [String(r.key), String(r.value)]));
  const devices: Device[] = (await query(`SELECT d.*, CAST(d.last_seen_at AS VARCHAR) AS seen, n.artist_name || ' — ' || n.track_name AS now_playing, n.since > now() - INTERVAL 15 MINUTE AS fresh FROM stylus_devices d LEFT JOIN stylus_now_playing n USING (device_id) ORDER BY d.created_at`))
    .map((r) => ({ id: String(r.device_id), name: String(r.name), tsPrecision: (str(r.ts_precision) ?? 'exact') as Device['tsPrecision'], keepPlayer: Boolean(r.keep_player), keepService: Boolean(r.keep_service), keepDevice: Boolean(r.keep_device), paused: Boolean(r.paused), retentionDays: r.retention_days == null ? null : num(r.retention_days), lastSeen: str(r.seen), accepted: num(r.accepted), duplicates: num(r.duplicates), discarded: num(r.discarded), now: r.fresh ? str(r.now_playing) : null }));
  const [p] = await query(`SELECT COUNT(*) AS n FROM plays_resolved WHERE platform LIKE 'stylus%'`);
  const status = await invoke<{ running: string | null; defaultPort: number }>('stylus_status');
  return { enabled: cfg.stylus_enabled === 'true', port: Number(cfg.stylus_port) || status.defaultPort, lan: cfg.stylus_lan === 'true', running: status.running, devices, plays: num(p?.n) };
}

/**
 * Phase 9m — Services → Stylus. Deep Cuts' own scrobble receiver, speaking the ListenBrainz API: point Pano Scrobbler
 * (Android), Web Scrobbler (browser), multi-scrobbler (Docker), Navidrome or Jellyfin at it with a device token.
 */
export function StylusCard() {
  const [tick, setTick] = useState(0);
  const s = useAsync(load, [tick]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(''); const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [port, setPort] = useState<string>('');
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(String(e)); } finally { setBusy(false); setTick((t) => t + 1); } };
  if (!s.data) return <Card title="Stylus">{s.error ? <ErrorBox message={s.error} /> : <p className="text-sm text-dust">Loading…</p>}</Card>;
  const d = s.data; const p = Number(port) || d.port;
  const host = d.lan ? '<this computer’s address on your network>' : '127.0.0.1';
  const base = `http://${host}:${d.port}`;
  const configure = (enabled: boolean, lan = d.lan) => run(() => invoke('stylus_configure', { enabled, port: p, lan }));
  return (
    <Card title="Stylus — your own scrobbler" subtitle="Record listening from anywhere Spotify can't see — Bandcamp in a browser, YouTube Music on your phone, a local player — by pointing any ListenBrainz-compatible scrobbler at Deep Cuts. Spotify plays it also scrobbles are recognised and not counted twice.">
      {err && <div className="mb-2"><ErrorBox message={err} /></div>}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={d.enabled} disabled={busy} onChange={(e) => configure(e.target.checked)} /> Receiver on</label>
        <label className="flex items-center gap-1 text-xs text-dust">port <input value={port || String(d.port)} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} onBlur={() => { if (d.enabled && Number(port) && Number(port) !== d.port) void configure(true); }} className="num w-16 rounded border border-line bg-ink px-1.5 py-0.5 text-xs text-cream" /></label>
        <label className="flex items-center gap-2 text-xs text-dust" title="Off: only scrobblers on this computer can reach it. On: phones and other computers on your home network can too."><input type="checkbox" checked={d.lan} disabled={busy} onChange={(e) => configure(d.enabled, e.target.checked)} /> allow other devices on my network</label>
        <span className={`num ml-auto text-xs ${d.running ? 'text-moss' : 'text-dust'}`}>{d.running ? `listening on ${d.running}` : 'stopped'} · {fmtInt(d.plays)} plays so far</span>
      </div>
      {d.lan && <p className="mt-1 text-[11px] text-amber">Reachable by anyone on your network who has a token. For phones away from home, use a relay (planned: Stylus S3) — don't forward this port to the internet.</p>}

      <div className="mt-4">
        <p className="text-xs text-dust">Devices — one token each, so you can pause or revoke one without touching the others</p>
        {d.devices.length === 0 && <p className="mt-1 text-sm text-dust">No devices yet.</p>}
        <ul className="mt-1 space-y-2">{d.devices.map((v) => <DeviceRow key={v.id} v={v} busy={busy} run={run} />)}</ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New device, e.g. Pixel phone" className="min-w-[12rem] flex-1 rounded-lg border border-line bg-ink px-3 py-1.5 text-sm" />
          <button disabled={busy || !name.trim()} onClick={() => run(async () => { const r = await invoke<{ token: string }>('stylus_add_device', { name }); setFresh({ name: name.trim(), token: r.token }); setName(''); })} className="rounded-full border border-amber/60 px-3 py-1.5 text-xs text-amber hover:bg-amber/10 disabled:opacity-40">Add device</button>
        </div>
      </div>

      {fresh && (
        <div className="mt-4 rounded-xl border border-amber/50 bg-amber/5 p-4 text-sm">
          <p className="font-medium">Token for {fresh.name} — copy it now, it won't be shown again</p>
          <p className="num mt-2 select-all break-all rounded bg-ink px-2 py-1.5 text-xs">{fresh.token}</p>
          <p className="mt-3 text-xs text-dust">In the scrobbler, choose <span className="text-cream">ListenBrainz</span> with a custom server and enter:</p>
          <ul className="mt-1 space-y-0.5 text-xs"><li>Server / API URL: <span className="num select-all text-cream">{base}</span> <span className="text-dust">(some apps want the full <span className="num select-all">{base}/1/submit-listens</span>)</span></li><li>User token: the token above</li></ul>
          <p className="mt-2 text-[11px] text-dust">Pano Scrobbler (Android) · Web Scrobbler (browser extension) · multi-scrobbler (Docker) · Navidrome, Jellyfin and most desktop players with a ListenBrainz plugin all work. {!d.enabled && <span className="text-amber">Turn the receiver on above first.</span>}</p>
          <button onClick={() => setFresh(null)} className="mt-2 text-xs text-dust hover:text-cream">Done</button>
        </div>
      )}
    </Card>
  );
}

function DeviceRow({ v, busy, run }: { v: Device; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const set = (patch: Partial<Device>) => { const n = { ...v, ...patch }; return run(() => invoke('stylus_update_device', { deviceId: v.id, tsPrecision: n.tsPrecision, keepPlayer: n.keepPlayer, keepService: n.keepService, keepDevice: n.keepDevice, paused: n.paused, retentionDays: n.retentionDays })); };
  return (
    <li className={`rounded-lg border border-line/70 p-3 text-sm ${v.paused ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{v.name}</span>
        <span className="num text-[11px] text-dust">{fmtInt(v.accepted)} kept · {fmtInt(v.duplicates)} already known{v.discarded ? ` · ${fmtInt(v.discarded)} discarded while paused` : ''}{v.lastSeen ? ` · last ${fmtDate(v.lastSeen, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ' · never connected'}</span>
        <button disabled={busy} onClick={() => { void confirmDialog(`Revoke ${v.name}'s token? Its plays stay in your record.`).then((ok) => { if (ok) void run(() => invoke('stylus_remove_device', { deviceId: v.id })); }); }} className="ml-auto text-xs text-dust hover:text-coral">revoke</button>
      </div>
      {v.now && <p className="mt-1 text-xs text-moss">▶ now playing: {v.now}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-dust">
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.paused} disabled={busy} onChange={(e) => set({ paused: e.target.checked })} /> pause (accept and discard)</label>
        <label className="flex items-center gap-1">time kept<select value={v.tsPrecision} disabled={busy} onChange={(e) => set({ tsPrecision: e.target.value as Device['tsPrecision'] })} className="rounded border border-line bg-ink px-1 py-0.5 text-cream"><option value="exact">exact</option><option value="minute">to the minute</option><option value="hour">to the hour</option></select></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.keepPlayer} disabled={busy} onChange={(e) => set({ keepPlayer: e.target.checked })} /> player</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.keepService} disabled={busy} onChange={(e) => set({ keepService: e.target.checked })} /> service</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.keepDevice} disabled={busy} onChange={(e) => set({ keepDevice: e.target.checked })} /> device name</label>
        <label className="flex items-center gap-1" title="After this, the player, service and device name are removed from this device's scrobbles; the plays themselves stay.">details kept<select value={v.retentionDays ?? 0} disabled={busy} onChange={(e) => set({ retentionDays: Number(e.target.value) || null })} className="rounded border border-line bg-ink px-1 py-0.5 text-cream"><option value={0}>forever</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select></label>
      </div>
    </li>
  );
}
