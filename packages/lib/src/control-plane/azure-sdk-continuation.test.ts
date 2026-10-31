import { describe, expect, it } from 'bun:test';
import {
	ContainerAppsAPIClient,
	restorePoller as restoreAppsPoller
} from '@azure/arm-appcontainers';
import {
	ResourceManagementClient,
	restorePoller as restoreResourcesPoller
} from '@azure/arm-resources';
import { azureContinuation } from '../hosting/azure-client.js';

type ClientOptions = NonNullable<ConstructorParameters<typeof ContainerAppsAPIClient>[2]>;
type TestHttpClient = NonNullable<ClientOptions['httpClient']>;
const subscription = '11111111-1111-1111-1111-111111111111';
const resourceId = `/subscriptions/${subscription}/resourceGroups/fixture/providers/Microsoft.App/containerApps/assistant`;
const operationUrl = `https://management.azure.com/subscriptions/${subscription}/providers/Microsoft.App/locations/eastus/operationStatuses/fixture`;
const privateValue = 'synthetic-secret-that-must-not-be-persisted';
const credential = {
	async getToken() {
		return { token: 'synthetic-token-no-azure-auth', expiresOnTimestamp: Date.now() + 3_600_000 };
	}
};

/** The real SDK pipeline runs; this terminal transport cannot access the network. */
function transport() {
	const requests: Array<{ method: string; url: string }> = [];
	const httpClient: TestHttpClient = {
		async sendRequest(request) {
			requests.push({ method: request.method, url: request.url });
			const initial = request.method !== 'GET';
			const statusRequest = request.url.startsWith(operationUrl);
			const body = statusRequest
				? { status: 'Succeeded' }
				: {
						id: resourceId,
						name: 'assistant',
						location: 'eastus',
						properties: {
							provisioningState: initial ? 'Updating' : 'Succeeded',
							configuration: { secrets: [{ name: 'native-password', value: privateValue }] }
						}
					};
			// Reuse the SDK's header implementation without importing another dependency.
			for (const [name] of request.headers) request.headers.delete(name);
			request.headers.set('content-type', 'application/json');
			if (initial) {
				request.headers.set('azure-asyncoperation', operationUrl);
				request.headers.set('location', `https://management.azure.com${resourceId}`);
			}
			return {
				request,
				status: initial ? 202 : 200,
				headers: request.headers,
				bodyAsText: JSON.stringify(body)
			};
		}
	};
	return { requests, httpClient };
}

describe('official Azure SDK continuation', () => {
	for (const kind of ['start', 'patch'] as const) {
		it(`restores ${kind} using only GET and persists no response body or secret`, async () => {
			const fixture = transport();
			const options = { httpClient: fixture.httpClient, retryOptions: { maxRetries: 0 } };
			const apps = new ContainerAppsAPIClient(credential, subscription, options);
			const resources = new ResourceManagementClient(credential, subscription, options);
			const original =
				kind === 'start'
					? apps.containerApps.start('fixture', 'assistant', { updateIntervalInMs: 1 })
					: resources.resources.updateById(
							resourceId,
							'2026-07-01',
							{
								properties: {
									configuration: { secrets: [{ name: 'native-password', value: privateValue }] }
								}
							},
							{ updateIntervalInMs: 1 }
						);
			const raw = await original.serialize();
			expect(raw).not.toContain(privateValue);
			const saved = await azureContinuation(original);
			expect(saved).not.toContain(privateValue);
			expect(saved).not.toContain('synthetic-token');
			const parsed = JSON.parse(saved);
			expect(Object.keys(parsed)).toEqual(['state']);
			expect(Object.keys(parsed.state).sort()).toEqual(['config', 'status']);
			expect(parsed.state.config.metadata).toEqual({ mode: 'OperationLocation' });
			expect(
				Object.keys(parsed.state.config).every((key) =>
					[
						'operationLocation',
						'resourceLocation',
						'initialRequestUrl',
						'requestMethod',
						'metadata'
					].includes(key)
				)
			).toBe(true);
			// A future SDK may add cached response/request data. Never persist it.
			const expanded = JSON.parse(raw);
			expanded.state.result = { secret: privateValue };
			expanded.state.config.body = { secret: privateValue };
			expanded.state.config.metadata.authorization = privateValue;
			expect(
				await azureContinuation({
					serialize: async () => JSON.stringify(expanded),
					pollUntilDone: () => original.pollUntilDone()
				})
			).toBe(saved);
			expect(fixture.requests.map(({ method }) => method)).toEqual([
				kind === 'start' ? 'POST' : 'PATCH'
			]);
			fixture.requests.length = 0;
			const restored =
				kind === 'start'
					? restoreAppsPoller(apps, saved, apps.containerApps.start, { updateIntervalInMs: 1 })
					: restoreResourcesPoller(resources, saved, resources.resources.updateById, {
							updateIntervalInMs: 1
						});
			await restored.pollUntilDone();
			expect(restored.operationState?.status).toBe('succeeded');
			expect(fixture.requests.length).toBeGreaterThan(0);
			expect(fixture.requests.every(({ method }) => method === 'GET')).toBe(true);
			expect(fixture.requests[0]?.url).toStartWith(operationUrl);
		});
	}
});
