import { C } from '@/lib/theme';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke, listen } from '@/lib/bridge';
import { fmtInt } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';

type Row = { service: string; status: string; account: string | null; lastSyncAt: string | null; lastError: string | null; playsAdded: number; extra: Record<string, unknown> };

const META: Record<string, { name: string; adds: string; color: string }> = {
  coverart: { name: 'Cover Art Archive', adds: 'Album art.', color: '#9C93AD' }, lyrics: { name: 'LRCLIB', adds: 'Lyric themes.', color: '#9C93AD' }, origin: { name: 'Artist origin', adds: 'Where your artists are from.', color: '#9C93AD' },
  spotify: { name: 'Spotify', adds: 'Live plays every 20 minutes (also from the tray), liked songs and playlists, real track lengths and release dates, and “add to queue” from any track row.', color: C.moss },
  lastfm: { name: 'Last.fm', adds: 'Genre and mood tags per artist, and the similar-artist graph that will power recommendations.', color: C.coral },
  musicbrainz: { name: 'MusicBrainz', adds: 'Canonical artist identities so renamed artists merge, plus folksonomy tags. No account needed.', color: C.amber },
  statsfm: { name: 'stats.fm', adds: 'Plays Spotify never recorded from other devices you pointed at stats.fm.', color: C.violet },
  lastfm_wild: { name: 'Heard in the Wild', adds: 'Songs your phone recognised out in the world (Google Now Playing, Shazam) via a Last.fm scrobbler. Kept as their own class — never counted as your listening.', color: '#F2C27B' },
};

export function ServicesPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => invoke<Row[]>('get_connectors').then((rs) => setRows((rs ?? []).map((r) => ({ ...r, extra: (r.extra && typeof r.extra === 'object' ? r.extra : {}) as Record<string, unknown>, playsAdded: Number(r.playsAdded ?? 0) })))).catch((e) => setErr(String(e)));
  useEffect(() => { load(); let un: (() => void) | undefined; listen('data:changed', load).then((u) => { un = u; }); return () => un?.(); }, []);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => {
    setBusy(label); setErr(null); setMsg(null);
    try { const r = await fn(); setMsg(ok ? ok(r) : 'Done.'); } catch (e) { setErr(String(e)); } finally { setBusy(null); load(); }
  };

  if (err && !rows) return <ErrorBox message={err} />;
  if (!rows) return <Loading />;
  const by = (s: string) => rows.find((r) => r.service === s);
  const sp = by('spotify'), lf = by('lastfm'), mb = by('musicbrainz'), sf = by('statsfm'), lb = by('listenbrainz'), wd = by('lastfm_wild');

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
        {wd && <ServiceCard row={wd} busy={busy} onSync={() => run('lastfm_wild', () => invoke<string>('sync_now', { service: 'lastfm_wild' }), (r) => String(r))}>
          <WildBody row={wd} busy={busy} run={run} lastfmConnected={lf?.status === 'connected'} />
        </ServiceCard>}
        {mb && <ServiceCard row={mb} busy={busy} onSync={() => run('musicbrainz', () => invoke<string>('sync_now', { service: 'musicbrainz' }), (r) => String(r))}>
          <p className="text-xs text-dust">{fmtInt(Number(mb.extra.resolvedArtists ?? 0))} artists resolved · {fmtInt(Number(mb.extra.taggedArtists ?? 0))} tagged. Works through your library a batch at a time, one request a second.</p>
          <div className="mt-4">
            {mb.status === 'connected'
              ? <button disabled={!!busy} onClick={() => run('mb', () => invoke('musicbrainz_disconnect'), () => 'MusicBrainz disconnected.')} className="text-sm text-dust hover:text-cream">Disconnect</button>
              : <button disabled={!!busy} onClick={() => run('mb', () => invoke('musicbrainz_connect'), () => 'MusicBrainz connected. Artists resolve in the background.')} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">Connect</button>}
          </div>
        </ServiceCard>}
        {lb && <ServiceCard row={lb} busy={busy} onSync={() => run('listenbrainz', () => invoke<string>('sync_now', { service: 'listenbrainz' }), (r) => String(r))}>
          <p className="text-xs text-dust">Similar artists are fetched for your resolved artists (MusicBrainz first) a few at a time.</p>
          <div className="mt-4">{lb.status === 'connected'
            ? <button disabled={!!busy} onClick={() => run('lb', () => invoke('listenbrainz_disconnect'), () => 'ListenBrainz disconnected.')} className="text-sm text-dust hover:text-cream">Disconnect</button>
            : <button disabled={!!busy} onClick={() => run('lb', () => invoke('listenbrainz_connect'), () => 'ListenBrainz connected.')} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">Connect</button>}</div>
        </ServiceCard>}
        {sf && <ServiceCard row={sf} busy={busy} onSync={() => run('statsfm', () => invoke<string>('sync_now', { service: 'statsfm' }), (r) => String(r))}>
          <StatsfmBody row={sf} busy={busy} run={run} />
        </ServiceCard>}
      </div>
    </div>
  );
}

