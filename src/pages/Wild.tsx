import { C } from '@/lib/theme';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync, useDebounced } from '@/lib/hooks';
import { invoke } from '@/lib/bridge';
import { wildOverview, wildRecent, wildSongs, type WildSong } from '@/lib/wildQueries';
import { artistHref, fmtDate, fmtInt, fmtTime, hourLabel, trackHref } from '@/lib/format';
import { spotifySearchUrl } from '@/lib/recQueries';
import { Card, Empty, ErrorBox, Loading, Sleeve, StatCard } from '@/components/Card';
import { Histogram } from '@/components/charts/Bars';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Phase 8 — Heard in the Wild.
 * Songs your phone recognised out in the world (Google Now Playing, Shazam),
 * kept apart from what you chose to play. The interesting half is what you
 * have never streamed: that is discovery your own record cannot produce.
 */
export function WildPage() {
  const ov = useAsync(wildOverview, []);
  const [mode, setMode] = useState<'never' | 'yours' | 'all'>('never');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const songs = useAsync(() => wildSongs(mode, dq), [mode, dq]);
  const recent = useAsync(() => wildRecent(40), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  if (ov.error) return <ErrorBox message={ov.error} />;
  if (!ov.data) return <Loading label="Listening back through what you overheard…" />;
  const o = ov.data;

  if (o.captures === 0) return (
    <div className="mx-auto max-w-4xl">
      <Sleeve kicker="Heard in the Wild" title="Songs you overheard, not songs you played" />
      <Card title="Nothing captured yet">
        <p className="text-sm text-dust">This page fills up from your phone. Install a scrobbler that watches Google's <span className="text-cream">Now Playing</span> and <span className="text-cream">Shazam</span> (Pano Scrobbler does both), point it at Last.fm, then set up <Link to="/services" className="underline hover:text-amber">Heard in the Wild in Services</Link>. Captures arrive every 30 minutes and never mix with your Spotify record.</p>
      </Card>
    </div>
  );

  const feedback = async (s: WildSong, verdict: 'accepted' | 'dismissed') => {
    try { await invoke('rec_feedback', { subjectType: 'wild_song', subjectKey: s.key, engine: 'wild', verdict }); } catch (e) { setMsg(String(e)); return; }
    if (verdict === 'dismissed') { setHidden(new Set([...hidden, s.key])); setMsg(`Hidden “${s.track}”.`); } else { setMsg(`Pinned “${s.track}”.`); songs.reload(); }
  };
  const radar = async (s: WildSong) => {
    setMsg(`Adding ${s.track} to your Radar playlist…`);
    try { const res = await invoke<{ added: number; url: string }>('add_to_radar', { search: `${s.artist} ${s.track}` }); setMsg(`Added ${res.added} track${res.added === 1 ? '' : 's'} to Deep Cuts Radar — ${res.url}`); await feedback(s, 'accepted'); }
    catch (e) { setMsg(String(e)); }
  };
  const list = (songs.data ?? []).filter((s) => !hidden.has(s.key));
  const hourMax = Math.max(...o.byHour.map((h) => h.captures), 1);
  const hours = Array.from({ length: 24 }, (_, h) => o.byHour.find((x) => x.hour === h)?.captures ?? 0);

  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Heard in the Wild" title="Songs you overheard, not songs you played"
        meta={<>{fmtInt(o.captures)} captures · {fmtInt(o.songs)} songs · {fmtInt(o.artists)} artists · on {fmtInt(o.days)} days{o.firstHeard ? <> · since {fmtDate(o.firstHeard)}</> : null}</>}>
        <p className="mt-4 max-w-2xl text-sm text-dust">
          Your phone's Now Playing and Shazam, via Last.fm. Kept in a class of their own: nothing here counts toward your hours, streaks or records, and anything it overheard from your own speakers was dropped on the way in. What's left is the world's music reaching you — and <span className="text-cream">{fmtInt(o.neverStreamed)}</span> of these songs you have never once streamed.
        </p>
      </Sleeve>
      {msg && <div className="mb-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-dust">{msg}</div>}

      <section className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
        <StatCard label="Never streamed" value={fmtInt(o.neverStreamed)} footnote="songs you only know from out there" accent />
        <StatCard label="Already yours" value={fmtInt(o.alreadyYours)} footnote="heard in the wild, also in your record" />
        <StatCard label="Captures" value={fmtInt(o.captures)} footnote={o.lastHeard ? `latest ${fmtDate(o.lastHeard, { month: 'short', day: 'numeric' })} ${fmtTime(o.lastHeard)}` : undefined} />
        <StatCard label="Artists" value={fmtInt(o.artists)} footnote={`${o.topArtists.filter((a) => !a.inRecord).length} of the top ${o.topArtists.length} are new to you`} />
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-[1.3fr_1fr]">
        <Card title="Where the world plays you music" subtitle="Captures by hour of day. Cafés at lunch, bars at night, the gym at seven.">
          <div className="flex h-28 items-end gap-[3px]" role="img" aria-label="Captures by hour of day">
            {hours.map((n, h) => <div key={h} title={`${hourLabel(h)} · ${n}`} className="flex-1 rounded-t" style={{ height: `${Math.max(2, (n / hourMax) * 100)}%`, background: C.amber, opacity: n ? 0.35 + 0.65 * (n / hourMax) : 0.12 }} />)}
          </div>
          <div className="num mt-1 flex justify-between text-[10px] text-dust"><span>12 AM</span><span>6 AM</span><span>noon</span><span>6 PM</span><span>11 PM</span></div>
          <p className="mb-2 mt-5 text-xs text-dust">By weekday</p>
          <Histogram data={DOW.map((d, i) => ({ label: d, value: o.byWeekday.find((x) => x.dow === i + 1)?.captures ?? 0 }))} color={C.moss} />
        </Card>
        <Card title="Month by month" subtitle="All captures, and how many were songs you had never streamed when you heard them.">
          {o.byMonth.length ? (
            <ul className="num space-y-1.5 text-xs">
              {o.byMonth.slice(-12).map((m) => {
                const max = Math.max(...o.byMonth.map((x) => x.captures), 1);
                return (
                  <li key={m.month} className="flex items-center gap-3">
                    <span className="w-14 shrink-0 text-dust">{m.month.slice(2)}</span>
                    <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-raised">
                      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(m.captures / max) * 100}%`, background: C.dust, opacity: 0.5 }} />
                      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(m.newSongs / max) * 100}%`, background: C.amber }} />
                    </div>
                    <span className="w-20 shrink-0 text-right text-dust">{m.captures} · <span className="text-amber">{m.newSongs} new</span></span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-sm text-dust">—</p>}
        </Card>
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-[1fr_1.4fr]">
        <Card title="Artists you keep running into" subtitle="Ranked by captures. Faded rows are artists already in your record.">
          <ul className="divide-y divide-line/60 text-sm">
            {o.topArtists.map((a) => (
              <li key={a.artistKey} className={`flex items-center justify-between gap-3 py-1.5 ${a.inRecord ? 'opacity-60' : ''}`}>
                <span className="truncate">{a.artistId ? <Link to={artistHref(a.artistId)} className="hover:text-amber">{a.artist}</Link> : <a href={spotifySearchUrl(a.artist)} target="_blank" rel="noreferrer" className="hover:text-amber">{a.artist}</a>}{!a.inRecord && <span className="ml-2 rounded-full border border-amber/40 px-1.5 text-[10px] text-amber">new to you</span>}</span>
                <span className="num shrink-0 text-xs text-dust">{a.captures}× · {a.songs} song{a.songs === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Latest captures" subtitle="Newest first. Click a day to see what else happened around it.">
          {!recent.data ? <Loading label="Rewinding…" /> : (
            <ul className="divide-y divide-line/60 text-sm">
              {recent.data.slice(0, 14).map((c) => (
                <li key={c.id} className="flex items-baseline gap-3 py-1.5">
                  <Link to={`/day/${c.heardAt.slice(0, 10)}`} className="num w-28 shrink-0 text-xs text-dust hover:text-amber">{fmtDate(c.heardAt, { month: 'short', day: 'numeric' })} · {fmtTime(c.heardAt)}</Link>
                  <span className="min-w-0 flex-1 truncate">{c.trackId ? <Link to={trackHref(c.trackId)} className="hover:text-amber">{c.track}</Link> : c.track}<span className="ml-2 text-xs text-dust">{c.artist}</span></span>
                  {!c.inRecord && <span className="shrink-0 rounded-full border border-amber/40 px-1.5 text-[10px] text-amber">new</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <div className="mt-10">
        <Card title="Every song" subtitle="What you've overheard, grouped. Pin the ones worth chasing, hide the rest — or send them straight to Radar."
          aside={<span className="num text-xs text-dust">{list.length} shown</span>}>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
            {([['never', `Never streamed · ${fmtInt(o.neverStreamed)}`], ['yours', `Already yours · ${fmtInt(o.alreadyYours)}`], ['all', 'Everything']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setMode(k)} className={`rounded-full px-3 py-1.5 ${mode === k ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{l}</button>
            ))}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search song or artist" className="ml-auto rounded-full border border-line bg-transparent px-3 py-1.5 text-dust placeholder:text-dust/60 focus:text-cream" />
          </div>
          {songs.error ? <ErrorBox message={songs.error} /> : !songs.data ? <Loading label="Listing…" /> : list.length === 0 ? <Empty>Nothing matches.</Empty> : (
            <ul className="grid gap-2 md:grid-cols-2">
              {list.map((s) => (
                <li key={s.key} className={`rounded-xl border p-3 ${s.verdict === 'accepted' ? 'border-amber/50 bg-amber/5' : 'border-line bg-ink/40'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{s.trackId ? <Link to={trackHref(s.trackId)} className="hover:text-amber">{s.track}</Link> : s.track}</p>
                      <p className="truncate text-xs text-dust">{s.artistId ? <Link to={artistHref(s.artistId)} className="hover:text-amber">{s.artist}</Link> : s.artist}{s.album ? ` · ${s.album}` : ''}</p>
                    </div>
                    <span className="num shrink-0 text-xs text-dust">{s.captures}×</span>
                  </div>
                  <p className="num mt-2 text-[11px] text-dust">
                    {s.captures === 1 ? `heard ${fmtDate(s.firstHeard, { month: 'short', day: 'numeric', year: 'numeric' })}` : `first ${fmtDate(s.firstHeard, { month: 'short', day: 'numeric', year: 'numeric' })} · last ${fmtDate(s.lastHeard, { month: 'short', day: 'numeric' })}`}
                    {s.trackId ? <span className="text-moss"> · you've played it {fmtInt(s.yourPlays)}×</span> : <span className="text-amber"> · never streamed</span>}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <a href={spotifySearchUrl(`${s.artist} ${s.track}`)} target="_blank" rel="noreferrer" className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream">Open in Spotify</a>
                    {!s.trackId && <button onClick={() => radar(s)} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream">Add to Radar</button>}
                    {s.verdict !== 'accepted' && <button onClick={() => feedback(s, 'accepted')} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream">Pin</button>}
                    <button onClick={() => feedback(s, 'dismissed')} className="ml-auto text-dust/70 hover:text-cream">hide</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
