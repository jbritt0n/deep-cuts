import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, ErrorBox, Loading, Sleeve, StatCard } from '@/components/Card';
import { WordCloud } from '@/components/charts/WordCloud';
import { TrackList } from '@/components/Lists';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { confirmDialog, toast } from '@/components/Overlay';
import { invoke } from '@/lib/bridge';
import { useAsync, useFilter } from '@/lib/hooks';
import { fmtInt, fmtPct, fmtStamp, trackHref } from '@/lib/format';
import { C } from '@/lib/theme';
import * as L from '@/lib/lyricQueries';
import { LEXICON_THEMES, MOODS, MOOD_IDS, THEME_VOCAB, moodOf, moodQuadrant, suspicious } from '@/lib/lyricVocab';
import { fmtDuration } from '@/lib/llm';

/**
 * Phase 10d — Lyrics, its own page (was one card on Insights). What your songs are about, how they feel, how that
 * moves through the years and the day — and Lyric hygiene: every song's keywords, themes, mood and language, editable,
 * with the model's work open to inspection. Lyrics come from LRCLIB and are reduced on arrival; the text is never stored.
 */
const LANG_NAMES: Record<string, string> = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', tr: 'Turkish', ja: 'Japanese', ko: 'Korean', ru: 'Russian', ar: 'Arabic', und: 'Undetected' };
const langName = (l: string | null | undefined) => (l ? LANG_NAMES[l] ?? l : '—');
const QUAD_TONE = () => ({ 'bright-hot': C.amber, 'bright-calm': C.moss, 'bleak-calm': C.violet, 'bleak-hot': C.coral });

export function LyricsPage() {
  const { filter } = useFilter();
  const ov = useAsync(L.lyricOverview, [filter]);
  const q = useAsync(() => invoke<{ llmEnabled: boolean; llmQueued: number; llmDone: number }>('lyrics_status'), []);
  const o = ov.data;
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Understand · Lyrics" title="What your songs are about"
        meta={<>Lyrics come from LRCLIB and are reduced on arrival — the text itself is never stored. {o ? <>Lyrics read for {fmtInt(o.analysed)} of {fmtInt(o.played)} songs you've played, {fmtPct(o.playsCovered)} of your plays.</> : null} <Link to="/settings?tab=model" className="underline hover:text-cream">Local model settings</Link></>} />
      {ov.error && <ErrorBox message={ov.error} />}
      {o && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label="songs read" value={fmtInt(o.analysed)} footnote={o.notLooked ? `${fmtInt(o.notLooked)} not looked up yet` : 'every played song looked up'} />
          <StatCard label="tagged by your model" value={fmtInt(o.modelTagged)} footnote={q.data?.llmEnabled ? `${fmtInt(q.data.llmQueued)} waiting in the queue` : 'background tagging is off'} accent />
          <StatCard label="lyric mood" value={o.valence == null ? '—' : o.valence > 0.1 ? 'bright' : o.valence < -0.1 ? 'bleak' : 'mixed'} footnote={o.valence == null ? '' : `valence ${o.valence >= 0 ? '+' : ''}${o.valence.toFixed(2)} (−1 … +1)`} />
          <StatCard label="languages" value={fmtInt(o.languages)} footnote="detected from the words" />
          <StatCard label="your corrections" value={fmtInt(o.edited)} footnote={o.hidden ? `${o.hidden} songs hidden` : o.modelOld ? `${fmtInt(o.modelOld)} old-prompt tags to review` : 'edit any song below'} />
        </div>
      )}
      <CloudCard />
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.5fr_1fr]"><MoodMapCard /><LanguageCard /></div>
      <div className="mt-6"><LyricWeatherCard /></div>
      <div className="mt-6"><ThemeGridsCard /></div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]"><WordinessCard /><ValenceSkipCard /></div>
      <div className="mt-6"><HygieneCard /></div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- cloud
