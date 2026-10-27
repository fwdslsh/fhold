import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, parseSemver, releaseIntent, setVersion } from './set-version.mjs';

const version = '0.1.2610020008-alpha.1';
describe('release version contract', () => {
 test('validates actual UTC calendar values and canonical channels', () => {
  for (const valid of [version, '0.1.2402292359-rc', '0.1.2612312359', '0.1.2701010000-beta.3', '0.2.2610081-beta.1', '0.3.261000-beta', '1.0.240200-rc', '1.2.270101']) expect(parseSemver(valid)).not.toBeNull();
  for (const invalid of ['1.2.3', '0.1.2302291200', '0.1.2613320000', '0.1.2604310000', '0.1.2610022400', '0.1.2610020060', '01.2.2610021', '1.2.2610021-preview.1', '1.2.2610021-alpha.0', '1.2.2610021-rc.01', '1.2.2610021-$(id)', '0.2.2302291', '0.2.2613321', '0.2.2604311', '0.2.2610080', '0.2.26100801', '0.2.261008', '0.1.2610081', '0.2.261008123456789012345']) expect(parseSemver(invalid)).toBeNull();
  expect(parseSemver(version)?.timestamp).toBe('2026-10-02T00:08:00.000Z');
  expect(parseSemver('0.2.26100812-beta.1')).toMatchObject({ date: '2026-10-08', build: 12, channel: 'beta', serial: 1 });
 });
 test('orders daily builds by date then counter, not the packed numeric patch', () => {
  const ordered = ['0.1.2610082359-beta.2', '0.2.2610081-alpha.1', '0.2.2610081-alpha.10', '0.2.2610081-beta.1', '0.2.2610081-rc.1', '0.2.2610081', '0.2.2610082-alpha.1', '0.2.26100810-beta.1', '0.2.2610091-beta.1', '0.2.26123112', '0.2.2701011-alpha.1'];
  for (let i = 1; i < ordered.length; i++) expect(compareVersions(ordered[i - 1], ordered[i])).toBe(-1);
  expect(compareVersions('0.2.2610081-beta.1', '0.2.2610081-beta.1')).toBe(0);
  expect(compareVersions('0.2.24022910', '0.2.2403011')).toBe(-1);
 });
 test('uses numeric precedence across serial, channel, UTC day and year boundaries', () => {
  const ordered = ['0.1.2612312359-alpha.1', '0.1.2612312359-alpha.2', '0.1.2612312359-alpha.10', '0.1.2612312359-beta.1', '0.1.2612312359-rc.1', '0.1.2612312359', '0.1.2701010000-alpha.1'];
  for (let i = 1; i < ordered.length; i++) expect(compareVersions(ordered[i - 1], ordered[i])).toBe(-1);
 });
 test('freezes public retry identity and refuses collisions or regressed clocks', () => {
  const input = { version, revision: 'a'.repeat(40), contentSha256: 'b'.repeat(64) };
  const intent = releaseIntent(input);
  expect(releaseIntent({ ...input, existing: intent })).toBe(intent);
  expect(() => releaseIntent({ ...input, existing: { ...intent, contentSha256: 'c'.repeat(64) } })).toThrow('collision');
  expect(() => releaseIntent({ ...input, previous: version })).toThrow('collision');
  expect(() => releaseIntent({ ...input, previous: '0.1.2610020009-alpha.1' })).toThrow('clock regressed');
  expect(() => releaseIntent({ ...input, version: '1.0.260900-alpha', previous: version })).toThrow('clock regressed');
  expect(releaseIntent({ ...input, version: '0.1.2610020008-alpha.2', previous: version }).version).toContain('alpha.2');
  expect(() => releaseIntent({ ...input, version: '0.1.2610020008', previous: '0.1.2610020008' })).toThrow('collision');
 });
 test('unpublished candidate revisions can share a provisional version with fresh evidence', () => {
  const input = { version: '0.3.261008-beta', revision: 'a'.repeat(40), contentSha256: 'b'.repeat(64), previous: '0.3.261007-beta' };
  const first = releaseIntent(input);
  const rebuilt = releaseIntent({ ...input, revision: 'c'.repeat(40), contentSha256: 'd'.repeat(64) });
  expect(rebuilt.version).toBe(first.version);
  expect(rebuilt.revision).not.toBe(first.revision);
  expect(first.contentSha256).toBe(input.contentSha256);
  // Once public, the same version must retain the original identity.
  expect(() => releaseIntent({ ...input, revision: rebuilt.revision, contentSha256: rebuilt.contentSha256, existing: first })).toThrow('Immutable');
 });
 test('accepts the 0.2 boundary and next-day build reset while freezing retry identity', () => {
  const input = { version: '0.2.2610081-beta.1', revision: 'a'.repeat(40), contentSha256: 'b'.repeat(64) };
  expect(releaseIntent({ ...input, previous: '0.1.2610081904-beta.2' }).version).toBe(input.version);
  const intent = releaseIntent(input);
  expect(releaseIntent({ ...input, existing: intent })).toBe(intent);
  expect(() => releaseIntent({ ...input, existing: { ...intent, revision: 'c'.repeat(40) } })).toThrow('collision');
  expect(() => releaseIntent({ ...input, previous: input.version })).toThrow('collision');
  expect(() => releaseIntent({ ...input, version: '0.3.260900', previous: input.version })).toThrow('clock regressed');
  expect(() => releaseIntent({ ...input, version: '0.2.2610082', previous: '0.2.26100810' })).toThrow('regression');
  expect(releaseIntent({ ...input, version: '0.2.2610091-beta.1', previous: '0.2.26100810' }).version).toBe('0.2.2610091-beta.1');
 });
 test('validates monthly counters and rejects serials, old daily patches and overflow', () => {
  for (const value of ['0.3.261000-alpha', '0.3.261001-beta', '0.3.261099-rc', '0.3.270100', '1.0.261200']) expect(parseSemver(value)).not.toBeNull();
  for (const value of ['0.3.260000', '0.3.261300', '0.3.26100', '0.3.2610100', '0.3.261000-beta.1', '0.3.261000-preview', '0.3.2612225-beta.1']) expect(parseSemver(value)).toBeNull();
  expect(parseSemver('0.3.261099-beta')).toMatchObject({ date: '2026-10-01', build: 99, serial: null, format: 'monthly' });
 });
 test('orders monthly releases across channels, counters, month/year and historical lines', () => {
  const ordered = ['0.1.2610212359', '0.2.26102112-beta.13', '0.3.261000-alpha', '0.3.261000-beta', '0.3.261000-rc', '0.3.261000', '0.3.261001-alpha', '0.3.261099', '0.3.261100-beta', '0.3.261299', '0.3.270100-alpha', '1.0.270100'];
  for (let i = 1; i < ordered.length; i++) expect(compareVersions(ordered[i - 1], ordered[i])).toBe(-1);
 });
 test('monthly intent shares counters across channels, resets per month and freezes retries', () => {
  const input = { version: '0.3.261000-beta', revision: 'a'.repeat(40), contentSha256: 'b'.repeat(64) };
  expect(releaseIntent({ ...input, previous: '0.2.2610211-beta.13' }).version).toBe(input.version);
  const intent = releaseIntent(input);
  expect(releaseIntent({ ...input, existing: intent })).toBe(intent);
  expect(() => releaseIntent({ ...input, existing: { ...intent, revision: 'c'.repeat(40) } })).toThrow('collision');
  expect(() => releaseIntent({ ...input, previous: input.version })).toThrow('collision');
  expect(() => releaseIntent({ ...input, version: '0.3.261000-rc', previous: input.version })).toThrow('counter must advance');
  expect(releaseIntent({ ...input, version: '0.3.261001-rc', previous: input.version }).version).toBe('0.3.261001-rc');
  expect(releaseIntent({ ...input, version: '0.3.261100-beta', previous: '0.3.261099' }).version).toBe('0.3.261100-beta');
  expect(releaseIntent({ ...input, version: '0.3.270100', previous: '0.3.261299' }).version).toBe('0.3.270100');
  expect(() => releaseIntent({ ...input, version: '0.4.260999', previous: input.version })).toThrow('clock regressed');
  expect(() => releaseIntent({ ...input, version: '0.3.2610100' })).toThrow('Invalid');
 });
 test('stamps the release version without altering dependency declarations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fhold-set-version-'));
  const file = join(directory, 'package.json');
  writeFileSync(file, JSON.stringify({ version: 'old', dependencies: { native: '^1.2.3' } }));
  const dailyVersion = '0.2.2610081-beta.1';
  setVersion(file, dailyVersion);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: dailyVersion, dependencies: { native: '^1.2.3' } });
 });
});
