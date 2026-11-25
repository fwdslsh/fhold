import { expect, test } from 'bun:test';
import { knowledgeRequestHeaders } from './admin-knowledge-auth.js';

const origin = 'http://127.0.0.1:4500';
const secret = 'synthetic-credential-not-a-real-secret';
const bearer = `Bearer ${secret}`;

test('only the exact AKM origin receives the main-process credential', () => {
	expect(
		knowledgeRequestHeaders(`${origin}/api/session`, origin, secret, { Accept: 'application/json' })
	).toEqual({ Accept: 'application/json', Authorization: bearer });
	for (const url of [
		'http://127.0.0.1:4501/',
		'https://127.0.0.1:4500/',
		'https://other.example/',
		'http://user@127.0.0.1:4500/',
		'not a URL'
	]) {
		expect(knowledgeRequestHeaders(url, origin, secret, {})).toEqual({});
		expect(knowledgeRequestHeaders(url, origin, secret, { authorization: bearer })).toEqual({});
	}
});

test('redirect stripping preserves unrelated headers and never mutates request input', () => {
	const headers = { Authorization: bearer, Accept: 'text/html' };
	expect(knowledgeRequestHeaders('https://docs.example/', origin, secret, headers)).toEqual({
		Accept: 'text/html'
	});
	expect(headers.Authorization).toBe(bearer);
	expect(
		knowledgeRequestHeaders(`${origin}/`, origin, secret, { authorization: 'Bearer stale' })
	).toEqual({ Authorization: bearer });
});

test('a closed view cannot add a credential; another instance gets only its own credential', () => {
	expect(knowledgeRequestHeaders(`${origin}/`, origin, undefined, {})).toEqual({});
	expect(knowledgeRequestHeaders(`${origin}/`, origin, 'another-instance-secret', {})).toEqual({
		Authorization: 'Bearer another-instance-secret'
	});
});
