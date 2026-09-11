import type { Config } from 'tailwindcss';

// Design tokens ported from v1 (spec §12). Violet added for late-night.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: 'var(--c-ink)',
        surface: 'var(--c-surface)',
        raised: 'var(--c-raised)',
        line: 'var(--c-line)',
        cream: 'var(--c-cream)',
        dust: 'var(--c-dust)',
        amber: 'var(--c-amber)',
        coral: 'var(--c-coral)',
        moss: 'var(--c-moss)',
        violet: 'var(--c-violet)',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Georgia', 'serif'],
        body: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 40px -12px color-mix(in srgb, var(--c-amber) 40%, transparent)',
      },
    },
  },
  plugins: [],
} satisfies Config;
