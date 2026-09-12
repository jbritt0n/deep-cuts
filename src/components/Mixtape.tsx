import { useState } from 'react';
import { settingRaw } from '@/lib/settings';
import { inTauri, invoke } from '@/lib/bridge';
import { mixtapeArtists } from '@/lib/phase7Queries';
import { curated } from '@/lib/recQueries';
import { usePlaylistMaker } from './PlaylistMaker';
import type { TrackRow } from '@/lib/types';

/** Mixtape builder: choose the blend of engines and a length; Spotify search fills in artists you don't own. */
export function MixtapeBuilder() {
  const { open } = usePlaylistMaker();
  const DEFAULT_MIX = { adjacency: 40, tag: 20, lb: 20, gaps: 20 };
  // Phase 9c: remember the last mix (Settings → Tuning → Preferences) instead of resetting to 40/20/20/20 every time.
  const [mix, setMix] = useState(() => { try { const raw = settingRaw('mixtape_last_mix'); const v = raw ? JSON.parse(raw) as typeof DEFAULT_MIX : null; return v && typeof v.adjacency === 'number' ? { ...DEFAULT_MIX, ...v } : DEFAULT_MIX; } catch { return DEFAULT_MIX; } });
  const [size, setSize] = useState(25);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const total = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  const set = (k: keyof typeof mix, v: number) => setMix({ ...mix, [k]: v });
  const build = async () => {
    invoke('set_setting', { key: 'mixtape_last_mix', value: JSON.stringify(mix) }).catch(() => {});
    setBusy('Gathering candidates…'); setErr(null);
    try {
      const want = (k: keyof typeof mix) => Math.round((mix[k] / total) * size);
      const [adj, tag, lb] = await Promise.all([mixtapeArtists('adjacency', Math.ceil(want('adjacency') / 2) + 2), mixtapeArtists('tag', Math.ceil(want('tag') / 2) + 2), mixtapeArtists('lb', Math.ceil(want('lb') / 2) + 2)]);
      const names = [...new Set([...adj, ...tag, ...lb].map((a) => a.name))];
      let external: TrackRow[] = [];
      if (names.length) {
        if (!inTauri) throw new Error('Filling in artists you don\'t own needs the desktop app connected to Spotify. Library-gap tracks still work here.');
        setBusy(`Searching Spotify for ${names.length} artists…`);
        const found = await invoke<{ trackId: string; track: string; artist: string }[]>('spotify_tracks_for_artists', { artists: names, perArtist: 2 });
        external = found.map((t) => ({ trackId: String(t.trackId), track: String(t.track), artistId: null, artist: String(t.artist), plays: 0, hours: 0, skipRate: 0 }));
      }
      setBusy('Mixing…');
      const cur = await curated();
      const gapTracks: TrackRow[] = cur.find((c) => c.id === 'never-skip')?.tracks.slice(0, want('gaps')) ?? [];
      const seen = new Set<string>(); const pick: TrackRow[] = [];
      const take = (arr: TrackRow[], n: number) => { for (const t of arr) { if (pick.length >= size) break; if (n <= 0) break; if (seen.has(t.trackId)) continue; seen.add(t.trackId); pick.push(t); n--; } };
      take(external.filter((t) => adj.some((a) => a.name.toLowerCase() === t.artist.toLowerCase())), want('adjacency'));
      take(external.filter((t) => tag.some((a) => a.name.toLowerCase() === t.artist.toLowerCase())), want('tag'));
      take(external.filter((t) => lb.some((a) => a.name.toLowerCase() === t.artist.toLowerCase())), want('lb'));
      take(gapTracks, want('gaps'));
      take([...external, ...gapTracks], size - pick.length);
      if (!pick.length) throw new Error('Nothing to mix yet — connect Last.fm / ListenBrainz in Services and let them run for a few minutes.');
      open({ name: `Deep Cuts mixtape · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, description: `${want('adjacency')} next to your taste, ${want('tag')} by tag, ${want('lb')} from ListenBrainz, ${want('gaps')} from your own library. Made with Deep Cuts.`, kind: 'theme', tracks: pick, note: 'mixtape', pool: [...external, ...gapTracks] });
    } catch (e) { setErr(String((e as Error).message ?? e)); } finally { setBusy(null); }
  };
  const Row = ({ k, label, hint }: { k: keyof typeof mix; label: string; hint: string }) => (
    <label className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3 text-sm"><span title={hint}>{label}</span><input type="range" min={0} max={100} value={mix[k]} onChange={(e) => set(k, Number(e.target.value))} aria-label={label} /><span className="num text-right text-xs text-dust">{Math.round((mix[k] / total) * 100)}%</span></label>
  );
  return (
    <div className="space-y-2">
      <Row k="adjacency" label="Next to your taste" hint="Last.fm similar artists you haven't played" />
      <Row k="tag" label="Tag affinity" hint="Artists carrying tags you over-index on" />
      <Row k="lb" label="ListenBrainz" hint="Collaborative-filtering neighbours" />
      <Row k="gaps" label="Your own library" hint="Never-skipped, rarely-played songs you already have" />
      <div className="flex items-center gap-3 pt-2 text-sm">
        <label className="flex items-center gap-2 text-dust">length <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="num rounded-full border border-line bg-transparent px-2 py-1">{[15, 25, 40, 60].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <button disabled={!!busy} onClick={build} className="ml-auto rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">{busy ?? 'Build mixtape'}</button>
      </div>
      {err && <p className="text-xs text-coral">{err}</p>}
    </div>
  );
}
