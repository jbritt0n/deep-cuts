/**
 * Phase 10b (Kimi T2) — one error shape for the whole app. Rust commands reply {code, message} (commands.rs `err`);
 * the bridge turns any failure — that JSON, a plain string from a command, a harness error — into a DeepCutsError
 * whose message starts with "[code] ", so it survives both `e.message` and `String(e)` on its way to ErrorBox,
 * which reads the code back to show a plain explanation with the technical text under "details".
 */
export type ErrorCode = 'quota' | 'auth' | 'network' | 'not_found' | 'invalid_input' | 'database' | 'busy' | 'internal';

/** Same rules as Rust's `error_code` (commands.rs) — keep them in step. */
export function classify(message: string): ErrorCode {
  const m = message.toLowerCase();
  if (/quota|rate.?limit|\b429\b|too many requests/.test(m)) return 'quota';
  if (/\b401\b|\b403\b|unauthori[sz]ed|reconnect|re-?auth|token (expired|invalid|rejected)|invalid (api )?key|key rejected|rejected (the|that|your) (api )?key|sign in again/.test(m)) return 'auth';
  if (/network|timed? ?out|timeout|connection (refused|reset)|dns|could not reach|unreachable|offline|fetch failed|econnrefused/.test(m)) return 'network';
  // database before not_found / invalid_input: DuckDB messages say "…not found in FROM clause", "expected …"
  if (/binder error|parser error|catalog error|conversion error|out of range error|duckdb|sql|constraint/.test(m)) return 'database';
  if (/\b404\b|not found|no such|unknown (artist|album|track|playlist)/.test(m)) return 'not_found';
  if (/must be|expected|can't be edited|doesn't look like|invalid|required|use a year|give the device a name|1–60 characters|two-letter/.test(m)) return 'invalid_input';
  if (/already running|in progress|busy|locked|lock on file/.test(m)) return 'busy';
  return 'internal';
}

export const HINT: Record<ErrorCode, string> = {
  quota: "A service's usage limit was reached. Deep Cuts pauses that service and carries on; it resumes by itself (Spotify after midnight).",
  auth: 'A connected service no longer accepts Deep Cuts\u2019 sign-in. Reconnect it on Services.',
  network: "Couldn't reach the service — check the connection. Nothing was lost; it retries on the next tick.",
  not_found: "That item couldn't be found — it may have been removed or renamed.",
  invalid_input: 'That value was not accepted.',
  database: "A query in this view failed. It's a bug in Deep Cuts, not in your record — the details below help fix it.",
  busy: 'Something else is already running (an import or a rebuild). Try again in a moment.',
  internal: 'Something went wrong.',
};

export class DeepCutsError extends Error {
  code: ErrorCode; detail: string;
  constructor(code: ErrorCode, detail: string) { super(`[${code}] ${detail}`); this.name = 'DeepCutsError'; this.code = code; this.detail = detail; }
  toString() { return this.message; }
}

/** Anything thrown by a command → DeepCutsError. Accepts the Rust envelope, a JSON string of it, or plain text. */
export function toDeepCutsError(raw: unknown): DeepCutsError {
  if (raw instanceof DeepCutsError) return raw;
  let text = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })();
  const env = (() => { try { const j = typeof raw === 'object' && raw && !(raw instanceof Error) ? raw : JSON.parse(text); return j && typeof j === 'object' && 'message' in j ? j as { code?: string; message: string } : null; } catch { return null; } })();
  if (env) { text = String(env.message); const c = env.code as ErrorCode | undefined; if (c && c in HINT) return new DeepCutsError(c, text); }
  const pre = /^\[([a-z_]+)\] ([\s\S]*)$/.exec(text);
  if (pre && pre[1] in HINT) return new DeepCutsError(pre[1] as ErrorCode, pre[2]);
  return new DeepCutsError(classify(text), text.replace(/^Error: /, ''));
}

/** For ErrorBox: split "[code] detail" (or any message) into code, hint and detail. */
export function describeError(message: string): { code: ErrorCode; hint: string; detail: string } {
  const e = toDeepCutsError(message);
  return { code: e.code, hint: e.code === 'invalid_input' || e.code === 'internal' ? e.detail : HINT[e.code], detail: e.detail };
}
