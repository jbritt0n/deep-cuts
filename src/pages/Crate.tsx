import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync, useFilter } from '@/lib/hooks';
import { crateRecords, crateSections, crateSummary, type CrateRecord, type CrateSort, type Shelf } from '@/lib/crateQueries';
import { albumHref, artistHref, fmtDate, fmtHours, fmtInt, trackHref } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { CoverTile } from '@/components/Collage';
import { QueueButton } from '@/components/QueueButton';

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
const sectionLabel = (s: string) => ({ 'funk-soul': 'funk & soul', 'post-punk': 'post-punk', 'hip-hop': 'hip-hop', 'classic-rock': 'classic rock', afro: 'afro', psych: 'psych', dream: 'dream pop / shoegaze', unsorted: 'unsorted' } as Record<string, string>)[s] ?? s;

export function CratePage() {
  const { filter } = useFilter();
  const [shelf, setShelf] = useState<Shelf>('all');
  const [sort, setSort] = useState<CrateSort>('section');
  const [section, setSection] = useState<string | null>(null);
  const summary = useAsync(crateSummary, [filter]);
  const sections = useAsync(() => crateSections(shelf), [filter, shelf]);
  const records = useAsync(() => crateRecords({ shelf, section, sort: shelf === 'backroom' && sort === 'section' ? 'obscurity' : sort }), [filter, shelf, section, sort]);
  const deck = useMemo<Item[]>(() => {
    const rs = records.data ?? [];
    if (sort !== 'section' || section || shelf === 'backroom') return rs.map((r) => ({ kind: 'record', r }));
    const out: Item[] = []; let cur: string | null = null;
    for (const r of rs) { const s = r.section ?? 'unsorted'; if (s !== cur) { cur = s; out.push({ kind: 'divider', section: s, count: rs.filter((x) => (x.section ?? 'unsorted') === s).length }); } out.push({ kind: 'record', r }); }
    return out;
  }, [records.data, sort, section, shelf]);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [deck]);
  const next = useCallback(() => setI((x) => Math.min(deck.length - 1, x + 1)), [deck.length]);
  const prev = useCallback(() => setI((x) => Math.max(0, x - 1)), []);
  const jumpTo = (sec: string) => { const k = deck.findIndex((d) => d.kind === 'divider' && d.section === sec); if (k >= 0) setI(k); };
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
        <div className="mb-6 flex flex-wrap gap-1.5" aria-label="Sections">
          <button onClick={() => setSection(null)} className={`rounded-md border-b-2 px-2 py-1 text-xs ${section === null ? 'border-amber text-cream' : 'border-line text-dust hover:text-cream'}`}>all sections</button>
          {sections.data.map((s) => <button key={s.section} onClick={() => { if (section === null && sort === 'section' && shelf !== 'backroom') jumpTo(s.section); else setSection(s.section === 'unsorted' ? null : s.section); }} onDoubleClick={() => setSection(s.section === 'unsorted' ? null : s.section)} title={`${s.records} records · ${fmtHours(s.hours)} — click to jump, double-click to filter`} className={`rounded-md border-b-2 px-2 py-1 text-xs capitalize ${section === s.section ? 'border-amber text-cream' : 'border-line text-dust hover:text-cream'}`}>{sectionLabel(s.section)} <span className="num text-dust/70">{s.records}</span></button>)}
        </div>
      )}

      {records.error ? <ErrorBox message={records.error} /> : !records.data ? <Loading label="Pulling the crate out…" /> : deck.length === 0 ? (
        <Card><p className="py-10 text-center text-sm text-dust">{shelf === 'backroom' ? 'No record has an obscurity score yet — connect Last.fm and give it a little while.' : shelf === 'fresh' ? 'Nothing pulled once and abandoned. You commit.' : shelf === 'rediscover' ? 'No album you loved and then left for a year. Steady.' : 'No albums under this lens.'}</p></Card>
      ) : (
        <Stack deck={deck} i={i} next={next} prev={prev} setI={setI} />
      )}
    </div>
  );
}

function Stack({ deck, i, next, prev, setI }: { deck: Item[]; i: number; next: () => void; prev: () => void; setI: (n: number) => void }) {
  const [leaving, setLeaving] = useState<number | null>(null);
  const flip = () => { if (i >= deck.length - 1) return; setLeaving(i); window.setTimeout(() => { setLeaving(null); next(); }, 260); };
  const behind = deck.slice(i + 1, i + 8);
  const upcomingDivider = behind.findIndex((d) => d.kind === 'divider');
  const front = deck[i];
  const recordsBefore = deck.slice(0, i).filter((d) => d.kind === 'record').length, recordsTotal = deck.filter((d) => d.kind === 'record').length;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,420px)_1fr]">
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
          {upcomingDivider >= 0 && behind[upcomingDivider].kind === 'divider' && <button onClick={() => setI(i + 1 + upcomingDivider)} className="ml-2 capitalize hover:text-cream">skip to {sectionLabel((behind[upcomingDivider] as { section: string }).section)} ⤴</button>}
        </div>
        <p className="mt-1 text-center text-[11px] text-dust/60">click the front record or press → · ← goes back · Home / End</p>
      </div>
      <div>{front?.kind === 'record' ? <RecordNotes r={front.r} /> : front ? <DividerNotes section={front.section} count={front.count} onSkip={next} /> : null}</div>
    </div>
  );
}

const itemKey = (d: Item) => (d.kind === 'record' ? d.r.albumId : `div:${d.section}`);

