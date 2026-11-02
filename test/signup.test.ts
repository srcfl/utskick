import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { rows, testConfig, testEnv } from './helpers.ts';

// Two forms: one in a browser on example.com, one behind a server route that holds a key.
// ftw-box has no consent id, so no form can sign anyone up for it.
const config: Config = {
  ...testConfig,
  lists: {
    ...testConfig.lists,
    'the-source': { ...testConfig.lists['the-source'], consent: 'the-source-2026-11' },
    'ftw-news': { ...testConfig.lists['ftw-news'], consent: 'news-2026-10-30' },
  },
  forms: {
    'example-web': { lists: ['the-source', 'ftw-box'], origins: ['https://example.com', 'https://www.example.com'] },
    'example-server': { lists: ['the-source', 'ftw-news'], origins: ['https://app.example.com'], key: true },
  },
};
const key = '5f0c1d2e3a4b59687766554433221100ffeeddccbbaa99887766554433221100';

function env() {
  const e = testEnv();
  e.CONFIG = config;
  e.FORM_KEYS = JSON.stringify({ 'example-server': key });
  return e;
}

const signup = { email: 'Reader@Example.com', list: 'the-source', consent: 'the-source-2026-11', first_name: 'Robin', country: 'se' };

interface Options { origin?: string | null; type?: string; key?: string; ip?: string; method?: string }

function post(body: Record<string, string> | string, o: Options = {}) {
  const type = o.type ?? 'application/json';
  const headers: Record<string, string> = { 'Content-Type': type, 'CF-Connecting-IP': o.ip ?? '192.0.2.1' };
  if (o.origin !== null) headers.Origin = o.origin ?? 'https://www.example.com';
  if (o.key) headers.Authorization = `Bearer ${o.key}`;
  const text = typeof body === 'string' ? body : type === 'application/json' ? JSON.stringify(body) : new URLSearchParams(body).toString();
  return new Request('https://news.test/subscribe', { method: o.method ?? 'POST', headers, body: text });
}

