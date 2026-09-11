import { useFilter } from '@/lib/hooks';
import { isFiltered } from '@/lib/filter';

/**
 * The listening lens: the one control that decides which plays count.
 * "Attentive" drops autoplay stretches you weren't around for.
 */
export function FilterLens() {
  const { filter, setFilter, years } = useFilter();
  const lo = years[0], hi = years.at(-1);
  const opt = (v: number | null) => (v === null ? '' : String(v));
  return (
    <div className="flex items-center gap-2 text-xs">
      <div role="group" aria-label="Listening lens" className="flex overflow-hidden rounded-full border border-line">
        {[{ v: true, l: 'Attentive' }, { v: false, l: 'Everything' }].map((o) => (
          <button key={o.l} onClick={() => setFilter({ ...filter, attentiveOnly: o.v })}
            aria-pressed={filter.attentiveOnly === o.v}
            className={`px-3 py-1.5 transition ${filter.attentiveOnly === o.v ? 'bg-amber text-ink' : 'text-dust hover:text-cream'}`}
            title={o.v ? 'Only plays you were around for — long autoplay stretches excluded' : 'Every recorded play, including all-night autoplay'}>
            {o.l}
          </button>
        ))}
      </div>
      <select aria-label="From year" value={opt(filter.fromYear)} onChange={(e) => setFilter({ ...filter, fromYear: e.target.value ? Number(e.target.value) : null })}
        className="num rounded-full border border-line bg-transparent px-2.5 py-1.5 text-dust hover:text-cream">
        <option value="">from {lo ?? '—'}</option>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
      <span className="text-dust/60">–</span>
      <select aria-label="To year" value={opt(filter.toYear)} onChange={(e) => setFilter({ ...filter, toYear: e.target.value ? Number(e.target.value) : null })}
        className="num rounded-full border border-line bg-transparent px-2.5 py-1.5 text-dust hover:text-cream">
        <option value="">to {hi ?? '—'}</option>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
      {isFiltered(filter) && (filter.fromYear || filter.toYear || !filter.attentiveOnly) && (
        <button onClick={() => setFilter({ attentiveOnly: true, fromYear: null, toYear: null })} className="text-dust hover:text-cream">reset</button>
      )}
    </div>
  );
}