/** The front record: the cover with its wear and its state stamped on it, not in a sidebar. */
function FrontCover({ r }: { r: CrateRecord }) {
  const scuff = Math.round(r.wear * 100);
  return (
    <div className="relative overflow-hidden rounded-lg border border-line shadow-2xl">
      <CoverTile id={r.albumId} title={r.album} subtitle={r.artist} imageUrl={r.imageUrl} textClass="text-lg" />
      {/* wear: a ring worn into the sleeve, corner scuffs and a faded edge, all scaled to play count */}
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ opacity: 0.15 + r.wear * 0.75, background: `radial-gradient(circle at 50% 50%, transparent 44%, rgba(255,255,255,${0.05 + r.wear * 0.2}) 46%, transparent 49%), radial-gradient(ellipse at 0% 0%, rgba(255,255,255,${r.wear * 0.25}) 0, transparent 30%), radial-gradient(ellipse at 100% 100%, rgba(255,255,255,${r.wear * 0.2}) 0, transparent 26%), linear-gradient(180deg, rgba(0,0,0,0) 80%, rgba(0,0,0,${r.wear * 0.45}))`, mixBlendMode: 'overlay' }} />
      <div aria-hidden className="pointer-events-none absolute inset-0 rounded-lg" style={{ boxShadow: `inset 0 0 0 1px rgba(255,255,255,${0.04 + r.wear * 0.1}), inset 0 -${2 + r.wear * 10}px ${8 + r.wear * 24}px rgba(0,0,0,${0.2 + r.wear * 0.35})` }} />
      <div className="absolute left-2 top-2 flex flex-col items-start gap-1 text-[10px]">
        {r.abandoned && <span className="rounded bg-ink/85 px-1.5 py-0.5 text-coral backdrop-blur">pulled once, never put back</span>}
        {r.rediscover && <span className="rounded bg-ink/85 px-1.5 py-0.5 text-moss backdrop-blur">loved, then left {Math.round(r.daysSilent / 365)} yr{r.daysSilent >= 730 ? 's' : ''} ago</span>}
      </div>
      <div className="absolute bottom-2 right-2 rounded bg-ink/85 px-1.5 py-0.5 text-[10px] backdrop-blur"><ObscurityStamp r={r} /></div>
      <span className="num absolute bottom-2 left-2 rounded bg-ink/85 px-1.5 py-0.5 text-[10px] text-dust backdrop-blur" title={`${r.plays} plays — wear ${scuff}%`}>{fmtInt(r.plays)}× · {scuff}% worn</span>
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

function RecordNotes({ r }: { r: CrateRecord }) {
  const coverage = r.totalTracks ? r.tracksPlayed / r.totalTracks : null;
  return (
    <Card>
      <p className="text-xs text-dust">{r.section ? <span className="capitalize">{sectionLabel(r.section)} · </span> : null}first pulled {fmtDate(r.firstPlayed, { month: 'short', year: 'numeric' })} · last {fmtDate(r.lastPlayed, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
      <h2 className="mt-1 font-display text-3xl leading-tight"><Link to={albumHref(r.albumId)} className="hover:text-amber">{r.album}</Link></h2>
      <p className="mt-1 text-lg text-dust">{r.artistId ? <Link to={artistHref(r.artistId)} className="hover:text-amber">{r.artist}</Link> : r.artist}</p>
      <ul className="num mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <li><span className="block font-display text-2xl">{fmtInt(r.plays)}</span><span className="text-xs text-dust">plays over {r.days} day{r.days === 1 ? '' : 's'} · {fmtHours(r.hours)}</span></li>
        <li><span className="block font-display text-2xl">{r.tracksPlayed}{r.totalTracks ? <span className="text-base text-dust"> / {r.totalTracks}</span> : ''}</span><span className="text-xs text-dust">{coverage == null ? 'tracks played' : coverage >= 0.95 ? 'played front to back' : coverage >= 0.5 ? 'most of it played' : 'barely opened'}</span></li>
        <li><span className="block font-display text-2xl">{r.obscurity == null ? '—' : `${Math.round(r.obscurity * 100)}`}</span><span className="text-xs text-dust">{r.obscurity == null ? 'obscurity unknown yet' : `obscurity · ${compact(r.listeners ?? 0)} Last.fm listeners`}</span></li>
      </ul>
      {(r.abandoned || r.rediscover) && <p className="mt-4 rounded-xl border border-line bg-ink/40 p-3 text-sm text-dust">{r.abandoned ? <>You pulled this once{r.plays > 1 ? ' or twice' : ''} and never came back — <span className="text-cream">{r.daysSilent} days</span> on the shelf. Worth a second spin?</> : <>You played this hard — {fmtInt(r.plays)} times — then left it for <span className="text-cream">{Math.round(r.daysSilent / 30)} months</span>. A rediscovery candidate.</>}</p>}
      <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
        {r.topTrackId && <span className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5"><QueueButton trackId={r.topTrackId} always size={14} /><span className="text-dust">queue</span> <Link to={trackHref(r.topTrackId)} className="truncate hover:text-amber">{r.topTrack ?? 'top track'}</Link></span>}
        <Link to={albumHref(r.albumId)} className="rounded-full border border-line px-4 py-1.5 text-dust hover:border-dust hover:text-cream">Open album</Link>
        {r.artistId && <Link to={artistHref(r.artistId)} className="text-xs text-dust hover:text-cream">Dig deeper into {r.artist} →</Link>}
      </div>
    </Card>
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
