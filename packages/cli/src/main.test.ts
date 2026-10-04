import { describe, expect, it, spyOn } from 'bun:test';
import { join } from 'node:path';
import { defaultFholdHome, resolveFholdHome } from '@fhold/lib';

import { helpText, main } from './main.js';

describe('CLI help', () => {
	it('lists the complete command surface', () => {
		const help = helpText();
		for (const command of [
			'install',
			'setup',
			'provider',
			'backup',
			'history',
			'connect',
			'restore',
			'task',
			'update',
			'guardian',
			'credential',
			'portal',
			'config',
			'doctor',
			'start',
			'stop',
			'restart',
			'logs',
			'status'
		]) {
			expect(help).toContain(command);
		}
		expect(help).not.toContain('uninstall');
		expect(help).toContain('--name <name|absolute-path>');
		expect(help).not.toContain('--instance');
		expect(help).toContain('~/fhold/instances');
		expect(help).toContain('then FH_HOME, then the current directory');
		expect(() => helpText('addon')).toThrow('Unknown command');
		expect(() => helpText('import')).toThrow('Unknown command');
		expect(helpText('config')).toContain('assistant');
		expect(helpText('install')).toContain('--name <name|absolute-path>');
		expect(helpText('install')).not.toContain('--name <instance-name>');
		expect(helpText('portal')).toContain('credential <portal> --credential <username>');
		expect(helpText('credential')).toContain('set-policy');
		expect(helpText('provider')).toContain('login');
		expect(helpText('restore')).toContain('--dry-run');
		expect(helpText('restore')).toContain('--acknowledge-unrestored');
		expect(helpText('history')).toContain('--directory-map');
		expect(helpText('task')).toContain('create <id>');
		for (const command of ['remote', 'setup', 'config']) {
			expect(helpText(command)).toContain('Codex and Claude Code native remote access is experimental');
		}
	});
	it('shows nested remote help without running setup or requiring a tool', async () => {
		const output = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await main(['remote', 'enable', '--help']);
			await main(['remote', 'enable', 'claude', '--help']);
			expect(output).toHaveBeenCalledTimes(2);
			expect(output.mock.calls[0]?.[0]).toContain('remote enable');
			expect(output.mock.calls[1]?.[0]).toContain('experimental');
		} finally {
			output.mockRestore();
		}
	});
	it('uses the selected home for nested commands without changing the calling process environment', async () => {
		const previous = process.env.FH_HOME;
		const output = spyOn(console, 'log').mockImplementation(() => {});
		try {
			process.env.FH_HOME = '/tmp/fhold-ambient-selection';
			await main(['config', 'path', '--name', 'selected-agent']);
			expect(output.mock.calls.at(-1)?.[0]).toBe(join(resolveFholdHome(defaultFholdHome('selected-agent')), 'state', 'stack.json'));
			expect(process.env.FH_HOME).toBe('/tmp/fhold-ambient-selection');
			delete process.env.FH_HOME;
			await main(['config', 'path']);
			expect(output.mock.calls.at(-1)?.[0]).toBe(join(resolveFholdHome(process.cwd()), 'state', 'stack.json'));
			expect(process.env.FH_HOME).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.FH_HOME;
			else process.env.FH_HOME = previous;
			output.mockRestore();
		}
	});
});
