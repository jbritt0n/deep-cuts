import { Link } from 'react-router-dom';
import { Card, Loading } from '@/components/Card';
import { query, num, str } from '@/lib/db';
import { fmtInt } from '@/lib/format';
import { useAsync } from '@/lib/hooks';

type Src = { name: string; keeps: string; never: string; count?: string; where?: string };

async function load() {
  const one = async (sql: string) => { try { return num((await query(sql))[0]?.n); } catch { return 0; } };
  const [plays, polled, exported, stylus, lyrics, wiki, weather, liked, pls] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM plays_resolved`), one(`SELECT COUNT(*) AS n FROM plays_resolved WHERE source = 'recently_played_poll'`),
    one(`SELECT COUNT(*) AS n FROM plays_resolved WHERE source = 'extended_export'`), one(`SELECT COUNT(*) AS n FROM plays_resolved WHERE source = 'stylus'`),
    one(`SELECT COUNT(*) AS n FROM track_lyric_features WHERE found`), one(`SELECT COUNT(*) AS n FROM artist_wiki WHERE found`),
    one(`SELECT COUNT(*) AS n FROM weather_daily`), one(`SELECT COUNT(*) AS n FROM liked_songs`), one(`SELECT COUNT(*) AS n FROM playlists`)]);
  const [place] = await query(`SELECT value FROM app_meta WHERE key = 'weather_place'`).catch(() => [] as Record<string, unknown>[]);
  const devices = (await query(`SELECT name, ts_precision, keep_player, keep_service, keep_device, paused, retention_days, accepted FROM stylus_devices ORDER BY created_at`).catch(() => [] as Record<string, unknown>[]))
    .map((r) => ({ name: String(r.name), ts: String(r.ts_precision ?? 'exact'), player: Boolean(r.keep_player), service: Boolean(r.keep_service), device: Boolean(r.keep_device), paused: Boolean(r.paused), days: r.retention_days == null ? null : num(r.retention_days), accepted: num(r.accepted) }));
  const sources: Src[] = [
    { name: 'Spotify', keeps: 'Each play (track, when, how long, skip, device, country from the export), your liked songs and playlists, track and artist metadata.', never: 'Your password — sign-in is an OAuth token kept in the system keyring, not in the record.', count: `${fmtInt(polled)} polled + ${fmtInt(exported)} exported plays · ${fmtInt(liked)} liked · ${fmtInt(pls)} playlists` },
    { name: 'Stylus (your own scrobbler)', keeps: 'Per device, exactly the fields you allow below; the device token is stored only as a SHA-256 hash.', never: 'Anything from a paused device; location (ListenBrainz has no field for it).', count: `${fmtInt(stylus)} plays` },
    { name: 'Last.fm', keeps: 'Public tags, similar artists and listener counts for artists and albums you play; Heard in the Wild keeps scrobbles from the phone scrobbler you connect.', never: 'Your Last.fm password (only an API key and user name, in the keyring).' },
    { name: 'MusicBrainz · Wikipedia · Cover Art Archive', keeps: 'Public facts: artist ids, origins, relationships, credits, catalogue size; Wikipedia intro and picture link; album art links.', never: 'Nothing about you is sent — lookups are by artist or recording.', count: `${fmtInt(wiki)} Wikipedia summaries` },
    { name: 'LRCLIB (lyrics)', keeps: 'Derived features only: language, distinctive words, themes, valence, repetition.', never: 'The lyric text itself — it is analysed in memory and discarded.', count: `${fmtInt(lyrics)} songs analysed` },
    { name: 'FreqBlog', keeps: 'Audio features (tempo, key, energy, loudness…) per song.', never: 'Anything but track title, artist and ISRC is sent.' },
    { name: 'Open-Meteo (weather)', keeps: 'Daily weather for the one place you set.', never: 'Your location per play — only that one place, and only if you set it.', count: `${fmtInt(weather)} days${str(place?.value) ? ` · ${str(place?.value)}` : ''}` },
    { name: 'Local model (Ollama)', keeps: 'Nothing new — it reads what is shown to it for one answer, on this machine.', never: 'Nothing leaves this computer.' },
  ];
  return { plays, sources, devices };
}

/** Phase 10b (Stylus S2) — Settings → Privacy: what Deep Cuts keeps, source by source. */
export function PrivacyPanel() {
  const p = useAsync(load, []);
  if (!p.data) return <Card title="Privacy"><Loading rows={8} /></Card>;
  const d = p.data;
  return (
    <div className="space-y-6">
      <Card title="What Deep Cuts keeps" subtitle={`Everything lives in one file on this computer (${fmtInt(d.plays)} plays). No account, no cloud copy, no analytics. Sign-in tokens live in the system keyring, not in the record. Export or move it any time (Record tab).`}>
        <ul className="divide-y divide-line/60 text-sm">
          {d.sources.map((s) => (
            <li key={s.name} className="grid gap-1 py-2.5 sm:grid-cols-[12rem_1fr]">
              <span className="font-medium">{s.name}{s.count && <span className="block text-[11px] font-normal text-dust">{s.count}</span>}</span>
              <span><span className="text-cream">Keeps:</span> {s.keeps}<br /><span className="text-dust">Never: {s.never}</span></span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Stylus devices" subtitle="What each scrobbling device is allowed to leave in your record. Change these on Services → Stylus.">
        {d.devices.length === 0 ? <p className="text-sm text-dust">No devices. <Link to="/services" className="underline hover:text-cream">Add one on Services</Link>.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="text-xs text-dust"><tr><th className="py-1 pr-3 font-normal">Device</th><th className="pr-3 font-normal">Time kept</th><th className="pr-3 font-normal">Player</th><th className="pr-3 font-normal">Service</th><th className="pr-3 font-normal">Device name</th><th className="pr-3 font-normal">Details kept for</th><th className="font-normal">Plays</th></tr></thead>
            <tbody>{d.devices.map((v) => <tr key={v.name} className="border-t border-line/50"><td className="py-1.5 pr-3">{v.name}{v.paused && <span className="ml-1 text-[10px] text-amber">paused</span>}</td><td className="pr-3">{v.ts === 'exact' ? 'exact' : `to the ${v.ts}`}</td><td className="pr-3">{v.player ? 'yes' : 'no'}</td><td className="pr-3">{v.service ? 'yes' : 'no'}</td><td className="pr-3">{v.device ? 'yes' : 'no'}</td><td className="pr-3">{v.days ? `${v.days} days` : 'forever'}</td><td className="num">{fmtInt(v.accepted)}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
