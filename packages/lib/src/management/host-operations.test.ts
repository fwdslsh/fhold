import { expect, test } from 'bun:test';
import { hostOperations } from './host-operations.js';
import { capabilities, type HostingSnapshot, type InstanceSession } from '../hosting/types.js';

function fixture() {
	let supported = true;
	const calls: unknown[] = [];
	const snapshot = (): HostingSnapshot => ({
		ref: { kind: 'azure-container-apps', connectionId: 'cloud', resourceId: '/synthetic/agent' },
		name: 'agent',
		location: '/synthetic/agent',
		services: [],
		warnings: [],
		capabilities: capabilities(
			supported ? ['start', 'stop', 'restart'] : [],
			'Inspect-only deployment.'
		),
		actionEffects: { restart: 'restart-runtime' }
	});
	const native: InstanceSession = {
		ref: snapshot().ref,
		inspect: async () => snapshot(),
		logs: async () => '',
		operate: async (action, confirmed, options) => {
			calls.push({ action, confirmed, options });
			return { snapshot: snapshot() };
		}
	};
	return {
		...hostOperations(native),
		calls,
		disable: () => {
			supported = false;
		}
	};
}
test('a direct lifecycle command needs no prior optional diagnostic and preserves the exact revision', async () => {
	const f = fixture();
	if (f.host.restart.support !== 'supported') throw new Error('fixture');
	expect(f.host.restart.availability()).toEqual({ state: 'ready' });
	await f.host.restart.invoke({ revision: 'agent--one' }, { confirmed: true });
	expect(f.calls).toEqual([
		{ action: 'restart', confirmed: true, options: { revision: 'agent--one' } }
	]);
	expect(f.host.restart.effect).toBe('restart-runtime');
});
test('display eligibility follows inspection and a mutation rechecks changed target authority', async () => {
	const f = fixture();
	await f.inspectHost();
	if (f.host.stop.support !== 'supported') throw new Error('fixture');
	expect(f.host.stop.availability()).toEqual({ state: 'ready' });
	f.disable();
	await expect(f.host.stop.invoke(undefined, { confirmed: true })).rejects.toThrow('Inspect-only');
	expect(f.calls).toEqual([]);
	expect(f.host.stop.availability()).toMatchObject({
		state: 'unavailable',
		reason: 'Inspect-only deployment.'
	});
});
