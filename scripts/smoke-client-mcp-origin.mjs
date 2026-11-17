// OpenCode's own origin check for browser client-MCP connections, with the
// origin configured through FH_OPENCODE_CORS. Runs inside the Assistant with
// the official client; only the WebSocket Origin header stands in for a browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [allowed, other] = process.argv.slice(2);
assert(allowed && other, 'usage: smoke-client-mcp-origin.mjs ALLOWED_ORIGIN OTHER_ORIGIN');
// The image's own client package, through its published `./mcp` export.
const client = join(
	dirname(process.env.FH_BROWSER_TOOLS_MANIFEST || '/opt/fhold/tools/package.json'),
	'node_modules/@opencode/client'
);
const mcpExport = JSON.parse(readFileSync(join(client, 'package.json'), 'utf8')).exports['./mcp']
	.import;
const { connectClientMcp } = await import(pathToFileURL(join(client, mcpExport)).href);
const port = Number(process.env.OPENCODE_PORT || 4096);
const base = `http://127.0.0.1:${port}`;
const password =
	process.env.OPENCODE_SERVER_PASSWORD ||
	readFileSync(
		process.env.OPENCODE_SERVER_PASSWORD_FILE || '/run/secrets/opencode_server_password',
		'utf8'
	).trim();
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
const query = `name=fhold_origin&location%5Bdirectory%5D=${encodeURIComponent('/work')}`;

async function ticket() {
	const response = await fetch(`${base}/api/experimental/client-mcp/token?${query}`, {
		method: 'POST',
		headers: { authorization, 'x-opencode-ticket': '1' }
	});
	assert.equal(response.status, 200, 'Native client-MCP ticket request failed');
	return (await response.json()).data.ticket;
}

// The HTTP status of a WebSocket upgrade, as a browser at `origin` would send it.
function upgrade(origin, value) {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () =>
			socket.write(
				`GET /api/experimental/client-mcp?${query}&ticket=${value} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
					`Origin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
					'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZmhvbGQtb3JpZ2luLXNtb2tl\r\n\r\n'
			)
		);
		socket.setTimeout(10_000, () => socket.destroy(new Error('Upgrade timed out')));
		socket.once('data', (data) => {
			socket.destroy();
			resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data.toString())?.[1]));
		});
		socket.once('error', reject);
	});
}

// The official client must complete the MCP tools exchange from the allowed origin.
function toolsExchange(origin, value) {
	return new Promise((resolve, reject) => {
		class OriginWebSocket extends WebSocket {
			constructor(url) {
				super(url, { headers: { Origin: origin } });
				this.addEventListener('message', (event) => {
					if (JSON.parse(event.data).method === 'tools/list') finish(resolve);
				});
			}
		}
		const connection = connectClientMcp({
			url: `${base}/?ticket=${value}`,
			name: 'fhold_origin',
			directory: '/work',
			tools: [{ name: 'ping', handler: () => ({ content: [{ type: 'text', text: 'pong' }] }) }],
			WebSocket: OriginWebSocket
		});
		const timer = setTimeout(
			() => finish(() => reject(new Error('No MCP tools exchange'))),
			15_000
		);
		function finish(settle) {
			clearTimeout(timer);
			connection.close().then(() => settle());
		}
	});
}

assert.equal(await upgrade(other, await ticket()), 403, 'An unlisted origin was accepted');
assert.equal(await upgrade(allowed, 'not-a-ticket'), 403, 'An invalid ticket was accepted');
const used = await ticket();
await toolsExchange(allowed, used);
assert.equal(await upgrade(allowed, used), 403, 'A used ticket was accepted again');
console.log(
	'Client-MCP origin passed: configured origin completes the MCP tools exchange; unlisted origin, invalid and reused tickets are refused'
);
