import { C } from '@/lib/theme';
import { useEffect, useState } from 'react';
import { invoke, listen } from '@/lib/bridge';
import { fmtInt } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';

type Row = { service: string; status: string; account: string | null; lastSyncAt: string | null; lastError: string | null; playsAdded: number; extra: Record<string, unknown> };

const META: Record<string, { name: string; adds: string; color: string }> = {
  spotify: { name: 'Spotify', adds: 'Live plays every 20 minutes (also from the tray), liked songs and playlists, real track lengths and release dates.', color: C.moss },
  lastfm: { name: 'Last.fm', adds: 'Genre and mood tags per artist, and the similar-artist graph that will power recommendations.', color: C.coral },
  musicbrainz: { name: 'MusicBrainz', adds: 'Canonical artist identities so renamed artists merge, plus folksonomy tags. No account needed.', color: C.amber },
  statsfm: { name: 'stats.fm', adds: 'Plays Spotify never recorded from other devices you pointed at stats.fm.', color: C.violet },
};

export function ServicesPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => invoke<Row[]>('get_connectors').then(setRows).catch((e) => setErr(String(e)));
  useEffect(() => { load(); let un: (() => void) | undefined; listen('data:changed', load).then((u) => { un = u; }); return () => un?.(); }, []);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => {
    setBusy(label); setErr(null); setMsg(null);
    try { const r = await fn(); setMsg(ok ? ok(r) : 'Done.'); } catch (e) { setErr(String(e)); } finally { setBusy(null); load(); }
  };

  if (err && !rows) return <ErrorBox message={err} />;
  if (!rows) return <Loading />;
  const by = (s: string) => rows.find((r) => r.service === s);
  const sp = by('spotify'), lf = by('lastfm'), mb = by('musicbrainz'), sf = by('statsfm');

  return (
    <div className="mx-auto max-w-5xl">
      <Sleeve kicker="Services" title="Connect what you already use" meta="Each connector adds one thing to the record. Every play from every source is deduplicated; nothing overwrites your history. Keys live in your OS keyring." />
      {msg && <div className="mb-4 rounded-xl border border-moss/40 bg-moss/5 px-4 py-3 text-sm text-moss">{msg}</div>}
      {err && <div className="mb-4"><ErrorBox message={err} /></div>}

      <div className="grid gap-4 md:grid-cols-2">
        {sp && <ServiceCard row={sp} busy={busy} onSync={() => run('spotify', () => invoke<string>('sync_now', { service: 'spotify' }), (r) => String(r))}>
          <SpotifyBody row={sp} busy={busy} run={run} />
        </ServiceCard>}
        {lf && <ServiceCard row={lf} busy={busy} onSync={() => run('lastfm', () => invoke<string>('sync_now', { service: 'lastfm' }), (r) => String(r))}>
          <LastfmBody row={lf} busy={busy} run={run} />
        </ServiceCard>}
        {mb && <ServiceCard row={mb} busy={busy} onSync={() => run('musicbrainz', () => invoke<string>('sync_now', { service: 'musicbrainz' }), (r) => String(r))}>
          <p className="text-xs text-dust">{fmtInt(Number(mb.extra.resolvedArtists ?? 0))} artists resolved · {fmtInt(Number(mb.extra.taggedArtists ?? 0))} tagged. Works through your library a batch at a time, one request a second.</p>
          <div className="mt-4">
            {mb.status === 'connected'
              ? <button disabled={!!busy} onClick={() => run('mb', () => invoke('musicbrainz_disconnect'), () => 'MusicBrainz disconnected.')} className="text-sm text-dust hover:text-cream">Disconnect</button>
              : <button disabled={!!busy} onClick={() => run('mb', () => invoke('musicbrainz_connect'), () => 'MusicBrainz connected. Artists resolve in the background.')} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">Connect</button>}
          </div>
        </ServiceCard>}
        {sf && <ServiceCard row={sf} busy={busy} onSync={() => run('statsfm', () => invoke<string>('sync_now', { service: 'statsfm' }), (r) => String(r))}>
          <StatsfmBody row={sf} busy={busy} run={run} />
        </ServiceCard>}
      </div>
    </div>
  );
}

function ServiceCard({ row, busy, onSync, children }: { row: Row; busy: string | null; onSync?: () => void; children: React.ReactNode }) {
  const m = META[row.service];
  const dot = row.status === 'connected' ? 'bg-moss' : row.status === 'error' ? 'bg-coral' : row.status === 'paused' ? 'bg-amber' : 'bg-line';
  return (
    <Card title={m.name} aside={<span className="flex items-center gap-2 text-xs text-dust"><span className={`inline-block h-2 w-2 rounded-full ${dot}`} />{row.status}{row.account ? ` · ${row.account}` : ''}</span>}>
      <div className="-mt-2 mb-3 h-1 w-10 rounded-full" style={{ background: m.color }} />
      <p className="text-sm">{m.adds}</p>
      <div className="mt-3 space-y-3">{children}</div>
      <div className="num mt-4 flex flex-wrap items-center gap-3 text-xs text-dust">
        {row.lastSyncAt && <span>last sync {row.lastSyncAt.slice(0, 16)}</span>}
        {row.playsAdded > 0 && <span>+{fmtInt(row.playsAdded)} plays from this source</span>}
        {row.status === 'connected' && onSync && <button disabled={!!busy} onClick={onSync} className="ml-auto rounded-full border border-line px-3 py-1 text-dust hover:text-cream disabled:opacity-40">{busy === row.service ? 'Syncing…' : 'Sync now'}</button>}
      </div>
      {row.lastError && <p className="mt-2 text-xs text-coral">{row.lastError}</p>}
    </Card>
  );
}

