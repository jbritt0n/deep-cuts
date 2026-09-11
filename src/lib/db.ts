import { invoke } from './bridge';

export type Row = Record<string, unknown>;

/** Read-only SQL against the active record. All analytics SQL lives in TS (queries.ts). */
export async function query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return invoke<T[]>('query', { sql, params });
}

export const num = (v: unknown, d = 0) => (v === null || v === undefined ? d : Number(v));
export const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
