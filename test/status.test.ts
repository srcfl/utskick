import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { subscribe } from '../src/contacts.ts';
import { rows, testConfig, testEnv } from './helpers.ts';

// A server form key (effectively public) and a distinct STATUS_KEY. Status must never accept the form key.
const formKey = '5f0c1d2e3a4b59687766554433221100ffeeddccbbaa99887766554433221100';
const statusKey = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const config: Config = {
  ...testConfig,
  lists: {
    ...testConfig.lists,
    'the-source': { ...testConfig.lists['the-source'], consent: 'the-source-2026-11' },
  },
  forms: {
    'example-server': { lists: ['the-source'], key: true },
  },
  status: { lists: ['the-source'] },
};

function env() {
  const e = testEnv();
  e.CONFIG = config;
  e.FORM_KEYS = JSON.stringify({ 'example-server': formKey });
  e.STATUS_KEY = statusKey;
  return e;
}

interface Options { key?: string | null; ip?: string; method?: string; type?: string; query?: string }

function status(body: Record<string, unknown> | string, o: Options = {}) {
  const type = o.type ?? 'application/json';
  const headers: Record<string, string> = { 'Content-Type': type, 'CF-Connecting-IP': o.ip ?? '192.0.2.1' };
  if (o.key !== null) headers.Authorization = `Bearer ${o.key ?? statusKey}`;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const url = `https://news.test/subscribe/status${o.query ?? ''}`;
  return new Request(url, { method: o.method ?? 'POST', headers, body: o.method === 'GET' ? undefined : text });
}

async function refused(res: Response, code: number, error: string) {
  assert.equal(res.status, code);
  assert.deepEqual(await res.json(), { error });
}

async function onList(e: ReturnType<typeof env>, email: string, list = 'the-source') {
  await subscribe(e, { email, list, consent: 'the-source-2026-11', source: 'example-server' });
}

test('STATUS_KEY answers subscribed true or false for one address, and nothing else', async () => {
  const e = env();
  await onList(e, 'User@Example.com');

  const yes = await handle(status({ email: ' User@Example.com ', list: 'the-source' }), e);
  assert.equal(yes.status, 200);
  assert.equal(yes.headers.get('Cache-Control'), 'no-store');
  assert.equal(yes.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual(await yes.json(), { subscribed: true });

  const no = await handle(status({ email: 'stranger@example.com', list: 'the-source' }), e);
  assert.equal(no.status, 200);
  assert.deepEqual(await no.json(), { subscribed: false });
});

test('someone who left, bounced, or is only on another list is not subscribed', async () => {
  const e = env();
  e.CONFIG = { ...config, status: { lists: ['the-source', 'ftw-news'] } };
  await onList(e, 'reader@example.com');
  await subscribe(e, { email: 'reader@example.com', list: 'ftw-news', consent: 'news-1', source: 'example-server' });
  const { hash } = (await rows<{ hash: string }>(e, `SELECT email_hash AS hash FROM contacts WHERE email = 'reader@example.com'`))[0];
  await e.DB.prepare(`DELETE FROM subscriptions WHERE list = 'the-source'`).run();
  await e.DB.prepare(`INSERT INTO suppressions (email_hash, scope, reason) VALUES (?, 'the-source', 'unsubscribe')`).bind(hash).run();

  assert.deepEqual(await (await handle(status({ email: 'reader@example.com', list: 'the-source' }), e)).json(), { subscribed: false });
  assert.deepEqual(await (await handle(status({ email: 'reader@example.com', list: 'ftw-news' }), e)).json(), { subscribed: true });

  await e.DB.prepare('DELETE FROM subscriptions').run();
  await e.DB.prepare('DELETE FROM contacts').run();
  await e.DB.prepare(`INSERT INTO suppressions (email_hash, scope, reason) VALUES (?, '*', 'bounce')`).bind(hash).run();
  assert.deepEqual(await (await handle(status({ email: 'reader@example.com', list: 'the-source' }), e)).json(), { subscribed: false });
});

test('a form key is refused, even when it is also STATUS_KEY', async () => {
  const e = env();
  await onList(e, 'reader@example.com');
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }, { key: formKey }), e), 401, 'form_key_not_allowed');

  e.STATUS_KEY = formKey;
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }, { key: formKey }), e), 401, 'form_key_not_allowed');
  assert.equal(await e.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions').first('n'), 1, 'a refused status check does not change the list');
});

test('the admin token and a missing or wrong key cannot read status', async () => {
  const e = env();
  await onList(e, 'reader@example.com');
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }, { key: null }), e), 401, 'key_required');
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }, { key: statusKey.slice(0, -1) + '0' }), e), 401, 'invalid_key');
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }, { key: 'admin-secret' }), e), 401, 'invalid_key');
});