type Run = (label: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => Promise<void>;

function SpotifyBody({ row, busy, run }: { row: Row; busy: string | null; run: Run }) {
  const [cid, setCid] = useState('');
  const hasClient = Boolean(row.extra.hasClientId);
  const connected = Boolean(row.extra.connected);
  return (
    <div>
      {!hasClient && (
        <div className="rounded-xl border border-line bg-ink/40 p-3 text-xs text-dust">
          <p className="text-cream/80">One-time setup (2 minutes):</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>Open developer.spotify.com/dashboard and create an app.</li>
            <li>Redirect URI: <span className="num text-cream">http://127.0.0.1:8888/callback</span> (the IP, not localhost). API: Web API.</li>
            <li>Copy the Client ID and paste it here.</li>
          </ol>
          <div className="mt-2 flex gap-2">
            <input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="Client ID" className="num flex-1 rounded-lg border border-line bg-ink px-3 py-1.5 text-xs" />
            <button disabled={!!busy || cid.trim().length < 32} onClick={() => run('cid', () => invoke('spotify_set_client_id', { clientId: cid }), () => 'Client ID saved. Now connect.')} className="rounded-full bg-amber px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40">Save</button>
          </div>
        </div>
      )}
      {hasClient && !connected && (
        <button disabled={!!busy} onClick={() => run('spotify', () => invoke<string>('spotify_connect'), (r) => `Connected as ${String(r)}. Plays will start arriving within 20 minutes.`)} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">
          {busy === 'spotify' ? 'Waiting for your browser…' : 'Connect Spotify'}
        </button>
      )}
      {connected && (
        <div className="num text-xs text-dust">
          <p>{fmtInt(Number(row.extra.likedSongs ?? 0))} liked songs · {fmtInt(Number(row.extra.enrichedTracks ?? 0))} of {fmtInt(Number(row.extra.totalTracks ?? 0))} tracks enriched{row.extra.paused ? <span className="text-amber"> · quota reached, enrichment resumes at midnight</span> : ''}</p>
          <button disabled={!!busy} onClick={() => run('spotify', () => invoke('spotify_disconnect'), () => 'Spotify disconnected.')} className="mt-2 text-dust hover:text-cream">Disconnect</button>
        </div>
      )}
      <p className="mt-2 text-xs text-dust/70">Spotify's development-mode rules: no genres, popularity or recommendations from Spotify itself; individual metadata calls under a daily quota. A quota hit pauses enrichment, never the app.</p>
    </div>
  );
}

function LastfmBody({ row, busy, run }: { row: Row; busy: string | null; run: Run }) {
  const [key, setKey] = useState(''); const [user, setUser] = useState('');
  if (row.status === 'connected') return (
    <div className="num text-xs text-dust">
      <p>{fmtInt(Number(row.extra.taggedArtists ?? 0))} artists tagged so far. Tags top up in the background a few dozen artists at a time.</p>
      <button disabled={!!busy} onClick={() => run('lastfm', () => invoke('lastfm_disconnect'), () => 'Last.fm disconnected. Tags already fetched are kept.')} className="mt-2 text-dust hover:text-cream">Disconnect</button>
    </div>
  );
  return (
    <div className="rounded-xl border border-line bg-ink/40 p-3 text-xs text-dust">
      <p className="text-cream/80">Free API key: last.fm/api/account/create (any name and description). Paste the key and your username.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Last.fm username" className="rounded-lg border border-line bg-ink px-3 py-1.5 text-xs" />
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" type="password" className="num rounded-lg border border-line bg-ink px-3 py-1.5 text-xs" />
        <button disabled={!!busy || key.trim().length < 20 || !user.trim()} onClick={() => run('lastfm', () => invoke<string>('lastfm_connect', { apiKey: key, username: user }), (r) => `Connected to Last.fm as ${String(r)}.`)} className="rounded-full bg-amber px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40">Connect</button>
      </div>
    </div>
  );
}

function StatsfmBody({ row, busy, run }: { row: Row; busy: string | null; run: Run }) {
  const [key, setKey] = useState('');
  if (row.status === 'connected') return (
    <div className="text-xs text-dust">
      <p>Newest streams are pulled every 6 hours and stop where your record already has them. Only plays Spotify's export missed are added.</p>
      <button disabled={!!busy} onClick={() => run('statsfm', () => invoke('statsfm_disconnect'), () => 'stats.fm disconnected.')} className="mt-2 text-dust hover:text-cream">Disconnect</button>
    </div>
  );
  return (
    <div className="rounded-xl border border-line bg-ink/40 p-3 text-xs text-dust">
      <p className="text-cream/80">Paste your personal stats.fm API key (Settings → API on stats.fm; needs stats.fm Plus for full streams).</p>
      <div className="mt-2 flex gap-2">
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" type="password" className="num flex-1 rounded-lg border border-line bg-ink px-3 py-1.5 text-xs" />
        <button disabled={!!busy || key.trim().length < 10} onClick={() => run('statsfm', () => invoke<string>('statsfm_connect', { apiKey: key }), (r) => `Connected to stats.fm as ${String(r)}. First import runs in the background.`)} className="rounded-full bg-amber px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40">Connect</button>
      </div>
    </div>
  );
}
