import { useState } from 'react';
import { Link } from 'react-router-dom';
import { blend } from '@/lib/phase4Queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { inTauri, invoke } from '@/lib/bridge';
import { artistHref, fmtInt } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { RankedBars } from '@/components/Lists';

export function BlendPage() {
  const { filter } = useFilter();
  const { data, error, reload } = useAsync(blend, [filter]);
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (p: string) => { setBusy(true); setMsg(null); try { const n = await invoke<number>('import_blend', { path: p, label: label || 'Friend' }); setMsg(`Imported ${fmtInt(n)} track rows for ${label || 'Friend'}.`); reload(); } catch (e) { setMsg(String(e)); } finally { setBusy(false); } };
  const pick = async () => { if (!inTauri) return; const { open } = await import('@tauri-apps/plugin-dialog'); const sel = await open({ multiple: false, filters: [{ name: 'Spotify export', extensions: ['zip'] }] }); if (typeof sel === 'string') void run(sel); };
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Blend" title={data.present ? `You and ${data.label}` : 'Blend with someone'} meta="Import a friend's Spotify export. It's aggregated (artist and track totals only), kept separate from your record, and never leaves this machine." />
      <Card title={data.present ? `Swap in a different export` : `Add an export`}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Their name" className="rounded-full border border-line bg-ink px-4 py-1.5 text-sm" />
          {inTauri ? <button disabled={busy} onClick={pick} className="rounded-full bg-amber px-4 py-1.5 font-medium text-ink disabled:opacity-40">{busy ? 'Importing…' : 'Choose their zip'}</button>
            : <><input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/their_spotify_data.zip (browser dev mode)" className="num flex-1 rounded-full border border-line bg-ink px-4 py-1.5 text-xs" /><button disabled={busy || !path} onClick={() => run(path)} className="rounded-full bg-amber px-4 py-1.5 font-medium text-ink disabled:opacity-40">Import</button></>}
          {data.present && <button disabled={busy} onClick={async () => { await invoke('clear_blend'); reload(); }} className="text-xs text-dust hover:text-coral">Remove blend data</button>}
        </div>
        {msg && <p className="mt-2 text-xs text-dust">{msg}</p>}
      </Card>
      {data.present && (
        <>
          <section className="mt-6 grid gap-6 md:grid-cols-3">
            <Card title="In common" subtitle={`${fmtInt(data.overlapArtists)} artists you've both played. Ranked by mutual love.`}>
              <ul className="divide-y divide-line/60 text-sm">{data.sharedTop.map((s) => <li key={s.artist} className="flex justify-between gap-3 py-1.5"><span className="truncate">{s.artist}</span><span className="num shrink-0 text-xs text-dust">you {fmtInt(s.yours)} · them {fmtInt(s.theirs)}</span></li>)}</ul>
            </Card>
            <Card title={`You'd probably like`} subtitle={`${data.label}'s most-played artists you've never touched.`}>
              <ul className="divide-y divide-line/60 text-sm">{data.youdLike.map((s) => <li key={s.artist} className="flex justify-between gap-3 py-1.5"><a href={`https://open.spotify.com/search/${encodeURIComponent(s.artist)}`} target="_blank" rel="noreferrer" className="truncate hover:text-amber">{s.artist}</a><span className="num shrink-0 text-xs text-dust">{fmtInt(s.theirs)} plays</span></li>)}</ul>
            </Card>
            <Card title={`${data.label} would probably like`} subtitle="Your heavy rotation they've never played."><RankedBars data={data.theydLike.slice(0, 10)} /></Card>
          </section>
          <div className="mt-6">
            <Card title="Blend playlist" subtitle="Songs you both play, ranked by the harmonic mean of your play counts — nothing lopsided." aside={<MakePlaylistButton name={`Blend · you and ${data.label}`} tracks={data.blendTracks} kind="insight" description={`Songs we both play. Made with Deep Cuts.`} note={`blend:${data.label}`} pool={data.blendTracks} />}>
              <ol className="grid gap-x-8 gap-y-1 text-sm md:grid-cols-2">{data.blendTracks.map((t, i) => <li key={t.trackId} className="flex gap-2 truncate"><span className="num w-6 text-xs text-dust">{i + 1}</span><Link to={`/track/${encodeURIComponent(t.trackId)}`} className="truncate hover:text-amber">{t.track}</Link>{t.artistId ? <Link to={artistHref(t.artistId)} className="truncate text-xs text-dust hover:text-amber">{t.artist}</Link> : <span className="truncate text-xs text-dust">{t.artist}</span>}</li>)}</ol>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
