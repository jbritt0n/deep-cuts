import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync, useFilter } from '@/lib/hooks';
import { albumTracks, crateRecords, crateSections, crateSummary, obscurityTier, related, type CrateRecord, type CrateSort, type Shelf } from '@/lib/crateQueries';
import { sceneLabels, sceneOptions } from '@/lib/sceneQueries';
import { invoke } from '@/lib/bridge';
import { QueueButton, useQueue } from '@/components/QueueButton';
import { albumHref, artistHref, fmtDate, fmtHours, fmtInt, trackHref } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { CoverTile } from '@/components/Collage';

/**
 * Phase 9b — The Crate. Not a sorted grid: a fanned stack of records, the front one fully visible and
 * a few peeking out behind it. Click the front card (or →) to flip it away and bring the next forward.
 * Genre dividers are taller cards that peek up above the record edges a few flips before you reach
 * them — the labelled tabs in a real crate. Two browse dimensions on every record: obscurity (Last.fm
 * listeners, inverse-log) and the scene-family section; two states on the cover itself: wear (loved
 * records look handled) and abandonment (pulled once or twice, never put back on).
 */
type Item = { kind: 'record'; r: CrateRecord } | { kind: 'divider'; section: string; count: number };

const SHELVES: { id: Shelf; label: string; blurb: string }[] = [
  { id: 'all', label: 'Whole crate', blurb: 'Every record you\'ve played, filed by section.' },
  { id: 'fresh', label: 'Fresh crate', blurb: 'Pulled once or twice, never put back on. Second chances.' },
  { id: 'backroom', label: 'Back room', blurb: 'Rarest first — the fewest people on Earth know these.' },
  { id: 'rediscover', label: 'Rediscover', blurb: 'Played hard once, untouched for a year or more.' },
];
const SORTS: { id: CrateSort; label: string }[] = [{ id: 'section', label: 'by section' }, { id: 'obscurity', label: 'rarest first' }, { id: 'plays', label: 'most played' }, { id: 'recent', label: 'last played' }, { id: 'oldest', label: 'first played' }];
/** Phase 9f: labels come from scene_families (the owner can add families), cached once per page load; the key itself is the fallback. */
let LABELS: Record<string, string> = { unsorted: 'unsorted' };
const sectionLabel = (s: string) => LABELS[s] ?? s.replace(/-/g, ' ');

