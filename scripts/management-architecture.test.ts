import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('hosting and agent management boundaries', () => {
	it('composes host adapters above application services without the old runtime import cycle', () => {
		const local = read('packages/lib/src/hosting/local-docker.ts');
		expect(local).not.toMatch(/from\s+['"]\.\.\/management\/instance(?:-session)?\.js['"]/);
		for (const name of [
			'contracts',
			'instance',
			'instance-session',
			'agent-models',
			'agent-access'
		]) {
			const file = `packages/lib/src/management/${name}.ts`;
			if (!existsSync(join(root, file))) continue;
			expect(read(file), file).not.toMatch(
				/from\s+['"]\.\.\/hosting\/(?:provider|local-docker|ssh-docker|azure-container-apps)\.js['"]/
			);
		}
	});

	it('keeps ordinary Admin feature pages independent of hosting provider names and old remote mode', () => {
		for (const name of [
			'access',
			'configuration',
			'connections',
			'instance-presentation',
			'keys',
			'providers',
			'recovery',
			'remote',
			'runtime',
			'snapshot'
		]) {
			const file = `packages/electron/admin/${name}.js`;
			const source = read(file);
			expect(source, file).not.toMatch(/['"](?:local-docker|ssh-docker|azure-container-apps)['"]/);
			expect(source, file).not.toMatch(/\.phase\s*===?\s*['"]remote['"]/);
		}
	});

	it('uses the common session contract in Admin instead of optional full-management detection', () => {
		const source = read('packages/electron/src/admin-app.ts');
		expect(source).not.toMatch(/\.management\?\./);
		expect(source).not.toMatch(/phase:\s*['"]remote['"]/);
		const startup = read('packages/electron/src/admin-main.ts');
		expect(startup).not.toMatch(/snapshot\.config\b/);
		expect(startup).toContain("snapshot.docker?.config.deployment.projectName !== 'custom-agent'");
	});
	it('keeps native services and generic composition independent of deployment completion and transport classes', () => {
		const service = read('packages/lib/src/management/agent-services.ts');
		expect(service).not.toMatch(
			/\b(?:configureGuardianModeratorModel|markInstalled|mutateStack)\b/
		);
		const composition = read('packages/lib/src/management/instance-session.ts');
		expect(composition).not.toMatch(/from\s+['"]\.\/ssh\.js['"]/);
		const wire = read('packages/lib/src/management/types.ts');
		expect(wire).not.toMatch(/call<T>/);
	});
});