const KINDS: { id: L.CloudKind; label: string; blurb: string }[] = [
  { id: 'keywords', label: 'Keywords', blurb: 'Words distinctive of the songs you play — scored against the other songs in the same language, so a word in every love song is nobody’s keyword.' },
  { id: 'model_keywords', label: 'Model keywords', blurb: 'Vivid words your local model picked from each song — kept only when they really occur in the lyrics.' },
  { id: 'themes', label: 'Themes', blurb: 'Themes scored from cue-word density; sized by plays × strength.' },
  { id: 'llm_themes', label: 'Model themes', blurb: 'What your local model says each song is about, from a fixed vocabulary of 57 subjects.' },
  { id: 'moods', label: 'Moods', blurb: 'Your model’s reading of each song’s tone, from a palette of 38 distinct moods (a second mood counts half). Coloured by family.' },
];
function CloudCard() {
  const { filter } = useFilter();
  const [kind, setKind] = useState<L.CloudKind>('keywords');
  const [year, setYear] = useState<number | null>(null);
  const [lang, setLang] = useState('en');
  const [perSong, setPerSong] = useState(10);
  const [picked, setPicked] = useState<string | null>(null);
  const langs = useAsync(L.lyricLanguages, [filter]);
  const cloud = useAsync(() => L.lyricCloud(kind, { year, lang: kind === 'themes' || kind === 'moods' ? 'all' : lang, perSong, limit: 180 }), [filter, kind, year, lang, perSong]);
  const tracks = useAsync(() => (picked ? L.lyricTracksFor(picked, kind, { year, perSong }) : Promise.resolve(null)), [picked, kind, year, perSong, filter]);
  const years: number[] = []; for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 8; y--) years.push(y);
  const tone = QUAD_TONE();
  const k = KINDS.find((x) => x.id === kind)!;
  const showLang = kind !== 'themes' && kind !== 'moods' && (langs.data?.length ?? 0) > 1;
  return (
    <Card title="Lyric cloud" subtitle={k.blurb} aside={
      <select value={year ?? ''} onChange={(e) => { setYear(e.target.value ? Number(e.target.value) : null); setPicked(null); }} className="rounded-lg border border-line bg-ink px-2 py-1 text-xs" aria-label="Year"><option value="">all years</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>}>
      <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs" role="tablist" aria-label="What to cloud">
        {KINDS.map((x) => <button key={x.id} role="tab" aria-selected={kind === x.id} onClick={() => { setKind(x.id); setPicked(null); }} className={`rounded-full px-3 py-1 ${kind === x.id ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{x.label}</button>)}
        {kind === 'keywords' && <label className="ml-auto flex items-center gap-2 text-dust">per song <input type="range" min={3} max={15} value={perSong} onChange={(e) => setPerSong(Number(e.target.value))} className="w-24 accent-amber" /><span className="num w-4 text-cream">{perSong}</span></label>}
      </div>
      {showLang && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs" aria-label="Lyric language">
          <span className="mr-1 text-dust">language</span>
          {[{ lang: 'en', label: 'English' }, { lang: 'other', label: 'All others' }, ...langs.data!.filter((l) => l.lang !== 'en' && l.lang !== 'und' && l.tracks >= 3).slice(0, 8).map((l) => ({ lang: l.lang, label: langName(l.lang) }))].map((o) =>
            <button key={o.lang} aria-pressed={lang === o.lang} onClick={() => { setLang(o.lang); setPicked(null); }} className={`rounded-full px-3 py-1 ${lang === o.lang ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{o.label}</button>)}
        </div>
      )}
      {cloud.error ? <ErrorBox message={cloud.error} /> : !cloud.data ? <Loading label="Gathering words…" /> : cloud.data.length === 0 ? (
        <p className="py-10 text-center text-sm text-dust">{kind === 'model_keywords' || kind === 'llm_themes' || kind === 'moods' ? <>Nothing from the local model yet. Turn on background tagging in <Link to="/settings?tab=model" className="underline hover:text-cream">Settings → Local model</Link>; songs fill in a few at a time.</> : 'No lyric features yet — turn on lyric features in Settings → Connectors and give LRCLIB a little while.'}</p>
      ) : (
        <div className="rounded-2xl border border-line/60 bg-ink/30 px-2 py-3">
          <WordCloud height={460} maxWords={180} minFont={12} maxFont={72} picked={picked} onPick={(w) => setPicked(w.text === picked ? null : w.text)}
            words={cloud.data.map((w) => { const m = kind === 'moods' ? moodOf(w.text) : undefined; return { text: w.text, weight: w.weight, note: `${w.tracks} song${w.tracks === 1 ? '' : 's'}`, tone: m ? tone[moodQuadrant(m)] : undefined }; })} />
        </div>
      )}
      {kind === 'moods' && cloud.data && cloud.data.length > 0 && <QuadLegend />}
      <div className="mt-5">
        {!picked ? <p className="text-sm text-dust">Click a word for the songs behind it — and turn them into a playlist.</p> : (
          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2"><p className="text-sm">Songs with <span className="font-display text-xl text-coral">“{picked}”</span>{tracks.data && <span className="ml-2 text-xs text-dust">{tracks.data.length}{tracks.data.length === 60 ? '+' : ''} songs</span>}</p>
              <div className="flex items-center gap-3">{tracks.data && tracks.data.length > 0 && <MakePlaylistButton small label="Make playlist" name={`Deep Cuts · ${picked}`} tracks={tracks.data} kind="insight" note={`lyric:${kind}:${picked}`} pool={tracks.data} />}<button onClick={() => setPicked(null)} className="text-xs text-dust hover:text-cream">close</button></div></div>
            {!tracks.data ? <Loading /> : <div className="max-h-[420px] overflow-y-auto"><TrackList data={tracks.data} /></div>}
          </div>
        )}
      </div>
    </Card>
  );
}
function QuadLegend() {
  const t = QUAD_TONE();
  return <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-dust">{([['bright-hot', 'bright & intense'], ['bright-calm', 'bright & calm'], ['bleak-calm', 'bleak & calm'], ['bleak-hot', 'bleak & intense']] as const).map(([k, l]) => <span key={k} className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: t[k] }} />{l}</span>)}</div>;
}

