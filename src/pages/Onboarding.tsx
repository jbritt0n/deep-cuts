import { useNavigate } from 'react-router-dom';
import type { AppStatus } from '@/lib/types';
import { Importer } from '@/components/Importer';

export function Onboarding({ status, onDone }: { status: AppStatus; onDone: () => void }) {
  const nav = useNavigate();
  return (
    <div className="groove-bg mx-auto grid min-h-full max-w-5xl items-center gap-12 px-8 py-16 md:grid-cols-[1fr_1.1fr]">
      <div>
        <div className="flex items-center gap-3">
          <span aria-hidden className="relative block h-9 w-9 rounded-full border border-amber/70"><span className="absolute inset-[6px] rounded-full border border-amber/40" /><span className="absolute inset-[13px] rounded-full bg-amber" /></span>
          <span className="font-display text-2xl tracking-tight">Deep Cuts</span>
        </div>
        <h1 className="mt-8 font-display text-5xl leading-[1.05] tracking-tight">Every hour you've ever pressed play, annotated.</h1>
        <p className="mt-5 max-w-md text-dust">
          Import your Spotify listening history once and Deep Cuts turns it into a record you can explore: what you play, when, in what mood, and what you skip. It stays on this machine — nothing is uploaded anywhere.
        </p>
        <ul className="mt-6 space-y-2 text-sm text-dust">
          <li><span className="text-cream">Sessions</span>, not just plays: album rides, comfort loops, late-night canons.</li>
          <li><span className="text-cream">The attentive lens</span> separates listening from the laptop left on all night.</li>
          <li><span className="text-cream">Live and connected</span> comes next: Spotify, Last.fm, MusicBrainz and stats.fm connectors.</li>
        </ul>
        <div className="mt-8 flex flex-wrap gap-3 text-sm">
          <button onClick={() => nav('/')} className="rounded-full border border-line px-5 py-2.5 text-dust transition hover:border-dust hover:text-cream">
            {status.hasData ? 'Back to your record' : 'Explore with demo data first'}
          </button>
        </div>
      </div>
      <Importer onDone={() => { onDone(); setTimeout(() => nav('/'), 1600); }} />
    </div>
  );
}