function ServiceCard({ row, busy, onSync, children }: { row: Row; busy: string | null; onSync?: () => void; children: React.ReactNode }) {
  const m = META[row.service] ?? { name: row.service, adds: '', color: '#9C93AD' };
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
      {connected && row.extra.canQueue === false && (
        <div className="rounded-xl border border-amber/50 bg-amber/5 p-3 text-xs">
          <p className="text-cream">One-time reconnect needed for “add to queue”.</p>
          <p className="mt-1 text-dust">This version can drop any track onto your Spotify queue, which needs a permission (playback control) your existing connection was granted before it existed. Spotify fixes permissions at consent time, so connect once more — your record, tokens and playlists are untouched.</p>
          <button disabled={!!busy} onClick={() => run('spotify', () => invoke<string>('spotify_connect'), (r) => `Reconnected as ${String(r)}. Queue buttons are live.`)} className="mt-2 rounded-full bg-amber px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40">{busy === 'spotify' ? 'Waiting for your browser…' : 'Reconnect Spotify'}</button>
        </div>
      )}
      {connected && (
        <div className="num text-xs text-dust">
          <p>{fmtInt(Number(row.extra.likedSongs ?? 0))} liked songs · {fmtInt(Number(row.extra.enrichedTracks ?? 0))} of {fmtInt(Number(row.extra.totalTracks ?? 0))} tracks enriched{row.extra.paused ? <span className="text-amber"> · quota reached, enrichment resumes at midnight</span> : ''}</p>
          <p className="mt-1">{fmtInt(Number(row.extra.callsLastHour ?? 0))} Spotify calls in the last hour · enrichment capped at {fmtInt(Number(row.extra.enrichPerHour ?? 100))}/h (<Link to="/settings" className="underline hover:text-cream">change</Link>){row.extra.canQueue ? ' · queue enabled' : ''}</p>
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

function WildBody({ row, busy, run, lastfmConnected }: { row: Row; busy: string | null; run: Run; lastfmConnected: boolean }) {
  const [user, setUser] = useState('');
  const [since, setSince] = useState(() => new Date().toISOString().slice(0, 10));
  const x = row.extra;
  const songs = Number(x.songs ?? 0), matched = Number(x.matchedSongs ?? 0);
  const suspicious = songs >= 20 && matched / songs >= 0.6;   // most captures are songs already in your record → the phone is scrobbling Spotify
  const [resetOpen, setResetOpen] = useState(false);
  if (row.status === 'connected') return (
    <div className="text-xs text-dust">
      <p className="num">{fmtInt(Number(x.captures ?? 0))} captures · {fmtInt(Number(x.neverStreamed ?? 0))} songs you've never streamed · {fmtInt(Number(x.dropped ?? 0))} dropped as your own Spotify playback{x.account ? ` · account ${String(x.account)}` : ''}{x.since ? ` · since ${String(x.since)}` : ''}{x.backfillDone === false ? ' · still back-filling' : ''}</p>
      {suspicious && (
        <div className="mt-2 rounded-xl border border-coral/50 bg-coral/5 p-3 text-coral">
          <p><span className="font-medium">This looks like your own Spotify, not the wild.</span> {fmtInt(matched)} of {fmtInt(songs)} captured songs are already in your record — that's the pattern when Pano is scrobbling the Spotify app, or when the Last.fm account it writes to is also fed by Spotify. Point Pano at a Last.fm account only it uses, then purge and re-point here.</p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button disabled={!!busy} onClick={() => run('wild', () => invoke('lastfm_wild_disconnect'), () => 'Heard in the Wild disconnected. Captures already imported are kept.')} className="text-dust hover:text-cream">Disconnect</button>
        <button onClick={() => setResetOpen(!resetOpen)} className={suspicious ? 'text-coral hover:text-cream' : 'text-dust hover:text-cream'}>Purge & re-point to another account…</button>
      </div>
      {resetOpen && (
        <div className="mt-2 rounded-xl border border-line bg-ink/40 p-3">
          <p>Deletes every capture (and your pins/hides on them), then connects to the account below. Your Spotify record is untouched — captures live in their own class.</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Last.fm account only Pano writes to" className="rounded-lg border border-line bg-ink px-3 py-1.5 text-xs" />
            <input value={since} onChange={(e) => setSince(e.target.value)} type="date" className="num rounded-lg border border-line bg-ink px-3 py-1.5 text-xs" />
            <button disabled={!!busy || !user.trim()} onClick={() => run('wild', () => invoke<{ purged: number; account: string }>('lastfm_wild_reset', { username: user.trim(), since: since || null }), (r) => { const v = r as { purged: number; account: string }; setResetOpen(false); return `Purged ${fmtInt(v.purged)} captures and re-pointed Heard in the Wild at ${v.account}. Sync now to pull from the new account.`; })} className="rounded-full bg-coral px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40">Purge & re-point</button>
          </div>
        </div>
      )}
      <p className="mt-2">Pulls every 30 minutes. The desktop check drops a capture that lands while your own Spotify was playing the same artist — but it can only do that for plays that reached the record, so the real defence is a Last.fm account only Pano writes to. <Link to="/wild" className="underline hover:text-cream">Open Heard in the Wild</Link>.</p>
    </div>
  );
  return (
    <div className="rounded-xl border border-line bg-ink/40 p-3 text-xs text-dust">
      {!lastfmConnected && <p className="mb-2 text-amber">Connect Last.fm above first — this reuses its API key.</p>}
      <p className="text-cream/80">On your phone (once):</p>
      <ol className="mt-1 list-decimal space-y-0.5 pl-4">
        <li>Install <span className="text-cream">Pano Scrobbler</span> and sign it in to Last.fm.</li>
        <li>In Pano, enable scrobbling for <span className="text-cream">Now Playing</span> (Pixel ambient recognition) and <span className="text-cream">Shazam</span>.</li>
        <li><span className="text-cream">Turn Spotify off</span> in Pano's app list — Spotify's own history is already in your record. Better still, give Pano its own Last.fm account and enter it below; then nothing you play on purpose can ever land here.</li>
      </ol>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Last.fm account Pano writes to (blank = same as above)" className="rounded-lg border border-line bg-ink px-3 py-1.5 text-xs" />
        <input value={since} onChange={(e) => setSince(e.target.value)} type="date" title="Only import captures on or after this date" className="num rounded-lg border border-line bg-ink px-3 py-1.5 text-xs" />
        <button disabled={!!busy || !lastfmConnected} onClick={() => run('wild', () => invoke<string>('lastfm_wild_connect', { username: user.trim() || null, since: since || null }), (r) => `Heard in the Wild set up for ${String(r)}. Captures arrive within 30 minutes; use Sync now to pull immediately.`)} className="rounded-full bg-amber px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40">Set up</button>
      </div>
      <p className="mt-2 text-dust/70">“Since” defaults to today so an existing Last.fm history isn't mistaken for things you overheard. Per-app origin (Shazam vs. Now Playing) isn't recoverable from Last.fm, so both land in one bucket.</p>
    </div>
  );
}