// ---------------------------------------------------------------------------------------------------------------- mood map
function MoodMapCard() {
  const { filter } = useFilter();
  const [year, setYear] = useState<number | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const d = useAsync(() => L.moodMap(year), [filter, year]);
  const tracks = useAsync(() => (picked ? L.lyricTracksFor(picked, 'moods', { year }) : Promise.resolve(null)), [picked, year, filter]);
  const years: number[] = []; for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 8; y--) years.push(y);
  const W = 560, H = 380, pad = 34;
  const X = (v: number) => pad + ((v + 1) / 2) * (W - 2 * pad), Y = (e: number) => H - pad - ((e + 1) / 2) * (H - 2 * pad);
  const byId = new Map((d.data ?? []).map((m) => [m.mood, m]));
  const max = Math.max(1, ...(d.data ?? []).map((m) => m.plays));
  const tone = QUAD_TONE();
  const total = (d.data ?? []).reduce((a, m) => a + m.plays, 0);
  const quadShare = (q: string) => total ? (d.data ?? []).filter((m) => { const mm = moodOf(m.mood); return mm && moodQuadrant(mm) === q; }).reduce((a, m) => a + m.plays, 0) / total : 0;
  return (
    <Card title="Mood map" subtitle="Every mood on the palette, placed bleak ↔ bright and calm ↔ intense. Circles grow with your plays; click one for its songs."
      aside={<select value={year ?? ''} onChange={(e) => { setYear(e.target.value ? Number(e.target.value) : null); setPicked(null); }} className="rounded-lg border border-line bg-ink px-2 py-1 text-xs" aria-label="Year"><option value="">all years</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>}>
      {d.error ? <ErrorBox message={d.error} /> : !d.data ? <Loading /> : d.data.length === 0 ? <p className="text-sm text-dust">The map fills in as your local model tags songs (Settings → Local model).</p> : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Mood map">
            <rect x={X(0)} y={Y(1)} width={X(1) - X(0)} height={Y(0) - Y(1)} fill={tone['bright-hot']} opacity={0.05} />
            <rect x={X(0)} y={Y(0)} width={X(1) - X(0)} height={Y(-1) - Y(0)} fill={tone['bright-calm']} opacity={0.05} />
            <rect x={X(-1)} y={Y(0)} width={X(0) - X(-1)} height={Y(-1) - Y(0)} fill={tone['bleak-calm']} opacity={0.05} />
            <rect x={X(-1)} y={Y(1)} width={X(0) - X(-1)} height={Y(0) - Y(1)} fill={tone['bleak-hot']} opacity={0.05} />
            <line x1={X(-1)} x2={X(1)} y1={Y(0)} y2={Y(0)} stroke={C.line} /><line x1={X(0)} x2={X(0)} y1={Y(-1)} y2={Y(1)} stroke={C.line} />
            <text x={pad} y={H - 8} fill={C.dust} fontSize={11}>bleak</text><text x={W - pad} y={H - 8} fill={C.dust} fontSize={11} textAnchor="end">bright</text>
            <text x={X(0) + 6} y={pad - 12} fill={C.dust} fontSize={11}>intense</text><text x={X(0) + 6} y={H - pad + 16} fill={C.dust} fontSize={11}>calm</text>
            {[['bleak-hot', X(-1) + 6, Y(1) + 14], ['bright-hot', X(1) - 6, Y(1) + 14], ['bleak-calm', X(-1) + 6, Y(-1) - 6], ['bright-calm', X(1) - 6, Y(-1) - 6]].map(([q, x, y]) =>
              <text key={String(q)} x={Number(x)} y={Number(y)} fontSize={11} fill={tone[q as keyof typeof tone]} textAnchor={Number(x) > W / 2 ? 'end' : 'start'} className="num">{fmtPct(quadShare(String(q)))}</text>)}
            {MOODS.map((m) => {
              const s = byId.get(m.id); const r = s ? 5 + Math.sqrt(s.plays / max) * 26 : 2.5;
              const c = tone[moodQuadrant(m)]; const on = picked === m.id;
              return (
                <g key={m.id} onClick={() => s && setPicked(on ? null : m.id)} className={s ? 'cursor-pointer' : ''}>
                  <circle cx={X(m.v)} cy={Y(m.e)} r={r} fill={c} fillOpacity={s ? (on ? 0.75 : 0.35) : 0.12} stroke={on ? C.cream : c} strokeWidth={on ? 2 : 1} strokeOpacity={s ? 0.9 : 0.25}>
                    <title>{`${m.id}${s ? ` — ${fmtInt(s.plays)} plays, ${s.tracks} songs, ${fmtPct(s.skipRate)} skipped` : ' — none yet'}`}</title>
                  </circle>
                  {(s || r > 3) && <text x={X(m.v)} y={Y(m.e) + r + 11} textAnchor="middle" fontSize={s && s.plays / max > 0.3 ? 12 : 10} fill={s ? C.cream : C.dust} opacity={s ? 0.95 : 0.45}>{m.id}</text>}
                </g>
              );
            })}
          </svg>
          {picked && <div className="mt-3"><div className="mb-2 flex items-baseline justify-between"><p className="text-sm">Songs that feel <span className="font-display text-lg text-coral">{picked}</span></p>{tracks.data && tracks.data.length > 0 && <MakePlaylistButton small label="Make playlist" name={`Deep Cuts · ${picked}`} tracks={tracks.data} kind="insight" note={`lyric:mood:${picked}`} pool={tracks.data} />}</div>{!tracks.data ? <Loading /> : <div className="max-h-72 overflow-y-auto"><TrackList data={tracks.data} /></div>}</div>}
        </>
      )}
    </Card>
  );
}