test('STATUS_KEY cannot be used as a form key on /subscribe or /unsubscribe', async () => {
  const e = env();
  const headers = { Authorization: `Bearer ${statusKey}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' };
  const signup = { email: 'reader@example.com', list: 'the-source', consent: 'the-source-2026-11' };
  await refused(await handle(new Request('https://news.test/subscribe', { method: 'POST', headers, body: JSON.stringify(signup) }), e), 401, 'invalid_key');
  await refused(await handle(new Request('https://news.test/unsubscribe', { method: 'POST', headers, body: JSON.stringify({ email: 'reader@example.com', list: 'the-source' }) }), e), 401, 'invalid_key');
  assert.deepEqual(await rows(e, 'SELECT 1 FROM contacts'), []);
});

test('only one address is read; an emails array is not a bulk lookup', async () => {
  const e = env();
  await onList(e, 'one@example.com');
  await onList(e, 'two@example.com');
  await refused(await handle(status({ emails: ['one@example.com', 'two@example.com'], list: 'the-source' }), e), 400, 'invalid_email');
  await refused(await handle(status({ email: ['one@example.com', 'two@example.com'], list: 'the-source' }), e), 400, 'invalid_email');
  const res = await handle(status({ email: 'one@example.com', emails: ['two@example.com'], list: 'the-source' }), e);
  assert.deepEqual(await res.json(), { subscribed: true }, 'only email is read; emails is ignored');
});

test('a list the status key may not query, or no list at all, is refused', async () => {
  const e = env();
  await refused(await handle(status({ email: 'reader@example.com', list: 'ftw-news' }), e), 400, 'invalid_list');
  await refused(await handle(status({ email: 'reader@example.com', list: 'nope' }), e), 400, 'invalid_list');
  await refused(await handle(status({ email: 'reader@example.com' }), e), 400, 'invalid_list');
  await refused(await handle(status({ email: 'not an address', list: 'the-source' }), e), 400, 'invalid_email');
});

test('GET is refused and never reads an address from the query string', async () => {
  const e = env();
  await onList(e, 'reader@example.com');
  const res = await handle(status({}, { method: 'GET', query: '?email=reader@example.com&list=the-source' }), e);
  await refused(res, 405, 'method_not_allowed');
  assert.equal(res.headers.get('Allow'), 'POST');
});

test('a missing or short STATUS_KEY closes the endpoint', async () => {
  const e = env();
  delete e.STATUS_KEY;
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }), e), 503, 'status_unavailable');
  e.STATUS_KEY = 'short';
  e.PUBLIC_URL = 'https://news.example.com';
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }), e), 503, 'status_unavailable');
});

test('without status.lists the endpoint is off even with STATUS_KEY', async () => {
  const e = env();
  const { status: _, ...rest } = config;
  e.CONFIG = rest;
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }), e), 503, 'status_unavailable');
});

test('logs name the list and the boolean, never the address or the key', async () => {
  const e = env();
  await onList(e, 'secret.user@example.com');
  const lines: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await handle(status({ email: 'secret.user@example.com', list: 'the-source' }), e);
    await handle(status({ email: 'secret.user@example.com', list: 'the-source' }, { key: formKey }), e);
    await handle(status({ email: 'secret.user@example.com', list: 'the-source' }, { key: 'nope' }), e);
  } finally {
    console.log = log;
    console.error = err;
  }
  assert.ok(lines.some(l => l.includes('subscription_status') && l.includes('the-source')));
  assert.ok(lines.some(l => l.includes('form_key_rejected')));
  const joined = lines.join('\n');
  assert.ok(!joined.includes('secret.user@example.com'), 'no address in the log');
  assert.ok(!joined.includes(statusKey.slice(0, 16)), 'no part of STATUS_KEY in the log');
  assert.ok(!joined.includes(formKey.slice(0, 16)), 'no part of the form key in the log');
});

test('a refused key does not consume the status rate limit', async () => {
  const e = env();
  const keys: string[] = [];
  e.STATUS_LIMITER = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } as RateLimit;
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }, { key: 'nope' }), e), 401, 'invalid_key');
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }, { key: formKey }), e), 401, 'form_key_not_allowed');
  assert.deepEqual(keys, []);
});

test('too many status checks from one client get 429 with Retry-After', async () => {
  const e = env();
  const keys: string[] = [];
  e.STATUS_LIMITER = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: false }; } } as RateLimit;
  const res = await handle(status({ email: 'reader@example.com', list: 'the-source' }, { ip: '2001:db8::1' }), e);
  await refused(res, 429, 'rate_limited');
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.deepEqual(keys, ['status:2001:db8:0:0::/64'], 'an IPv6 client counts per /64; X-Client-IP is not taken');
});

test('X-Client-IP does not split the status limit: the calling server is the client', async () => {
  const e = env();
  const keys: string[] = [];
  e.STATUS_LIMITER = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } as RateLimit;
  const req = status({ email: 'reader@example.com', list: 'the-source' }, { ip: '192.0.2.9' });
  req.headers.set('X-Client-IP', '198.51.100.1');
  assert.equal((await handle(req, e)).status, 200);
  assert.deepEqual(keys, ['status:192.0.2.9']);
});

test('a bad body is refused before a lookup', async () => {
  const e = env();
  await refused(await handle(status('{"email":', {}), e), 400, 'invalid_body');
  await refused(await handle(status({ email: 'reader@example.com', list: 'the-source' }, { type: 'application/x-www-form-urlencoded' }), e), 415, 'unsupported_media_type');
  await refused(await handle(status({ email: 'x'.repeat(3000), list: 'the-source' }), e), 413, 'too_large');
});

test('Sourceful: the web-app may ask about app-users with STATUS_KEY, never with the app form key, and never about The Source', async () => {
  const e = env();
  e.CONFIG = JSON.parse(readFileSync(new URL('../config/sourceful.json', import.meta.url), 'utf8'));
  const app = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  e.FORM_KEYS = JSON.stringify({ 'sourceful-app': app });
  e.STATUS_KEY = statusKey;
  await subscribe(e, { email: 'user@example.com', list: 'app-users', consent: 'app-account-2026-11', source: 'sourceful-app' });

  await refused(await handle(status({ email: 'user@example.com', list: 'app-users' }, { key: app }), e), 401, 'form_key_not_allowed');
  await refused(await handle(status({ email: 'user@example.com', list: 'the-source' }), e), 400, 'invalid_list');
  const res = await handle(status({ email: 'user@example.com', list: 'app-users' }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { subscribed: true });
});
