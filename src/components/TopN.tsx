/** "Top 10 / 25 / 50 / 100" control shared by dashboard and review pages. */
export function TopN({ value, onChange, options = [5, 10, 25, 50, 100] }: { value: number; onChange: (n: number) => void; options?: number[] }) {
  return (
    <div role="group" aria-label="How many to show" className="flex overflow-hidden rounded-full border border-line text-xs">
      {options.map((n) => <button key={n} onClick={() => onChange(n)} aria-pressed={value === n} className={`num px-2.5 py-1 ${value === n ? 'bg-raised text-cream' : 'text-dust hover:text-cream'}`}>{n}</button>)}
    </div>
  );
}
