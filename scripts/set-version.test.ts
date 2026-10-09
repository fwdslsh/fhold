import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, parseSemver, releaseIntent, setVersion } from './set-version.mjs';

const version = '0.1.2610020008-alpha.1';
describe('release version contract', () => {
 test('validates actual UTC calendar values and canonical channels', () => {
  for (const valid of [version, '0.1.2402292359-rc', '0.1.2612312359', '0.1.2701010000-beta.3', '0.2.2610081-beta.1', '0.3.2612225-beta.1', '1.0.24022912-rc', '1.2.2701011']) expect(parseSemver(valid)).not.toBeNull();
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
 test('freezes retry identity and refuses collisions or regressed clocks', () => {
  const input = { version, revision: 'a'.repeat(40), contentSha256: 'b'.repeat(64) };
  const intent = releaseIntent(input);
  expect(releaseIntent({ ...input, existing: intent })).toBe(intent);
  expect(() => releaseIntent({ ...input, existing: { ...intent, contentSha256: 'c'.repeat(64) } })).toThrow('collision');
  expect(() => releaseIntent({ ...input, previous: version })).toThrow('collision');
  expect(() => releaseIntent({ ...input, previous: '0.1.2610020009-alpha.1' })).toThrow('clock regressed');
  expect(() => releaseIntent({ ...input, version: '1.0.2610011-alpha.1', previous: version })).toThrow('clock regressed');
  expect(releaseIntent({ ...input, version: '0.1.2610020008-alpha.2', previous: version }).version).toContain('alpha.2');
  expect(() => releaseIntent({ ...input, version: '0.1.2610020008', previous: '0.1.2610020008' })).toThrow('collision');
 });
 test('accepts the 0.2 boundary and next-day build reset while freezing retry identity', () => {
  const input = { version: '0.2.2610081-beta.1', revision: 'a'.repeat(40), contentSha256: 'b'.repeat(64) };
  expect(releaseIntent({ ...input, previous: '0.1.2610081904-beta.2' }).version).toBe(input.version);
  const intent = releaseIntent(input);
  expect(releaseIntent({ ...input, existing: intent })).toBe(intent);
  expect(() => releaseIntent({ ...input, existing: { ...intent, revision: 'c'.repeat(40) } })).toThrow('collision');
  expect(() => releaseIntent({ ...input, previous: input.version })).toThrow('collision');
  expect(() => releaseIntent({ ...input, version: '0.3.2610071', previous: input.version })).toThrow('clock regressed');
  expect(() => releaseIntent({ ...input, version: '0.2.2610082', previous: '0.2.26100810' })).toThrow('regression');
  expect(releaseIntent({ ...input, version: '0.2.2610091-beta.1', previous: '0.2.26100810' }).version).toBe('0.2.2610091-beta.1');
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
