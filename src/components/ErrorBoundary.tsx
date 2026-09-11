import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps one broken page from blanking the whole app. Shows the error and a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; info: string }> {
  state = { error: null as Error | null, info: '' };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { this.setState({ info: info.componentStack ?? '' }); console.error('Deep Cuts page error', error, info); }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null, info: '' }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-2xl py-10">
        <p className="text-xs text-coral">This page hit an error</p>
        <h1 className="mt-1 font-display text-3xl">Something on this page broke — the rest of the app is fine.</h1>
        <pre className="num mt-4 max-h-64 overflow-auto rounded-xl border border-line bg-surface p-4 text-xs text-dust whitespace-pre-wrap">{String(this.state.error.message)}{'\n'}{this.state.info.split('\n').slice(0, 6).join('\n')}</pre>
        <div className="mt-4 flex gap-3 text-sm">
          <a href="#/" className="rounded-full bg-amber px-4 py-2 font-medium text-ink">Back to dashboard</a>
          <button onClick={() => this.setState({ error: null, info: '' })} className="rounded-full border border-line px-4 py-2 text-dust hover:text-cream">Try again</button>
        </div>
        <p className="mt-4 text-xs text-dust">Copy the grey box into the chat and it can be fixed.</p>
      </div>
    );
  }
}
