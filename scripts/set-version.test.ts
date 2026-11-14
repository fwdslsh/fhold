import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReleaseAdvance, compareVersions, parseSemver, setVersion } from './set-version.mjs';

describe('release version contract', () => {
 test('validates yearless month/counter patches from 0.4, without inventing a year', () => {
  for (const value of ['0.4.1001', '0.4.1002-beta', '0.4.1101-rc', '0.4.101-alpha', '0.4.999', '0.4.1299', '0.5.101', '1.0.1001']) expect(parseSemver(value)).not.toBeNull();
  for (const value of ['0.4.0101', '0.4.0001', '0.4.1000', '0.4.1301', '0.4.100', '0.4.10001', '0.4.261001', '0.4.1001-beta.1', '0.4.1001-preview', '0.3.1001', '0.3.261000-beta', '0.2.2610081-beta.1', '0.1.2610020008-alpha.1', '01.4.1001', '0.4.1001-$(id)']) expect(parseSemver(value)).toBeNull();
  expect(parseSemver('0.4.1001-beta')).toMatchObject({ month: 10, build: 1, pre: 'beta' });
  expect(parseSemver('0.4.101')?.month).toBe(1);
 });
 test('orders MMNN patches and enforces monotonic public counters and year rollover', () => {
  const ordered = ['0.4.101-alpha', '0.4.101-beta', '0.4.101-rc', '0.4.101', '0.4.102-alpha', '0.4.999', '0.4.1001', '0.4.1002', '0.4.1101', '0.4.1299', '0.5.101', '1.0.101'];
  for (let i = 1; i < ordered.length; i++) expect(compareVersions(ordered[i - 1], ordered[i])).toBe(-1);
  expect(compareVersions('0.4.1001-beta', '0.4.1001-beta')).toBe(0);
  const version = '0.4.1001-beta';
  expect(() => assertReleaseAdvance(version, '0.4.913-beta')).not.toThrow();
  expect(() => assertReleaseAdvance(version, version)).toThrow('collision');
  expect(() => assertReleaseAdvance('0.4.1001-rc', version)).toThrow('counter must advance');
  expect(() => assertReleaseAdvance('0.4.1002-rc', version)).not.toThrow();
  expect(() => assertReleaseAdvance('0.4.1001', '0.4.1002')).toThrow('regression');
  expect(() => assertReleaseAdvance('0.4.101', '0.4.1299')).toThrow('new minor line');
  expect(() => assertReleaseAdvance('0.5.101', '0.4.1299')).not.toThrow();
  expect(() => assertReleaseAdvance(version, '0.3.261013-beta')).toThrow('Invalid');
 });
 test('stamps the release version without altering dependency declarations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fhold-set-version-'));
  const file = join(directory, 'package.json');
  writeFileSync(file, JSON.stringify({ version: 'old', dependencies: { native: '^1.2.3' } }));
  const version = '0.4.1001-beta';
  setVersion(file, version);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version, dependencies: { native: '^1.2.3' } });
 });
});
