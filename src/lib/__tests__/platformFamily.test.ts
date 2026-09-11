/** PLATFORM_FAMILY is a SQL CASE; the only honest test runs it through DuckDB. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { PLATFORM_FAMILY } from '../sessionQueries';

let con: DuckDBConnection;
beforeAll(async () => { con = await (await DuckDBInstance.create(':memory:')).connect(); });
afterAll(() => { con.closeSync(); });

const fam = async (platform: string | null) => {
  const sql = `SELECT ${PLATFORM_FAMILY} AS fam FROM (SELECT ${platform === null ? 'NULL::VARCHAR' : `'${platform.replace(/'/g, "''")}'`} AS platform)`;
  const r = await (await con.prepare(sql)).runAndReadAll();
  return r.getRowObjectsJson()[0].fam;
};

describe('PLATFORM_FAMILY bucketing', () => {
  it('recognises the Spotify export platform strings', async () => {
    expect(await fam('Windows 7 (6.1.7601; x64; SP1; S)')).toBe('Windows');
    expect(await fam('Android OS 13 API 33 (Google, Pixel 7)')).toBe('Android');
    expect(await fam('iOS 17.1 (iPhone15,2)')).toBe('iPhone / iPad');
    expect(await fam('OS X 13.5.2 [arm 2]')).toBe('Mac');
    expect(await fam('Linux [x86-64 0]')).toBe('Linux');
    expect(await fam('web_player windows 10;chrome 118.0.0.0;desktop')).toBe('Web player');
    expect(await fam('Partner roku_tv rca;')).toBe('TV / speaker');
    expect(await fam('Partner sonos_unknown Sonos;Play:5;')).toBe('TV / speaker');
    expect(await fam('Partner android_tv Google;Chromecast;')).toBe('TV / speaker');
    expect(await fam('Partner playstation4 Sony;PS4;')).toBe('Console');
  });
  it('sends in-car listening to Car regardless of OS prefix', async () => {
    expect(await fam('Android OS 12 (carplay)')).toBe('Car');
    expect(await fam('iOS 16 (Auto)')).toBe('Car');
  });
  it('falls back sensibly', async () => {
    expect(await fam(null)).toBe('Unknown');
    expect(await fam('pano')).toBe('Other');
  });
});
