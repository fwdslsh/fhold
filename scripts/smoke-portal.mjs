// Runs inside the shipped Portal image: a local Slack protocol fixture, no accounts.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

assert.notEqual(process.getuid(), 0, 'Portal runs non-root');
assert.equal(process.versions.bun, undefined, 'Slack must use its supported Node runtime');
const require = createRequire(`${process.cwd()}/package.json`);
const slackRequire = createRequire(require.resolve('@slack/bolt'));
const socketRequire = createRequire(slackRequire.resolve('@slack/socket-mode'));
const { SocketModeClient } = slackRequire('@slack/socket-mode');
assert.equal(typeof socketRequire('undici').ping, 'function', 'native WebSocket heartbeat API');
const discordRequire = createRequire(require.resolve('discord.js'));
const wsRequire = createRequire(discordRequire.resolve('@discordjs/ws'));
const { WebSocketServer } = wsRequire('ws');
const database = new DatabaseSync(':memory:');
database.exec('CREATE TABLE conversations (handle TEXT NOT NULL) STRICT');
database.prepare('INSERT INTO conversations VALUES (?)').run('opaque.fixture');
assert.equal(database.prepare('SELECT handle FROM conversations').get().handle, 'opaque.fixture');
database.close();

let apiCalls = 0;
let connections = 0;
let pings = 0;
let acknowledgements = 0;
let received = 0;
const errors = [];
let peer;
const server = createServer((request, response) => {
	assert.equal(request.url, '/apps.connections.open');
	apiCalls++;
	response.setHeader('content-type', 'application/json');
	response.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${server.address().port}/socket` }));
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
	sockets.handleUpgrade(request, socket, head, (websocket) => {
		sockets.emit('connection', websocket, request);
	});
});
sockets.on('connection', (socket) => {
	connections++;
	peer = socket;
	socket.on('ping', () => pings++);
	socket.on('message', (data) => {
		assert.equal(JSON.parse(data.toString()).envelope_id, `fixture-${connections}`);
		acknowledgements++;
	});
	socket.send(JSON.stringify({ type: 'hello', num_connections: 1, debug_info: {} }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const client = new SocketModeClient({
	appToken: 'fixture-app-token',
	clientOptions: { slackApiUrl: `http://127.0.0.1:${server.address().port}/` },
	logger: {
		debug() {},
		info() {},
		warn(message) {
			errors.push(message);
		},
		error(message) {
			errors.push(message);
		},
		setLevel() {},
		getLevel() {
			return 'info';
		},
		setName() {}
	}
});
client.on('app_mention', async ({ ack }) => {
	received++;
	await ack();
});

async function waitFor(predicate, description) {
	const deadline = Date.now() + 30_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, `timed out: ${description}; ${errors.join('; ')}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
function mention() {
	peer.send(
		JSON.stringify({
			type: 'events_api',
			envelope_id: `fixture-${connections}`,
			accepts_response_payload: false,
			payload: {
				type: 'event_callback',
				event: {
					type: 'app_mention',
					user: 'U123',
					channel: 'C123',
					text: '<@U456> hello',
					ts: `${connections}.000001`
				}
			}
		})
	);
}

try {
	await client.start();
	mention();
	await waitFor(() => acknowledgements === 1, 'initial mention and acknowledgement');
	await waitFor(() => pings >= 2, 'two real ping/pong cycles');
	assert.equal(connections, 1, 'healthy heartbeat must not reconnect');
	assert.equal(client.websocket.isActive(), true);
	peer.close(1001, 'fixture reconnect');
	await waitFor(
		() => connections === 2 && client.websocket.isActive(),
		'native automatic reconnect'
	);
	mention();
	await waitFor(() => acknowledgements === 2, 'mention delivery after reconnect');
	assert.equal(received, 2);
	assert.equal(apiCalls, 2);
	assert.deepEqual(errors, []);
	console.log(
		'Portal: native Node SQLite, Slack heartbeat, mention/ack and automatic reconnect passed'
	);
} finally {
	await client.disconnect();
	for (const socket of sockets.clients) socket.terminate();
	await new Promise((resolve) => sockets.close(resolve));
	await new Promise((resolve) => server.close(resolve));
}
