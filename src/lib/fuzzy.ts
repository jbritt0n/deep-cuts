/**
 * Phase 10c — fuzzy matching for the command palette: every query character must appear in order; consecutive runs,
 * word starts and an early first hit score higher. "mf" → "Moods & Forecast", "blind" → "Bubble & blind spots".
 * Returns null when the query doesn't match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, ''), t = text.toLowerCase();
  if (!q) return 0;
  let score = 0, ti = 0, run = 0, first = -1;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    if (first < 0) first = i;
    const wordStart = i === 0 || /[\s&/·\-—(]/.test(t[i - 1]);
    run = i === ti ? run + 1 : 1;
    score += 1 + (wordStart ? 3 : 0) + (run > 1 ? run : 0);
    ti = i + 1;
  }
  if (t.startsWith(query.toLowerCase())) score += 10;
  return score - first * 0.2 - (t.length - q.length) * 0.02;
}
