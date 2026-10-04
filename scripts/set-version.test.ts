import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, parseSemver, releaseIntent, setVersion } from './set-version.mjs';

const version = '0.1.2610020008-alpha.1';
describe('timestamp release contract', () => {
 test('validates actual UTC calendar values and canonical channels', () => {
  for (const valid of [version, '1.2.2402292359-rc', '1.2.2612312359', '1.2.2701010000-beta.3']) expect(parseSemver(valid)).not.toBeNull();
  for (const invalid of ['1.2.3', '1.2.2302291200', '1.2.2613320000', '1.2.2604310000', '1.2.2610022400', '1.2.2610020060', '01.2.2610020008', '1.2.2610020008-preview.1', '1.2.2610020008-alpha.0', '1.2.2610020008-rc.01', '1.2.2610020008-$(id)']) expect(parseSemver(invalid)).toBeNull();
  expect(parseSemver(version)?.timestamp).toBe('2026-10-02T00:08:00.000Z');
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
  expect(() => releaseIntent({ ...input, version: '1.0.2610020007-alpha.1', previous: version })).toThrow('clock regressed');
  expect(releaseIntent({ ...input, version: '0.1.2610020008-alpha.2', previous: version }).version).toContain('alpha.2');
  expect(() => releaseIntent({ ...input, version: '0.1.2610020008', previous: '0.1.2610020008' })).toThrow('collision');
 });
 test('stamps the release version without altering dependency declarations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fhold-set-version-'));
  const file = join(directory, 'package.json');
  writeFileSync(file, JSON.stringify({ version: 'old', dependencies: { native: '^1.2.3' } }));
  setVersion(file, version);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version, dependencies: { native: '^1.2.3' } });
 });
});