function preflight(origin: string) {
  return new Request('https://news.test/subscribe', {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
}

const stored = (e: ReturnType<typeof env>) => rows(e, `SELECT c.email, c.first_name, c.country, s.list, s.consent, s.source
  FROM subscriptions s JOIN contacts c ON c.id = s.contact_id ORDER BY c.email, s.list`);

async function refused(res: Response, status: number, error: string) {
  assert.equal(res.status, status);
  assert.deepEqual(await res.json(), { error });
}

test('a browser form on an allowed origin signs the reader up, with CORS for that origin only', async () => {
  const e = env();
  const res = await handle(post(signup), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://www.example.com');
  assert.match(res.headers.get('Vary') ?? '', /Origin/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await stored(e), [
    { email: 'reader@example.com', first_name: 'Robin', country: 'SE', list: 'the-source', consent: 'the-source-2026-11', source: 'example-web' },
  ]);
});

test('an origin not on the list is refused and nothing is stored', async () => {
  const e = env();
  for (const origin of ['https://evil.example', 'https://example.com.evil.example', 'http://example.com', 'null']) {
    const res = await handle(post(signup, { origin }), e);
    await refused(res, 403, 'origin_not_allowed');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    assert.match(res.headers.get('Vary') ?? '', /Origin/);
  }
  assert.deepEqual(await stored(e), []);
});

test('a preflight is answered only for a browser form origin', async () => {
  const e = env();
  const ok = await handle(preflight('https://example.com'), e);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://example.com');
  assert.equal(ok.headers.get('Access-Control-Allow-Methods'), 'POST');
  assert.equal(ok.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
  assert.match(ok.headers.get('Vary') ?? '', /Origin/);
  // A form that needs a key is never posted from a browser, so its origins get no preflight.
  for (const origin of ['https://evil.example', 'https://app.example.com']) {
    const no = await handle(preflight(origin), e);
    await refused(no, 403, 'origin_not_allowed');
    assert.equal(no.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('a server form needs its key, compared exactly', async () => {
  const e = env();
  await refused(await handle(post(signup, { origin: null }), e), 401, 'key_required');
  await refused(await handle(post(signup, { origin: 'https://app.example.com' }), e), 401, 'key_required');
  await refused(await handle(post(signup, { origin: null, key: key.slice(0, -1) + 'f' }), e), 401, 'invalid_key');
  await refused(await handle(post(signup, { origin: null, key: 'admin-secret' }), e), 401, 'invalid_key');
  assert.deepEqual(await stored(e), []);

  const res = await handle(post({ ...signup, list: 'ftw-news', consent: 'news-2026-10-30' }, { origin: null, key }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual((await stored(e)).map(r => [r.list, r.source]), [['ftw-news', 'example-server']]);
});

test('a keyed request from a browser origin not on its form is refused', async () => {
  const e = env();
  await refused(await handle(post(signup, { origin: 'https://evil.example', key }), e), 403, 'origin_not_allowed');
  assert.deepEqual(await stored(e), []);
});

test('the consent must be the list\'s current id, so a form cannot record a text we never showed', async () => {
  const e = env();
  await refused(await handle(post({ ...signup, consent: 'the-source-2020-01' }), e), 400, 'invalid_consent');
  await refused(await handle(post({ ...signup, consent: '' }), e), 400, 'invalid_consent');
  const { consent: _, ...without } = signup;
  await refused(await handle(post(without), e), 400, 'invalid_consent');
  // A list without a consent id in the config takes no form sign-ups.
  await refused(await handle(post({ ...signup, list: 'ftw-box', consent: 'anything' }), e), 400, 'invalid_consent');
  assert.deepEqual(await stored(e), []);
});

test('a list the form may not use, or no list at all, is refused', async () => {
  const e = env();
  await refused(await handle(post({ ...signup, list: 'ftw-news', consent: 'news-2026-10-30' }), e), 400, 'invalid_list');
  await refused(await handle(post({ ...signup, list: 'nope' }), e), 400, 'invalid_list');
  await refused(await handle(post({ ...signup, list: 'constructor' }), e), 400, 'invalid_list');
  assert.deepEqual(await stored(e), []);
});

test('bad fields are refused one by one and store nothing', async () => {
  const e = env();
  await refused(await handle(post({ ...signup, email: 'not an address' }), e), 400, 'invalid_email');
  await refused(await handle(post({ ...signup, country: 'Sweden' }), e), 400, 'invalid_country');
  await refused(await handle(post('{"email":', {}), e), 400, 'invalid_body');
  await refused(await handle(post('["a"]', {}), e), 400, 'invalid_body');
  await refused(await handle(post(signup, { type: 'text/plain' }), e), 415, 'unsupported_media_type');
  await refused(await handle(post(signup, { method: 'PUT' }), e), 405, 'method_not_allowed');
  assert.deepEqual(await stored(e), []);
});

test('a filled honeypot looks accepted and stores nothing', async () => {
  const e = env();
  const res = await handle(post({ ...signup, website: 'https://spam.example' }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(await stored(e), []);
});

test('a body over 2 KB is refused before it is read in full', async () => {
  const e = env();
  await refused(await handle(post({ ...signup, first_name: 'x'.repeat(2100) }), e), 413, 'too_large');
  const stream = new ReadableStream({
    start(c) { for (let i = 0; i < 100; i++) c.enqueue(new TextEncoder().encode('x'.repeat(100))); c.close(); },
  });
  const chunked = new Request('https://news.test/subscribe', {
    method: 'POST', body: stream, duplex: 'half',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
  } as RequestInit);
  await refused(await handle(chunked, e), 413, 'too_large');
  assert.deepEqual(await stored(e), []);
});

test('a client that posts too often gets 429 with Retry-After, per address and form', async () => {
  const e = env();
  for (let i = 0; i < 10; i++) assert.equal((await handle(post({ ...signup, email: `r${i}@example.com` }), e)).status, 200);
  const res = await handle(post({ ...signup, email: 'late@example.com' }), e);
  await refused(res, 429, 'rate_limited');
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://www.example.com', 'the page can read the 429');
  assert.equal((await rows(e, `SELECT 1 FROM contacts WHERE email = 'late@example.com'`)).length, 0);
  // Another client, or the same client on another form, is not held back.
  assert.equal((await handle(post({ ...signup, email: 'other@example.com' }, { ip: '192.0.2.2' }), e)).status, 200);
  assert.equal((await handle(post({ ...signup, email: 'server@example.com' }, { origin: null, key }), e)).status, 200);
});

test('the Workers rate limiter is used when it is bound, keyed by form and client address', async () => {
  const e = env();
  const keys: string[] = [];
  e.SIGNUP_LIMITER = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: false }; } } as RateLimit;
  await refused(await handle(post(signup, { ip: '2001:db8::1' }), e), 429, 'rate_limited');
  assert.deepEqual(keys, ['example-web:2001:db8:0:0::/64'], 'an IPv6 client counts per /64');
  assert.deepEqual(await stored(e), []);
});

test('a new, a known and a suppressed address get the same answer', async () => {
  const e = env();
  const answer = async (email: string, ip: string) => {
    const res = await handle(post({ ...signup, email }, { ip }), e);
    return { status: res.status, body: await res.text(), headers: [...res.headers] };
  };
  const first = await answer('known@example.com', '192.0.2.10');
  const again = await answer('known@example.com', '192.0.2.11');
  const { hash } = (await rows<{ hash: string }>(e, `SELECT email_hash AS hash FROM contacts`))[0];
  await e.DB.prepare('DELETE FROM subscriptions').run();
  await e.DB.prepare('DELETE FROM contacts').run();
  await e.DB.prepare(`INSERT INTO suppressions (email_hash, scope, reason) VALUES (?, '*', 'bounce')`).bind(hash).run();
  const suppressed = await answer('known@example.com', '192.0.2.12');
  assert.deepEqual(again, first);
  assert.deepEqual(suppressed, first);
  assert.deepEqual(await stored(e), [], 'a bounced address stays out');
});

test('signing up again does not rename a known reader', async () => {
  const e = env();
  await handle(post({ ...signup, first_name: 'Robin' }), e);
  await handle(post({ ...signup, first_name: 'Someone Else' }, { ip: '192.0.2.20' }), e);
  assert.deepEqual((await stored(e)).map(r => r.first_name), ['Robin']);
});

test('a plain HTML form is sent on to its thank-you page, which must be on the form\'s origins', async () => {
  const e = env();
  const form = { ...signup, redirect: 'https://example.com/thanks?from=footer' };
  const type = 'application/x-www-form-urlencoded';
  const res = await handle(post(form, { type }), e);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), 'https://example.com/thanks?from=footer');
  assert.equal((await stored(e)).length, 1);

  // A refusal goes back to the same page, with the reason.
  const bad = await handle(post({ ...form, email: 'nope' }, { type, ip: '192.0.2.30' }), e);
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.get('Location'), 'https://example.com/thanks?from=footer&error=invalid_email');

  // No open redirect: another site, a lookalike, a scheme trick or a relative path is refused.
  for (const redirect of ['https://evil.example/thanks', 'https://example.com.evil.example/', 'javascript:alert(1)', '//evil.example/', '/thanks']) {
    await refused(await handle(post({ ...form, email: 'other@example.com', redirect }, { type, ip: '192.0.2.31' }), e), 400, 'invalid_redirect');
  }
  assert.deepEqual((await stored(e)).map(r => r.email), ['reader@example.com']);
});

test('a broken FORM_KEYS secret closes the server form and is never logged', async () => {
  const e = env();
  e.FORM_KEYS = `{"example-server": "${key}"`;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try {
    await refused(await handle(post(signup, { origin: null, key }), e), 503, 'signup_unavailable');
  } finally {
    console.error = original;
  }
  assert.ok(logged.length > 0);
  assert.ok(logged.every(line => !line.includes(key.slice(0, 16))), 'no part of the key in the log');
  assert.deepEqual(await stored(e), []);
});

test('a key shorter than 32 characters is never accepted', async () => {
  const e = env();
  e.FORM_KEYS = JSON.stringify({ 'example-server': 'short' });
  const original = console.error;
  console.error = () => {};
  try {
    await refused(await handle(post(signup, { origin: null, key: 'short' }), e), 401, 'invalid_key');
  } finally {
    console.error = original;
  }
});

test('Sourceful\'s config: the website form posts from its server with a key, for The Source only', async () => {
  const e = env();
  e.CONFIG = JSON.parse(readFileSync(new URL('../config/sourceful.json', import.meta.url), 'utf8'));
  e.FORM_KEYS = JSON.stringify({ 'sourceful-web': key });
  const body = { email: 'reader@example.com', list: 'the-source', consent: 'the-source-2026-11' };
  await refused(await handle(post(body, { origin: 'https://www.sourceful.energy' }), e), 401, 'key_required');
  await refused(await handle(post({ ...body, list: 'ftw-news', consent: 'news-2026-10-30' }, { origin: null, key }), e), 400, 'invalid_list');
  assert.equal((await handle(post(body, { origin: null, key }), e)).status, 200);
  assert.deepEqual((await stored(e)).map(r => [r.email, r.list, r.consent, r.source]), [['reader@example.com', 'the-source', 'the-source-2026-11', 'sourceful-web']]);
});

test('the rate limit counts an IPv6 client per /64 and an IPv4 client per address', async () => {
  const { clientKey } = await import('../src/signup.ts');
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('2001:db8:0:0:ffff::2'), clientKey('2001:0db8:0000:0000:1:2:3:4'));
  assert.equal(clientKey('2001:db8:aaaa:bbbb::1'), '2001:db8:aaaa:bbbb::/64');
});

test('a first name that is not plainly a name is dropped, and the sign-up still counts', async () => {
  const e = env();
  for (const first_name of ['Visit https://spam.example', 'Call 0701234567', 'x'.repeat(61)]) {
    const res = await handle(post({ ...signup, first_name }), e);
    assert.equal(res.status, 200, first_name);
  }
  const names = await e.DB.prepare('SELECT first_name FROM contacts').all();
  assert.deepEqual(names.results.map((r: Record<string, unknown>) => r.first_name), [null]);
});