function LanguageCard() {
  const { filter } = useFilter();
  const d = useAsync(L.lyricLanguages, [filter]);
  const max = Math.max(1, ...(d.data ?? []).map((l) => l.plays));
  const total = (d.data ?? []).reduce((a, l) => a + l.plays, 0);
  return (
    <Card title="Languages" subtitle="Detected from function words in each song. Wrong? Fix a song's language in Hygiene below — its keywords are re-scored against that language.">
      {!d.data ? <Loading /> : (
        <ul className="space-y-2.5 text-sm">{d.data.map((l) => (
          <li key={l.lang}><div className="flex items-baseline justify-between"><span>{langName(l.lang)}</span><span className="num text-xs text-dust">{fmtInt(l.tracks)} songs · {fmtPct(total ? l.plays / total : 0)} of plays</span></div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/70" style={{ width: `${(l.plays / max) * 100}%` }} /></div></li>
        ))}</ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------- over time
function LyricWeatherCard() {
  const { filter } = useFilter();
  const d = useAsync(L.lyricWeather, [filter]);
  const W = 1000, H = 220, pad = 30;
  const pts = d.data ?? [];
  const X = (i: number) => pad + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (W - 2 * pad));
  const lim = Math.max(0.25, ...pts.map((p) => Math.abs(p.valence)));
  const Y = (v: number) => H / 2 - (v / lim) * (H / 2 - pad);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.valence).toFixed(1)}`).join(' ');
  const brightest = [...pts].sort((a, b) => b.valence - a.valence)[0], bleakest = [...pts].sort((a, b) => a.valence - b.valence)[0];
  const mlabel = (m: string) => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return (
    <Card title="Lyrical weather" subtitle={pts.length ? `How bright or bleak the words were, month by month (plays-weighted lyric valence). Brightest: ${mlabel(brightest.month)}. Bleakest: ${mlabel(bleakest.month)}.` : 'How bright or bleak the words were, month by month.'}>
      {d.error ? <ErrorBox message={d.error} /> : !d.data ? <Loading /> : pts.length < 2 ? <p className="text-sm text-dust">Needs a few months of analysed songs.</p> : (
        <div className="overflow-x-auto"><svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[640px]" role="img" aria-label="Lyric valence by month">
          <defs><linearGradient id="lwx" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.amber} stopOpacity={0.35} /><stop offset="50%" stopColor={C.amber} stopOpacity={0} /><stop offset="50%" stopColor={C.violet} stopOpacity={0} /><stop offset="100%" stopColor={C.violet} stopOpacity={0.35} /></linearGradient></defs>
          <line x1={pad} x2={W - pad} y1={H / 2} y2={H / 2} stroke={C.line} />
          <path d={`${line} L${X(pts.length - 1)},${H / 2} L${X(0)},${H / 2} Z`} fill="url(#lwx)" />
          <path d={line} fill="none" stroke={C.cream} strokeWidth={1.8} />
          {pts.map((p, i) => <circle key={p.month} cx={X(i)} cy={Y(p.valence)} r={3} fill={p.valence >= 0 ? C.amber : C.violet}><title>{`${mlabel(p.month)}: valence ${p.valence.toFixed(2)} · ${fmtPct(p.bright)} bright, ${fmtPct(p.bleak)} bleak · lyrics for ${fmtPct(p.covered)} of plays`}</title></circle>)}
          <text x={W - pad} y={14} fontSize={11} fill={C.amber} textAnchor="end">↑ brighter</text><text x={W - pad} y={H - 18} fontSize={11} fill={C.violet} textAnchor="end">↓ bleaker</text>
          {pts.map((p, i) => p.month.endsWith('-01') && <text key={'l' + p.month} x={X(i)} y={H - 4} fontSize={10} fill={C.dust} textAnchor="middle" className="num">{p.month.slice(0, 4)}</text>)}
        </svg></div>
      )}
    </Card>
  );
}

function ThemeGridsCard() {
  const { filter } = useFilter();
  const [src, setSrc] = useState<'themes' | 'llm_themes'>('themes');
  const drift = useAsync(() => L.themeDrift(src, 12), [filter, src]);
  const clock = useAsync(() => L.themeClock(src, 12), [filter, src]);
  const cell = (v: number, max: number) => ({ background: C.amber, opacity: 0.08 + 0.85 * Math.min(1, v / Math.max(max, 1e-9)) });
  const idxCell = (v: number) => ({ background: v >= 1 ? C.amber : C.violet, opacity: Math.min(0.9, 0.08 + Math.abs(Math.log2(Math.max(v, 0.05))) * 0.9) });
  const dmax = Math.max(0, ...(drift.data?.themes ?? []).flatMap((t) => Object.values(t.byYear)));
  return (
    <Card title="Themes through the years and the day" subtitle="Left: the share of your plays carrying each theme, per year. Right: when in the day you reach for it — amber = more than usual, violet = less."
      aside={<div className="flex gap-1 text-xs">{([['themes', 'lexicon'], ['llm_themes', 'your model']] as const).map(([k, l]) => <button key={k} onClick={() => setSrc(k)} aria-pressed={src === k} className={`rounded-full px-3 py-1 ${src === k ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{l}</button>)}</div>}>
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="overflow-x-auto">{!drift.data ? <Loading /> : drift.data.themes.length === 0 ? <p className="text-sm text-dust">Not enough tagged plays yet.</p> : (
          <table className="w-full text-xs"><thead><tr><th /> {drift.data.years.map((y) => <th key={y} className="num px-1 pb-1 font-normal text-dust">{y}</th>)}</tr></thead>
            <tbody>{drift.data.themes.map((t) => <tr key={t.theme}><td className="whitespace-nowrap py-0.5 pr-3 text-cream">{t.theme}</td>{drift.data!.years.map((y) => <td key={y} className="p-0.5"><div className="h-6 min-w-[28px] rounded" style={cell(t.byYear[y] ?? 0, dmax)} title={`${t.theme} · ${y}: ${fmtPct(t.byYear[y] ?? 0)} of plays`} /></td>)}</tr>)}</tbody></table>
        )}</div>
        <div className="overflow-x-auto">{!clock.data ? <Loading /> : clock.data.length === 0 ? <p className="text-sm text-dust">Not enough tagged plays yet.</p> : (
          <table className="w-full text-xs"><thead><tr><th />{L.DAYPARTS.map((d) => <th key={d.id} className="px-1 pb-1 font-normal text-dust" title={d.hours}>{d.label}</th>)}</tr></thead>
            <tbody>{clock.data.map((t) => <tr key={t.theme}><td className="whitespace-nowrap py-0.5 pr-3 text-cream">{t.theme}</td>{L.DAYPARTS.map((d) => { const v = t.index[d.id] ?? 0; return <td key={d.id} className="p-0.5"><div className="num flex h-6 min-w-[44px] items-center justify-center rounded text-[10px]" style={{ position: 'relative' }} title={`${t.theme} in the ${d.label.toLowerCase()} (${d.hours}): ${v ? `${v.toFixed(2)}× usual` : 'never'}`}><span className="absolute inset-0 rounded" style={idxCell(v || 0.05)} /><span className="relative text-cream">{v ? `${v.toFixed(1)}×` : '—'}</span></div></td>; })}</tr>)}</tbody></table>
        )}</div>
      </div>
    </Card>
  );
}

