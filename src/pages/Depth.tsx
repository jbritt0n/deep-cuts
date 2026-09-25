import { Link } from 'react-router-dom';
import { Sleeve } from '@/components/Card';
import { AntiRecsCard, BlindSpotsCard, BubbleCard } from '@/components/DepthCards';

/** Phase 10b — Bubble & blind spots: discovery depth on its own page (moved out of the bottom of Discover). */
export function DepthPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Bubble & blind spots" title="How wide your listening is — and what's outside it" meta={<>The breadth of your taste year by year, the artists and scenes your own favourites point to that you've never explored, and the ones you're "supposed" to like but keep skipping. Suggestions to act on live in <Link to="/discover" className="underline hover:text-cream">Discover</Link>.</>} />
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr]"><BubbleCard /><BlindSpotsCard /></div>
        <AntiRecsCard />
      </div>
    </div>
  );
}