export function CratePage() {
  const { filter } = useFilter();
  const [shelf, setShelf] = useState<Shelf>('all');
  const [sort, setSort] = useState<CrateSort>('section');
  const [section, setSection] = useState<string | null>(null);
  const summary = useAsync(crateSummary, [filter]);
  const labels = useAsync(sceneLabels, []);
  useEffect(() => { if (labels.data) LABELS = { ...labels.data, unsorted: 'unsorted' }; }, [labels.data]);
  const sections = useAsync(() => crateSections(shelf), [filter, shelf]);
  const [fbTick, setFbTick] = useState(0);
  const records = useAsync(() => crateRecords({ shelf, section, sort: shelf === 'backroom' && sort === 'section' ? 'obscurity' : sort }), [filter, shelf, section, sort, fbTick]);
  /** Skip (hide for 90 days) or keep (pin to the front for 90 days) — recommendation_feedback rows under engine 'crate'. */
  const decide = async (r: CrateRecord, verdict: 'dismissed' | 'accepted') => {
    await invoke('rec_feedback', { subjectType: 'album', subjectKey: r.albumId, engine: 'crate', verdict }).catch(() => {});
    if (verdict === 'dismissed') setDeckHint(`${r.album} put away for 90 days`); else setDeckHint(`${r.album} kept up front for 90 days`);
    setFbTick((t) => t + 1);
  };
  const [deckHint, setDeckHint] = useState<string | null>(null);
  useEffect(() => { if (!deckHint) return; const t = window.setTimeout(() => setDeckHint(null), 3000); return () => window.clearTimeout(t); }, [deckHint]);
  const deck = useMemo<Item[]>(() => {
    const rs = records.data ?? [];
    if (sort !== 'section' || section || shelf === 'backroom') return rs.map((r) => ({ kind: 'record', r }));
    const out: Item[] = []; let cur: string | null = null;
    for (const r of rs) { const s = r.section ?? 'unsorted'; if (s !== cur) { cur = s; out.push({ kind: 'divider', section: s, count: rs.filter((x) => (x.section ?? 'unsorted') === s).length }); } out.push({ kind: 'record', r }); }
    return out;
  }, [records.data, sort, section, shelf]);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [shelf, section, sort]);
  useEffect(() => { setI((x) => Math.min(x, Math.max(0, deck.length - 1))); }, [deck.length]);
  const next = useCallback(() => setI((x) => Math.min(deck.length - 1, x + 1)), [deck.length]);
  const prev = useCallback(() => setI((x) => Math.max(0, x - 1)), []);
  const jumpTo = (sec: string) => { const k = deck.findIndex((d) => d.kind === 'divider' && d.section === sec); if (k >= 0) setI(k); };
  const hasDividers = deck.some((d) => d.kind === 'divider');
  const front = deck[i];
  const currentSection = front ? (front.kind === 'divider' ? front.section : (front.r.section ?? 'unsorted')) : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return; if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); } if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); } if (e.key === 'Home') setI(0); if (e.key === 'End') setI(deck.length - 1); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, deck.length]);

  const sm = summary.data;
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="The Crate" title="Flip through the records" meta={sm ? <>{fmtInt(sm.records)} records · {fmtInt(sm.fresh)} pulled once and left · {fmtInt(sm.rediscover)} worth a rediscovery{sm.rarest ? <> · rarest: <span className="text-cream/80">{sm.rarest.album}</span> by {sm.rarest.artist}, {fmtInt(sm.rarest.listeners)} listeners on Last.fm</> : null}</> : 'Counting the records…'}>
        {sm && sm.scored < sm.records && <p className="mt-3 max-w-2xl text-xs text-dust">Obscurity is known for {fmtInt(sm.scored)} of {fmtInt(sm.records)} records — Last.fm listener counts arrive a few artists at a time once that connector is on. Records without a score are filed as “unknown”, never as mainstream; the rarest things are exactly where coverage is thinnest.</p>}
      </Sleeve>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {SHELVES.map((s) => <button key={s.id} onClick={() => { setShelf(s.id); setSection(null); }} aria-pressed={shelf === s.id} title={s.blurb} className={`rounded-full px-3 py-1.5 text-sm ${shelf === s.id ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{s.label}</button>)}
        <select value={sort} onChange={(e) => setSort(e.target.value as CrateSort)} className="ml-auto rounded-lg border border-line bg-ink px-2 py-1.5 text-xs" aria-label="Sort">{SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
      </div>
      <p className="mb-5 text-sm text-dust">{SHELVES.find((s) => s.id === shelf)?.blurb}</p>

      {sections.data && sections.data.length > 0 && (
        <div className="mb-6" aria-label="Sections">
          <div className="flex flex-wrap items-center gap-1.5" role="tablist">
            <button onClick={() => { setSection(null); setI(0); }} className={`rounded-md border-b-2 px-2 py-1 text-xs ${section === null && !currentSection ? 'border-amber text-cream' : 'border-line text-dust hover:text-cream'}`}>all</button>
            {sections.data.map((s) => { const active = section === s.section || (section === null && currentSection === s.section); return (
              <span key={s.section} className={`flex items-stretch rounded-md border-b-2 text-xs capitalize transition-colors ${active ? 'border-amber' : 'border-line'}`}>
                <button role="tab" aria-selected={active} onClick={() => { if (section === null && hasDividers && deck.some((d) => d.kind === 'divider' && d.section === s.section)) jumpTo(s.section); else setSection(s.section); }}
                  title={section === null && hasDividers ? `Jump to the ${sectionLabel(s.section)} divider` : `Show only ${sectionLabel(s.section)}`}
                  className={`px-2 py-1 ${active ? 'text-cream' : 'text-dust hover:text-cream'}`}>{sectionLabel(s.section)} <span className="num text-dust/70">{s.records}</span></button>
                {section === null && hasDividers && <button onClick={() => setSection(s.section)} title={`Only ${sectionLabel(s.section)}`} aria-label={`Filter to ${sectionLabel(s.section)}`} className="border-l border-line/60 px-1.5 text-dust/60 hover:text-amber">⊙</button>}
              </span>
            ); })}
            {section && <button onClick={() => setSection(null)} className="px-2 py-1 text-xs text-amber hover:text-cream">× show every section</button>}
          </div>
          <p className="mt-1.5 text-[11px] text-dust/70">Sections come from each artist's Last.fm / MusicBrainz tags mapped onto {labels.data ? Object.keys(labels.data).length - 1 : 'the'} scene families — the same vocabulary Scenes uses, editable in <Link to="/settings?tab=tuning" className="underline hover:text-cream">Settings → Tuning → Scenes</Link>. Click a name to jump to its divider, ⊙ to show only that section (unsorted included); misfiled records can be re-filed from the record card.</p>
        </div>
      )}
      {deckHint && <p className="mb-3 text-xs text-moss">{deckHint}</p>}

      {records.error ? <ErrorBox message={records.error} /> : !records.data ? <Loading label="Pulling the crate out…" /> : deck.length === 0 ? (
        <Card><p className="py-10 text-center text-sm text-dust">{shelf === 'backroom' ? 'No record has an obscurity score yet — connect Last.fm and give it a little while.' : shelf === 'fresh' ? 'Nothing pulled once and abandoned. You commit.' : shelf === 'rediscover' ? 'No album you loved and then left for a year. Steady.' : 'No albums under this lens.'}</p></Card>
      ) : (
        <Stack deck={deck} i={i} next={next} prev={prev} setI={setI} decide={decide} />
      )}
    </div>
  );
}

function Stack({ deck, i, next, prev, setI, decide }: { deck: Item[]; i: number; next: () => void; prev: () => void; setI: (n: number) => void; decide: (r: CrateRecord, v: 'dismissed' | 'accepted') => Promise<void> }) {
  const [leaving, setLeaving] = useState<number | null>(null);
  const flip = () => { if (i >= deck.length - 1) return; setLeaving(i); window.setTimeout(() => { setLeaving(null); next(); }, 260); };
  const behind = deck.slice(i + 1, i + 8);
  const nextDividerAt = deck.findIndex((d, k) => k > i && d.kind === 'divider');
  const front = deck[i];
  const recordsBefore = deck.slice(0, i).filter((d) => d.kind === 'record').length, recordsTotal = deck.filter((d) => d.kind === 'record').length;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div>
        <div className="relative mx-auto h-[400px] w-full max-w-[400px] select-none" style={{ perspective: 1200 }} aria-live="polite">
          {/* the crate's back wall */}
          <div className="absolute inset-x-6 bottom-2 top-10 rounded-t-[28px] border border-line bg-surface/70" aria-hidden />
          {behind.slice().reverse().map((d, ri) => {
            const k = behind.length - 1 - ri; // 0 = right behind the front card
            const t = k + 1;
            const isDiv = d.kind === 'divider';
            return (
              <div key={itemKey(d)} aria-hidden className="absolute left-1/2 top-12 w-[300px] origin-bottom transition-all duration-300 motion-reduce:transition-none" style={{ transform: `translateX(-50%) translateY(${-t * 6 - (isDiv ? 26 : 0)}px) translateX(${t * 7}px) rotate(${t * 1.6}deg) scale(${1 - t * 0.035})`, zIndex: 20 - t, opacity: Math.max(0.35, 1 - t * 0.11), filter: `brightness(${1 - t * 0.07})` }}>
                {isDiv ? <DividerCard section={d.section} count={d.count} peek /> : <div className="overflow-hidden rounded-lg border border-line shadow-lg"><CoverTile id={d.r.albumId} title={d.r.album} subtitle={d.r.artist} imageUrl={d.r.imageUrl} /></div>}
              </div>
            );
          })}
          {front && (
            <button onClick={flip} disabled={i >= deck.length - 1} aria-label={front.kind === 'record' ? `Flip ${front.r.album} away` : `Flip past the ${front.section} divider`} className="absolute left-1/2 top-12 w-[300px] origin-bottom rounded-lg text-left transition-all duration-300 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-amber" style={{ transform: leaving === i ? 'translateX(-50%) translateX(-340px) rotate(-14deg) rotateY(-35deg)' : 'translateX(-50%)', opacity: leaving === i ? 0 : 1, zIndex: 30 }}>
              {front.kind === 'divider' ? <DividerCard section={front.section} count={front.count} /> : <FrontCover r={front.r} />}
            </button>
          )}
        </div>
        <div className="mt-3 flex items-center justify-center gap-3 text-xs text-dust">
          <button onClick={prev} disabled={i === 0} className="rounded-full border border-line px-3 py-1 hover:text-cream disabled:opacity-30" aria-label="Previous record">← back</button>
          <span className="num">{recordsBefore + (front?.kind === 'record' ? 1 : 0)} / {recordsTotal}</span>
          <button onClick={flip} disabled={i >= deck.length - 1} className="rounded-full border border-line px-3 py-1 hover:text-cream disabled:opacity-30" aria-label="Next record">flip →</button>
          {nextDividerAt > 0 && <button onClick={() => setI(nextDividerAt)} className="ml-2 capitalize hover:text-cream">skip to {sectionLabel((deck[nextDividerAt] as { section: string }).section)} ⤴</button>}
        </div>
        <p className="mt-1 text-center text-[11px] text-dust/60">click the front record or press → · ← goes back · Home / End</p>
      </div>
      <div className="min-w-0">{front?.kind === 'record' ? <RecordNotes key={front.r.albumId} r={front.r} onSkip={() => decide(front.r, 'dismissed')} onKeep={() => decide(front.r, 'accepted')} /> : front ? <DividerNotes section={front.section} count={front.count} onSkip={next} /> : null}</div>
    </div>
  );
}

const itemKey = (d: Item) => (d.kind === 'record' ? d.r.albumId : `div:${d.section}`);

/** The front record: the cover with its wear and its state stamped on it, not in a sidebar. */
function FrontCover({ r }: { r: CrateRecord }) {
  const w = r.wear, scuff = Math.round(w * 100);
  // Wear as a physical thing: a pristine cover is crisp and saturated; a loved one is faded, creased along the
  // spine, ring-worn in the middle, scuffed at the corners, with a paper-grain overlay that gets heavier.
  const filter = `saturate(${1 - w * 0.45}) contrast(${1 - w * 0.18}) brightness(${1 - w * 0.08}) sepia(${w * 0.25})`;
  const seed = [...r.albumId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <div className="relative overflow-hidden rounded-lg border border-line shadow-2xl" style={{ borderColor: `rgba(255,255,255,${0.08 + w * 0.12})` }}>
      <div style={{ filter }}><CoverTile id={r.albumId} title={r.album} subtitle={r.artist} imageUrl={r.imageUrl} textClass="text-lg" /></div>
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <filter id={`grain-${seed}`}><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed % 100} /><feColorMatrix type="saturate" values="0" /><feComponentTransfer><feFuncA type="linear" slope={0.05 + w * 0.35} /></feComponentTransfer></filter>
          <radialGradient id={`ring-${seed}`}><stop offset="43%" stopColor="white" stopOpacity="0" /><stop offset="46%" stopColor="white" stopOpacity={w * 0.5} /><stop offset="48%" stopColor="white" stopOpacity={w * 0.18} /><stop offset="51%" stopColor="white" stopOpacity="0" /></radialGradient>
          <linearGradient id={`spine-${seed}`} x1="0" x2="1"><stop offset="0" stopColor="black" stopOpacity={w * 0.55} /><stop offset="0.06" stopColor="white" stopOpacity={w * 0.25} /><stop offset="0.1" stopColor="black" stopOpacity="0" /></linearGradient>
        </defs>
        <rect width="100" height="100" filter={`url(#grain-${seed})`} style={{ mixBlendMode: 'overlay' }} />
        <circle cx="50" cy="50" r="50" fill={`url(#ring-${seed})`} style={{ mixBlendMode: 'screen' }} />
        <rect width="100" height="100" fill={`url(#spine-${seed})`} />
        {/* corner scuffs and a crease or two, drawn only once the record is actually handled */}
        {w > 0.35 && <>
          <path d="M0 0 L9 0 L0 9 Z" fill="white" opacity={(w - 0.35) * 0.55} />
          <path d="M100 100 L91 100 L100 91 Z" fill="white" opacity={(w - 0.35) * 0.45} />
          <path d="M100 0 L94 0 L100 6 Z" fill="white" opacity={(w - 0.35) * 0.3} />
        </>}
        {w > 0.55 && <path d={`M${20 + (seed % 30)} 0 L${25 + (seed % 30)} 100`} stroke="white" strokeWidth="0.35" opacity={(w - 0.55) * 0.9} />}
        {w > 0.75 && <path d={`M0 ${60 + (seed % 25)} L100 ${55 + (seed % 25)}`} stroke="white" strokeWidth="0.3" opacity={(w - 0.75) * 1.2} />}
        <rect width="100" height="100" fill="none" stroke="black" strokeWidth={0.6 + w * 2.2} opacity={0.15 + w * 0.35} />
      </svg>
      <div className="absolute left-2 top-2 flex flex-col items-start gap-1 text-[10px]">
        {r.kept && <span className="rounded bg-ink/85 px-1.5 py-0.5 text-moss backdrop-blur">kept up front</span>}
        {r.abandoned && <span className="rounded bg-ink/85 px-1.5 py-0.5 text-coral backdrop-blur">pulled once, never put back</span>}
        {r.rediscover && <span className="rounded bg-ink/85 px-1.5 py-0.5 text-moss backdrop-blur">loved, then left {Math.round(r.daysSilent / 365)} yr{r.daysSilent >= 730 ? 's' : ''} ago</span>}
      </div>
      <div className="absolute bottom-2 right-2 rounded bg-ink/85 px-1.5 py-0.5 text-[10px] backdrop-blur"><ObscurityStamp r={r} /></div>
      <span className="num absolute bottom-2 left-2 rounded bg-ink/85 px-1.5 py-0.5 text-[10px] text-dust backdrop-blur" title={`${r.plays} plays — wear ${scuff}%`}>{fmtInt(r.plays)}× · {w >= 0.85 ? 'well loved' : w >= 0.6 ? 'handled' : w >= 0.3 ? 'a few spins' : 'mint'}</span>
    </div>
  );
}

function ObscurityStamp({ r }: { r: CrateRecord }) {
  if (r.obscurity == null) return <span className="text-dust">obscurity unknown</span>;
  const label = r.obscurity >= 0.45 ? 'ultra rare' : r.obscurity >= 0.3 ? 'rare' : r.obscurity >= 0.18 ? 'cult' : r.obscurity >= 0.1 ? 'known' : 'everyone knows';
  return <span className={r.obscurity >= 0.3 ? 'text-amber' : r.obscurity >= 0.18 ? 'text-cream' : 'text-dust'}>{label} · {r.listeners != null ? `${compact(r.listeners)} listeners` : ''}</span>;
}
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function DividerCard({ section, count, peek = false }: { section: string; count: number; peek?: boolean }) {
  return (
    <div className={`w-full rounded-t-2xl border border-line bg-raised ${peek ? 'h-[326px]' : 'h-[300px]'} flex flex-col`} style={{ background: `linear-gradient(180deg, hsl(${(hueOf(section) % 360)} 30% 30%), hsl(${(hueOf(section) + 20) % 360} 25% 18%))` }}>
      <div className="flex items-baseline justify-between px-4 pt-3"><span className="font-display text-xl capitalize text-cream">{sectionLabel(section)}</span><span className="num text-xs text-cream/70">{count}</span></div>
      <div className="mx-4 mt-2 h-px bg-cream/20" />
      {!peek && <p className="mt-auto px-4 pb-4 text-xs text-cream/70">a section divider — flip past it to reach the records</p>}
    </div>
  );
}
const hueOf = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

function RecordNotes({ r, onSkip, onKeep }: { r: CrateRecord; onSkip: () => void; onKeep: () => void }) {
  const { filter } = useFilter();
  const { queueMany, connected } = useQueue();
  const tracks = useAsync(() => albumTracks(r.albumId), [r.albumId, filter]);
  const rel = useAsync(() => related(r.albumId, r.artistId), [r.albumId, filter]);
  const [busy, setBusy] = useState(false);
  const coverage = r.totalTracks ? r.tracksPlayed / r.totalTracks : null;
  const queueable = (tracks.data ?? []).filter((t) => !t.trackId.startsWith('local:'));
  return (
    <Card>
      <p className="truncate text-xs text-dust"><Filing r={r} />first pulled {fmtDate(r.firstPlayed, { month: 'short', year: 'numeric' })} · last {fmtDate(r.lastPlayed, { month: 'short', day: 'numeric', year: 'numeric' })}{r.kept ? <span className="text-moss"> · kept up front</span> : ''}</p>
      <h2 className="mt-1 break-words font-display text-3xl leading-tight"><Link to={albumHref(r.albumId)} className="hover:text-amber">{r.album}</Link></h2>
      <p className="mt-1 truncate text-lg text-dust">{r.artistId ? <Link to={artistHref(r.artistId)} className="hover:text-amber">{r.artist}</Link> : r.artist}</p>
      <ul className="num mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <li className="min-w-0"><span className="block font-display text-2xl">{fmtInt(r.plays)}</span><span className="text-xs text-dust">plays over {r.days} day{r.days === 1 ? '' : 's'} · {fmtHours(r.hours)}</span></li>
        <li className="min-w-0"><span className="block font-display text-2xl">{r.tracksPlayed}{r.totalTracks ? <span className="text-base text-dust"> / {r.totalTracks}</span> : ''}</span><span className="text-xs text-dust">{coverage == null ? 'tracks played' : coverage >= 0.95 ? 'played front to back' : coverage >= 0.5 ? 'most of it played' : 'barely opened'}</span></li>
        <li className="min-w-0"><span className="block font-display text-2xl">{r.obscurity == null ? '—' : <>{Math.round(r.obscurity * 100)} <span className={`text-base ${r.obscurity >= 0.3 ? 'text-amber' : 'text-dust'}`}>{obscurityTier(r.obscurity)}</span></>}</span><span className="text-xs text-dust">{r.obscurity == null ? 'obscurity unknown yet' : `obscurity · ${compact(r.listeners ?? 0)} Last.fm listeners`}</span></li>
      </ul>
      {(r.abandoned || r.rediscover) && <p className="mt-4 rounded-xl border border-line bg-ink/40 p-3 text-sm text-dust">{r.abandoned ? <>You pulled this once{r.plays > 1 ? ' or twice' : ''} and never came back — <span className="text-cream">{r.daysSilent} days</span> on the shelf. Worth a second spin?</> : <>You played this hard — {fmtInt(r.plays)} times — then left it for <span className="text-cream">{Math.round(r.daysSilent / 30)} months</span>. A rediscovery candidate.</>}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
        <button disabled={!connected || busy || !queueable.length} onClick={async () => { setBusy(true); await queueMany(queueable.map((t) => t.trackId), r.album); setBusy(false); }} title={!connected ? 'Connect Spotify in Services to queue' : `Queue all ${queueable.length} tracks, in album order`} className="rounded-full bg-amber px-4 py-1.5 font-medium text-ink disabled:opacity-40">{busy ? 'Queueing…' : `Queue the album${queueable.length ? ` · ${queueable.length}` : ''}`}</button>
        <Link to={albumHref(r.albumId)} className="rounded-full border border-line px-4 py-1.5 text-dust hover:border-dust hover:text-cream">Open album</Link>
        <span className="ml-auto flex gap-2 text-xs">
          <button onClick={onSkip} title="Take this record out of the crate for 90 days" className="rounded-full border border-line px-3 py-1.5 text-dust hover:border-coral hover:text-coral">Put away 90 days</button>
          <button onClick={onKeep} disabled={r.kept} title="Keep this record at the front of the crate for 90 days" className="rounded-full border border-line px-3 py-1.5 text-dust hover:border-moss hover:text-moss disabled:border-moss/40 disabled:text-moss/60">{r.kept ? 'Kept' : 'Keep up front'}</button>
        </span>
      </div>

      <div className="mt-5">
        <p className="mb-1 text-xs text-dust">Tracks you've played from it{tracks.data && r.totalTracks && tracks.data.length < r.totalTracks ? ` · ${r.totalTracks - tracks.data.length} never played` : ''}</p>
        {!tracks.data ? <p className="text-sm text-dust">Reading the sleeve…</p> : (
          <ol className="max-h-72 divide-y divide-line/60 overflow-y-auto text-sm">
            {tracks.data.map((t) => <li key={t.trackId} className="flex items-center gap-3 py-1.5">
              <span className="num w-6 shrink-0 text-right text-xs text-dust">{t.trackNumber ?? '·'}</span>
              <Link to={trackHref(t.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{t.track}</Link>
              <span className="num shrink-0 text-xs text-dust">{fmtInt(t.plays)}×{t.skipRate >= 0.3 ? <span className="text-coral"> · {Math.round(t.skipRate * 100)}% skipped</span> : ''}</span>
              <QueueButton trackId={t.trackId} always size={13} />
            </li>)}
          </ol>
        )}
      </div>

      <Related albumId={r.albumId} artist={r.artist} data={rel.data} />
    </Card>
  );
}

/** Which section this record is filed under, why, and a way to re-file the artist (writes scene_overrides; Scenes and the Crate both follow). */
function Filing({ r }: { r: CrateRecord }) {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState<string | null>(r.section);
  const [saved, setSaved] = useState(false);
  const options = useAsync(sceneOptions, []);
  const file = async (scene: string | null) => { if (!r.artistId) return; setCur(scene); setOpen(false); await invoke('set_artist_scene', { artistId: r.artistId, scene }).catch(() => {}); setSaved(true); };
  return (
    <span className="mr-1 inline-flex items-center gap-1">
      <button onClick={() => setOpen(!open)} className="capitalize hover:text-cream" title={r.topTags.length ? `Filed from tags: ${r.topTags.join(', ')}${r.filedByYou ? ' — overridden by you' : ''}. Click to re-file.` : 'No tags yet — click to file it yourself.'}>{cur ? sectionLabel(cur) : 'unsorted'}{r.filedByYou || saved ? ' ✎' : ''}</button>
      <span>·</span>
      {open && (
        <span className="absolute z-20 mt-6 max-w-sm rounded-xl border border-line bg-surface p-3 text-xs shadow-glow">
          <p className="mb-2 normal-case text-dust">{r.topTags.length ? <>Tags for {r.artist}: {r.topTags.join(', ')}. </> : null}File {r.artist} under:</p>
          {(['region', 'style'] as const).map((k) => <span key={k} className="mb-1 block"><span className="mr-1 text-[10px] uppercase tracking-wide text-dust/60">{k === 'region' ? 'regions' : 'styles'}</span><span className="inline-flex flex-wrap gap-1">{(options.data ?? []).filter((o) => o.kind === k).map((o) => <button key={o.scene} onClick={() => file(o.scene)} className={`rounded-full border px-2 py-0.5 ${cur === o.scene ? 'border-amber text-cream' : 'border-line text-dust hover:text-cream'}`}>{o.label}</button>)}</span></span>)}
          <span className="flex flex-wrap gap-1"><button onClick={() => file(null)} className="rounded-full border border-line px-2 py-0.5 text-dust hover:text-coral">unsorted</button><Link to="/settings?tab=tuning" className="rounded-full border border-dashed border-line px-2 py-0.5 text-dust hover:text-amber">+ new family…</Link></span>
          <p className="mt-2 normal-case text-dust/70">Takes effect on the next flip through and everywhere Scenes are used. Reloads of the crate reflect it immediately.</p>
        </span>
      )}
    </span>
  );
}

/** Owner request: records adjacent to this one that you haven't opened — same artist, unknown neighbours, dormant neighbours. */
function Related({ artist, data }: { albumId: string; artist: string; data: Awaited<ReturnType<typeof related>> | null }) {
  if (!data) return null;
  if (!data.albums.length && !data.unknown.length && !data.dormant.length) return <p className="mt-5 text-xs text-dust/70">Nothing adjacent yet — neighbours arrive as Last.fm / ListenBrainz similar-artist data and Spotify enrichment fill in.</p>;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="text-xs text-dust">Nearby in the crate — things you haven't really opened</p>
      {data.albums.length > 0 && (
        <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {data.albums.map((a) => <li key={a.albumId} className="min-w-0"><Link to={albumHref(a.albumId)} className="block overflow-hidden rounded-md border border-line" title={`${a.album} — ${a.reason}`}><CoverTile id={a.albumId} title={a.album} subtitle={a.artist} imageUrl={a.imageUrl} textClass="text-[10px]" /></Link><p className="mt-1 truncate text-[11px]">{a.album}</p><p className="truncate text-[10px] text-dust">{a.reason}</p></li>)}
        </ul>
      )}
      {(data.unknown.length > 0 || data.dormant.length > 0) && (
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          {data.unknown.length > 0 && <div className="min-w-0"><p className="text-xs text-dust">Artists near {artist} you don't know yet</p><ul className="mt-1 space-y-0.5">{data.unknown.map((a) => <li key={a.key} className="flex items-baseline gap-2"><span className="truncate">{a.artist}</span><Link to={`/discover?q=${encodeURIComponent(a.artist)}`} className="shrink-0 text-[11px] text-dust hover:text-amber">discover</Link></li>)}</ul></div>}
          {data.dormant.length > 0 && <div className="min-w-0"><p className="text-xs text-dust">Neighbours you know but haven't played in a year</p><ul className="mt-1 space-y-0.5">{data.dormant.map((a) => <li key={a.key} className="flex items-baseline gap-2">{a.artistId ? <Link to={artistHref(a.artistId)} className="truncate hover:text-amber">{a.artist}</Link> : <span className="truncate">{a.artist}</span>}{a.lastPlayed && <span className="num shrink-0 text-[11px] text-dust">last {a.lastPlayed.slice(0, 7)}</span>}</li>)}</ul></div>}
        </div>
      )}
    </div>
  );
}

function DividerNotes({ section, count, onSkip }: { section: string; count: number; onSkip: () => void }) {
  return (
    <Card>
      <p className="text-xs text-dust">Section</p>
      <h2 className="mt-1 font-display text-3xl capitalize">{sectionLabel(section)}</h2>
      <p className="mt-2 text-sm text-dust">{count} record{count === 1 ? '' : 's'} filed here. Sections use the same tag-family vocabulary as Scenes on Insights, so the dividers match what the rest of the app calls a scene.</p>
      <button onClick={onSkip} className="mt-4 rounded-full bg-amber px-4 py-1.5 text-sm font-medium text-ink">Start flipping →</button>
    </Card>
  );
}