function WordinessCard() {
  const { filter } = useFilter();
  const d = useAsync(L.wordiness, [filter]);
  const Col = ({ title, note, rows, fmt }: { title: string; note: string; rows: { trackId: string; track: string; artist: string }[]; fmt: (i: number) => string }) => (
    <div><p className="text-sm">{title}</p><p className="mb-2 text-xs text-dust">{note}</p>
      <ol className="divide-y divide-line/60 text-sm">{rows.map((r, i) => <li key={r.trackId} className="flex items-baseline gap-2 py-1.5"><span className="num w-4 text-xs text-dust">{i + 1}</span><Link to={trackHref(r.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{r.track} <span className="text-dust">· {r.artist}</span></Link><span className="num shrink-0 text-xs text-dust">{fmt(i)}</span></li>)}</ol></div>
  );
  return (
    <Card title="Wordiest and chantiest" subtitle="Among songs you've played three times or more: the biggest vocabularies, and the songs that say the same thing over and over.">
      {!d.data ? <Loading /> : (
        <div className="grid gap-6 md:grid-cols-2">
          <Col title="Most words" note="distinct content words" rows={d.data.wordiest} fmt={(i) => `${d.data!.wordiest[i].vocab} words`} />
          <Col title="Most repetition" note="share of words that are repeats" rows={d.data.chantiest} fmt={(i) => fmtPct(d.data!.chantiest[i].repetition)} />
        </div>
      )}
    </Card>
  );
}

function ValenceSkipCard() {
  const { filter } = useFilter();
  const d = useAsync(L.valenceSkips, [filter]);
  const max = Math.max(0.01, ...(d.data ?? []).map((b) => b.skipRate));
  const spread = d.data && d.data.length >= 2 ? d.data[0].skipRate - d.data[d.data.length - 1].skipRate : 0;
  return (
    <Card title="Do you skip the sad ones?" subtitle={d.data && d.data.length >= 2 ? (Math.abs(spread) < 0.02 ? 'No — bleak and bright lyrics get skipped about equally.' : spread > 0 ? `Yes — bleak lyrics are skipped ${fmtPct(spread)} more often than bright ones.` : `The opposite — bright lyrics are skipped ${fmtPct(-spread)} more often than bleak ones.`) : 'Skip rate by how bleak or bright the lyrics are.'}>
      {!d.data ? <Loading /> : (
        <div className="flex h-44 items-end gap-3">{d.data.map((b, i) => (
          <div key={b.band} className="flex flex-1 flex-col items-center gap-1" title={`${b.band}: ${fmtPct(b.skipRate)} skipped of ${fmtInt(b.plays)} plays`}>
            <span className="num text-[11px] text-cream">{fmtPct(b.skipRate)}</span>
            <div className="w-full rounded-t-md" style={{ height: `${(b.skipRate / max) * 120}px`, background: i < 2 ? C.violet : i > 2 ? C.amber : C.dust, opacity: 0.75 }} />
            <span className="text-[11px] text-dust">{b.band}</span>
          </div>
        ))}</div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------- hygiene
const FILTERS: { id: L.HygieneFilter; label: string }[] = [
  { id: 'all', label: 'All songs' }, { id: 'suspicious', label: 'Suspicious tags' }, { id: 'model', label: 'Tagged by the model' }, { id: 'untagged', label: 'No model tags' },
  { id: 'edited', label: 'Corrected by you' }, { id: 'errors', label: 'Model errors' }, { id: 'hidden', label: 'Hidden' }, { id: 'notfound', label: 'No lyrics found' },
];
function HygieneCard() {
  const { filter: lens } = useFilter();
  const [params, setParams] = useSearchParams();
  const focus = params.get('song');   // from a song page: "see every word · edit"
  useEffect(() => { if (focus) { setOpen(focus); setTimeout(() => document.getElementById('c-lyric-hygiene')?.scrollIntoView({ behavior: 'smooth' }), 400); } }, [focus]);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [f, setF] = useState<L.HygieneFilter>('all');
  const [lang, setLang] = useState('all');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setTimeout(() => { setQ(search); setPage(0); }, 250); return () => clearTimeout(t); }, [search]);
  const PAGE = 30;
  const d = useAsync(() => L.hygieneList({ search: q, filter: focus ? 'all' : f, lang, limit: PAGE, offset: page * PAGE, trackId: focus }), [q, f, lang, page, tick, lens, focus]);
  const langs = useAsync(L.lyricLanguages, [lens]);
  return (
    <Card title="Lyric hygiene" subtitle="Every song's keywords, themes, mood and language — what was computed, what your model said, and your corrections. Corrections survive every re-fetch and re-tag.">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a song, artist, keyword or theme…" className="min-w-[240px] flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm" aria-label="Search songs" />
        <select value={lang} onChange={(e) => { setLang(e.target.value); setPage(0); }} className="rounded-lg border border-line bg-ink px-2 py-2 text-xs" aria-label="Language"><option value="all">every language</option>{(langs.data ?? []).map((l) => <option key={l.lang} value={l.lang}>{langName(l.lang)}</option>)}</select>
      </div>
      {focus && <p className="mb-3 text-xs text-dust">Showing one song from its page. <button onClick={() => { params.delete('song'); setParams(params, { replace: true }); setOpen(null); }} className="text-amber hover:underline">show every song</button></p>}
      <div className="mb-4 flex flex-wrap gap-1.5 text-xs">{FILTERS.map((x) => <button key={x.id} aria-pressed={f === x.id} onClick={() => { setF(x.id); setPage(0); }} className={`rounded-full px-3 py-1 ${f === x.id ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{x.label}</button>)}</div>
      {d.error ? <ErrorBox message={d.error} /> : !d.data ? <Loading /> : d.data.rows.length === 0 ? <p className="py-6 text-center text-sm text-dust">Nothing matches.</p> : (
        <>
          <p className="num mb-2 text-xs text-dust">{fmtInt(d.data.total)} songs{d.data.total > PAGE && ` · ${page * PAGE + 1}–${Math.min(d.data.total, (page + 1) * PAGE)}`}</p>
          <ul className="divide-y divide-line/60">
            {d.data.rows.map((r) => {
              const warn = suspicious({ track: r.track, artist: r.artist, llmThemes: r.llmThemes, llmMood: r.llmMood, llmRev: r.llmRev });
              const isOpen = open === r.trackId;
              return (
                <li key={r.trackId} className="py-2">
                  <button onClick={() => setOpen(isOpen ? null : r.trackId)} aria-expanded={isOpen} className="grid w-full grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_auto] items-start gap-3 text-left">
                    <span className="min-w-0"><span className="block truncate text-sm text-cream">{r.track}</span><span className="block truncate text-xs text-dust">{r.artist} · <span className="num">{fmtInt(r.plays)} plays</span> · {langName(r.lang)}{r.lang !== r.langDetected && ' (fixed)'}</span></span>
                    <span className="flex min-w-0 flex-wrap gap-1 text-[11px]">
                      {r.llmMood && <Chip tone={moodOf(r.llmMood) ? QUAD_TONE()[moodQuadrant(moodOf(r.llmMood)!)] : C.coral}>{r.llmMood}</Chip>}
                      {r.llmThemes.slice(0, 3).map((t) => <Chip key={'m' + t}>{t}</Chip>)}
                      {r.themes.slice(0, 2).map((t) => <Chip key={'t' + t} dim>{t}</Chip>)}
                      {r.keywords.slice(0, 5).map((k) => <span key={'k' + k} className="px-1 text-dust">{k}</span>)}
                      {!r.found && <span className="text-dust">no lyrics on LRCLIB</span>}
                    </span>
                    <span className="flex items-center gap-2 text-[11px]">
                      {warn.length > 0 && <span className="rounded-full bg-coral/15 px-2 py-0.5 text-coral" title={warn.join('\n')}>check</span>}
                      {r.edited && <span className="rounded-full bg-moss/15 px-2 py-0.5 text-moss">edited</span>}
                      {r.locked && <span title="The model won't re-tag this song">🔒</span>}
                      <span className="text-dust">{isOpen ? '▾' : '▸'}</span>
                    </span>
                  </button>
                  {isOpen && <SongEditor row={r} warn={warn} onChanged={() => setTick((t) => t + 1)} />}
                </li>
              );
            })}
          </ul>
          {d.data.total > PAGE && <div className="mt-3 flex justify-between text-xs"><button disabled={page === 0} onClick={() => setPage(page - 1)} className="text-dust hover:text-cream disabled:opacity-30">← previous</button><button disabled={(page + 1) * PAGE >= d.data.total} onClick={() => setPage(page + 1)} className="text-dust hover:text-cream disabled:opacity-30">next →</button></div>}
        </>
      )}
      <Blocklist onChanged={() => setTick((t) => t + 1)} />
    </Card>
  );
}

const Chip = ({ children, tone, dim }: { children: React.ReactNode; tone?: string; dim?: boolean }) => (
  <span className={`rounded-full border px-2 py-0.5 ${dim ? 'border-line text-dust' : 'text-cream'}`} style={tone ? { borderColor: tone, color: tone } : dim ? undefined : { borderColor: C.line }}>{children}</span>
);

/** Editable list of words: chips with ×, plus an input (with suggestions when a vocabulary is given). */
function ListEditor({ label, value, onSave, vocab, placeholder }: { label: string; value: string[]; onSave: (v: string[]) => Promise<void>; vocab?: string[]; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const id = `dl-${label.replace(/\W+/g, '')}`;
  const add = async () => { const w = draft.trim().toLowerCase(); if (!w || value.includes(w)) return; if (vocab && !vocab.includes(w) && !(await confirmDialog(`“${w}” isn't in the vocabulary. Use it anyway? Free-form tags won't line up with other songs.`, { confirm: 'Use it', danger: false }))) return; await onSave([...value, w]); setDraft(''); };
  return (
    <div>
      <p className="mb-1 text-xs text-dust">{label}</p>
      <div className="flex flex-wrap items-center gap-1">
        {value.map((w) => <span key={w} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs">{w}<button onClick={() => void onSave(value.filter((x) => x !== w))} className="text-dust hover:text-coral" aria-label={`Remove ${w}`}>×</button></span>)}
        <input list={vocab ? id : undefined} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} placeholder={placeholder ?? 'add…'} className="w-32 rounded-lg border border-line bg-ink px-2 py-0.5 text-xs" />
        {vocab && <datalist id={id}>{vocab.map((v) => <option key={v} value={v} />)}</datalist>}
      </div>
    </div>
  );
}

function SongEditor({ row, warn, onChanged }: { row: L.HygieneRow; warn: string[]; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  const d = useAsync(() => L.songLyricDetail(row.trackId), [row.trackId, tick]);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => { setTick((t) => t + 1); onChanged(); };
  const patch = async (p: Record<string, unknown>, note?: string) => { try { await invoke('lyrics_override_set', { trackId: row.trackId, patch: p }); if (note) toast(note, 'ok'); refresh(); } catch (e) { toast(String(e), 'error'); } };
  const act = async (label: string, fn: () => Promise<unknown>, ok: string) => { setBusy(label); try { await fn(); toast(ok, 'ok'); refresh(); } catch (e) { toast(String(e), 'error'); } finally { setBusy(null); } };
  if (d.error) return <div className="mt-3"><ErrorBox message={d.error} /></div>;
  if (!d.data) return <div className="mt-3"><Loading rows={2} /></div>;
  const x = d.data; const ov = x.override; const ft = x.features;
  const hidden = ov?.keywordsHide ?? [];
  return (
    <div className="mt-3 rounded-2xl border border-line/70 bg-ink/40 p-4">
      {warn.length > 0 && <ul className="mb-3 space-y-0.5 text-xs text-coral">{warn.map((w) => <li key={w}>• {w}</li>)}</ul>}
      {ft?.summary && <p className="mb-3 font-display text-lg italic text-cream/90">“{ft.summary}” <span className="font-sans text-[11px] not-italic text-dust">— {ft.llmModel}, in its own words</span></p>}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-dust">Language
              <select value={ov?.lang ?? ''} onChange={(e) => void patch({ lang: e.target.value || null }, e.target.value ? `Language set to ${langName(e.target.value)} — keywords re-scored.` : 'Back to the detected language.')} className="mt-1 block w-full rounded-lg border border-line bg-ink px-2 py-1 text-sm text-cream">
                <option value="">detected: {langName(ft?.langDetected)}</option>{Object.keys(LANG_NAMES).filter((l) => l !== 'und').map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}
              </select></label>
            <label className="text-xs text-dust">Mood
              <select value={ov?.mood ?? ''} onChange={(e) => void patch({ mood: e.target.value || null })} className="mt-1 block w-full rounded-lg border border-line bg-ink px-2 py-1 text-sm text-cream">
                <option value="">{x.computedMood ? `model: ${x.computedMood}${MOOD_IDS.includes(x.computedMood) ? '' : ' (off palette)'}` : 'model: none yet'}</option>{MOOD_IDS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select></label>
          </div>
          <ListEditor label={`Model themes${ov?.llmThemes ? ' (your list)' : ''}`} value={ov?.llmThemes ?? x.computedLlmThemes} vocab={THEME_VOCAB} onSave={(v) => patch({ llm_themes: v })} />
          <ListEditor label={`Lexicon themes${ov?.themes ? ' (your list)' : ' — scored from cue words'}`} value={ov?.themes ?? x.computedThemes} vocab={LEXICON_THEMES} onSave={(v) => patch({ themes: v })} />
          <ListEditor label="Always a keyword of this song" value={ov?.keywordsAdd ?? []} placeholder="add a word…" onSave={(v) => patch({ keywords_add: v })} />
          {Object.keys(x.themeScores).length > 0 && <p className="num text-[11px] text-dust">lexicon scores: {Object.entries(x.themeScores).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Number(v).toFixed(1)}`).join(' · ')}</p>}
          <div className="flex flex-wrap gap-3 text-xs">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!ov?.locked} onChange={(e) => void patch({ locked: e.target.checked }, e.target.checked ? 'Locked — the model will leave this song alone.' : 'Unlocked.')} /> lock (the model won't re-tag it)</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!ov?.hidden} onChange={(e) => void patch({ hidden: e.target.checked }, e.target.checked ? 'Hidden from every lyric view (wrong lyrics or instrumental).' : 'Back in the lyric views.')} /> hide (wrong lyrics / instrumental)</label>
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs text-dust">Every word recorded for this song — tap a keyword to hide it from this song, or block it everywhere. Bold = counts as a keyword now (rank ≤ 15).</p>
          <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto">
            {x.terms.map((t) => {
              const off = t.blocked || t.hidden;
              return (
                <span key={t.term + (t.added ? '+' : '')} className={`group flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${t.added ? 'border-moss text-moss' : off ? 'border-line/50 text-dust/50 line-through' : t.rank ? 'border-amber/60 font-medium text-cream' : 'border-line text-dust'}`} title={`${t.tf}× in the song${t.score != null ? ` · score ${t.score.toFixed(1)} · rank ${t.rank}` : t.blocked ? ' · blocked everywhere' : t.hidden ? ' · hidden here' : ' · too common in your library to count'}`}>
                  {t.term}<span className="num text-[10px] text-dust">{t.tf}</span>
                  {!t.added && !t.blocked && <button onClick={() => void patch({ keywords_hide: t.hidden ? hidden.filter((h) => h !== t.term) : [...hidden, t.term] })} className="text-dust hover:text-coral" title={t.hidden ? 'Show again for this song' : 'Hide for this song'}>{t.hidden ? '↺' : '×'}</button>}
                  {!t.added && !t.hidden && <button onClick={() => void act('block', () => invoke('lyrics_blocklist', { term: t.term, add: !t.blocked }), t.blocked ? `“${t.term}” unblocked.` : `“${t.term}” will never be a keyword again.`)} className="hidden text-dust hover:text-coral group-hover:inline" title={t.blocked ? 'Unblock' : 'Never a keyword, for any song'}>{t.blocked ? '⊕' : '⊘'}</button>}
                </span>
              );
            })}
            {!x.terms.length && <span className="text-xs text-dust">No words recorded (still on the old rules, or no lyrics).</span>}
          </div>
          {row.llmKeywords.length > 0 && <p className="mt-2 text-xs text-dust">Model keywords: <span className="text-cream">{row.llmKeywords.join(', ')}</span></p>}
          <p className="num mt-2 text-[11px] text-dust">{ft ? `${fmtInt(ft.wordCount)} words · ${ft.vocab ?? '—'} distinct · repetition ${ft.repetition == null ? '—' : fmtPct(ft.repetition)} · valence ${ft.valence == null ? '—' : ft.valence.toFixed(2)}` : ''}{ft?.llmModel ? ` · tagged by ${ft.llmModel}${ft.llmAt ? ` ${fmtStamp(ft.llmAt)}` : ''}${ft.llmMs ? ` in ${fmtDuration(ft.llmMs)}` : ''}${(ft.llmRev ?? 0) < 2 ? ' (old prompt)' : ''}` : ''}</p>
          {ft?.llmError && <p className="mt-1 text-[11px] text-coral">last model error: {ft.llmError.replace(/^slow_model: /, 'timed out — ')}</p>}
          {x.neighbours.length > 0 && <div className="mt-3"><p className="mb-1 text-xs text-dust">Lyrical neighbours — songs you play that say similar things</p><ul className="space-y-0.5 text-xs">{x.neighbours.map((n) => <li key={n.trackId}><Link to={trackHref(n.trackId)} className="text-cream hover:text-amber">{n.track}</Link> <span className="text-dust">· {n.artist} · shares {n.shared.slice(0, 4).join(', ')}</span></li>)}</ul></div>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3 text-xs">
        <button disabled={!!busy} onClick={() => void act('llm', () => invoke('lyrics_llm_track', { trackId: row.trackId }), 'Your model tagged the song again.')} className="rounded-full bg-amber px-3 py-1 font-medium text-ink disabled:opacity-40">{busy === 'llm' ? 'The model is reading…' : 'Ask the model again'}</button>
        <button disabled={!!busy} onClick={() => void act('queue', () => invoke('lyrics_requeue', { trackId: row.trackId }), 'Back in the background queue.')} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream disabled:opacity-40">Queue for re-tagging</button>
        <button disabled={!!busy} onClick={() => void act('refetch', () => invoke<boolean>('lyrics_refetch_track', { trackId: row.trackId }), 'Lyrics fetched again and re-analysed.')} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream disabled:opacity-40">{busy === 'refetch' ? 'Fetching…' : 'Re-fetch lyrics'}</button>
        {ov && <button disabled={!!busy} onClick={async () => { if (await confirmDialog('Remove all your corrections for this song?', { confirm: 'Remove' })) void act('clear', () => invoke('lyrics_override_clear', { trackId: row.trackId }), 'Corrections removed.'); }} className="ml-auto text-dust hover:text-coral">Undo my corrections</button>}
        <Link to={trackHref(row.trackId)} className={`${ov ? '' : 'ml-auto '}text-amber hover:underline`}>Song page →</Link>
      </div>
    </div>
  );
}

function Blocklist({ onChanged }: { onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  const b = useAsync(L.blocklist, [tick]);
  const [w, setW] = useState('');
  const set = async (term: string, add: boolean) => { try { await invoke('lyrics_blocklist', { term, add }); setTick((t) => t + 1); onChanged(); if (add) setW(''); } catch (e) { toast(String(e), 'error'); } };
  return (
    <div className="mt-6 border-t border-line/60 pt-4">
      <p className="text-sm">Never a keyword</p>
      <p className="mb-2 text-xs text-dust">Words left out of every song's keywords — a name, a chant, a word your library over-counts.</p>
      <div className="flex flex-wrap items-center gap-1">
        {(b.data ?? []).map((t) => <span key={t} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs">{t}<button onClick={() => void set(t, false)} className="text-dust hover:text-coral" aria-label={`Unblock ${t}`}>×</button></span>)}
        <input value={w} onChange={(e) => setW(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && w.trim()) void set(w, true); }} placeholder="add a word…" className="w-36 rounded-lg border border-line bg-ink px-2 py-0.5 text-xs" aria-label="Block a word" />
      </div>
    </div>
  );
}
