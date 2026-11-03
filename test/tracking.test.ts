import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import { admin, aged, fakeSes, reader, rows, testEnv } from './helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

const html = `<html><body><p>Hi *|FNAME|*</p>
<a href="https://ftw.sourceful.energy">FTW</a>
<a href="https://sourceful.energy/master-plan?a=1&amp;b=2">Plan</a>
<a href="https://ftw.sourceful.energy">FTW again</a>
<a href="*|UNSUB|*">Unsubscribe</a></body></html>`;

async function sent() {
  ses = fakeSes();
  const env = testEnv();
  const contacts = ['a', 'b', 'c'].map(x => ({ email: `${x}@example.com`, consentedAt: '2024-01-01T00:00:00Z' }));
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp-the-source', contacts, suppressions: [] }), env);
  await handle(admin('/admin/sends', { key: 'the-source-22', list: 'the-source', kind: 'live', subject: 'The Source #22', html }), env);
  await handle(admin('/admin/sends/the-source-22/batch', { max: 10 }), env);
  await aged(env);
  const tokens = (await rows(env, 'SELECT token FROM deliveries ORDER BY id')).map(r => r.token as string);
  return { env, tokens };
}

const get = (path: string, method = 'GET') => reader(`https://news.test${path}`, method);

test('a click redirects to the link and is logged against it', async () => {
  const { env, tokens } = await sent();
  const res = await handle(get(`/c/${tokens[0]}/1`), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://sourceful.energy/master-plan?a=1&b=2');
  assert.deepEqual(await rows(env, 'SELECT type, link FROM events'), [{ type: 'click', link: 1 }]);
});

test('a link scanner HEAD request is redirected but not counted', async () => {
  const { env, tokens } = await sent();
  assert.equal((await handle(get(`/c/${tokens[0]}/0`, 'HEAD'), env)).status, 302);
  assert.deepEqual(await rows(env, 'SELECT * FROM events'), []);
});

test('a bad token or link number gets a 404', async () => {
  const { env, tokens } = await sent();
  assert.equal((await handle(get(`/c/${tokens[0]}/9`), env)).status, 404);
  assert.equal((await handle(get(`/c/${'f'.repeat(32)}/0`), env)).status, 404);
});

test('the open pixel is a GIF that is never cached', async () => {
  const { env, tokens } = await sent();
  const res = await handle(get(`/o/${tokens[2]}.gif`), env);
  assert.equal(res.headers.get('Content-Type'), 'image/gif');
  assert.match(res.headers.get('Cache-Control')!, /no-store/);
  assert.equal(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 6)), 'GIF89a');
  assert.deepEqual(await rows(env, 'SELECT type FROM events'), [{ type: 'open' }]);
});

test('stats count unique and total clicks per link, opens, and statuses', async () => {
  const { env, tokens } = await sent();
  await handle(get(`/c/${tokens[0]}/0`), env);
  await handle(get(`/c/${tokens[0]}/0`), env);
  await handle(get(`/c/${tokens[1]}/0`), env);
  await handle(get(`/c/${tokens[1]}/1`), env);
  await handle(get(`/o/${tokens[0]}.gif`), env);
  await handle(get(`/o/${tokens[0]}.gif`), env);
  const stats = await (await handle(admin('/admin/sends/the-source-22'), env)).json() as Record<string, any>;
  assert.equal(stats.recipients, 3);
  assert.deepEqual(stats.status, { sent: 3 });
  // Repeats within the hour count once (see the next test); the unique figures are what matter.
  assert.deepEqual(stats.opens, { unique: 1, total: 1, machine: 0, any: 1 });
  assert.deepEqual(stats.clicks, { unique: 2, total: 3, machine: 0, any: 2 });
  assert.deepEqual(stats.links, [
    { n: 0, url: 'https://ftw.sourceful.energy', unique: 2, total: 2, machine: 0, any: 2 },
    { n: 1, url: 'https://sourceful.energy/master-plan?a=1&b=2', unique: 1, total: 1, machine: 0, any: 1 },
  ]);
});

test('the web archive shows the issue without personal data or tracking', async () => {
  const { env } = await sent();
  const res = await handle(get('/a/the-source-22'), env);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /Hi 👋/);
  assert.match(page, /href="https:\/\/ftw\.sourceful\.energy"/);
  assert.doesNotMatch(page, /\/c\/|\/o\/|\/u\/[0-9a-f]{32}/);
});

test('test sends and unknown keys have no archive page', async () => {
  const { env } = await sent();
  await handle(admin('/admin/sends', { key: 'the-source-22-test-1', list: 'the-source', kind: 'test', subject: 'S', html, testTo: [{ email: 'me@example.com' }] }), env);
  await handle(admin('/admin/sends/the-source-22-test-1/batch', { max: 10 }), env);
  assert.equal((await handle(get('/a/the-source-22-test-1'), env)).status, 404);
  assert.equal((await handle(get('/a/nope'), env)).status, 404);
});

test('a loop on one token adds at most one open, one click per link and one unsubscribe an hour', async () => {
  const { env, tokens } = await sent();
  for (let i = 0; i < 50; i++) {
    await handle(get(`/o/${tokens[0]}.gif`), env);
    await handle(get(`/c/${tokens[0]}/0`), env);
    await handle(new Request(`https://news.test/u/${tokens[1]}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env);
  }
  assert.deepEqual(await rows(env, 'SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY type'), [
    { type: 'click', n: 1 }, { type: 'open', n: 1 }, { type: 'unsubscribe', n: 1 },
  ]);
  // An hour later the same reader counts again.
  await env.DB.prepare(`UPDATE events SET at = '2000-01-01T00:00:00Z'`).run();
  await handle(get(`/o/${tokens[0]}.gif`), env);
  assert.equal((await rows(env, `SELECT COUNT(*) AS n FROM events WHERE type = 'open'`))[0].n, 2);
});

test('the archive runs in a sandbox: no script on the admin origin', async () => {
  const { env } = await sent();
  const res = await handle(get('/a/the-source-22'), env);
  const csp = res.headers.get('Content-Security-Policy') ?? '';
  assert.match(csp, /(^|; )sandbox( |;)/);
  assert.doesNotMatch(csp, /allow-scripts|allow-same-origin|allow-forms/);
  assert.match(csp, /default-src 'none'/);
});

test('a click on a link with odd characters redirects to its encoded form', async () => {
  ses = fakeSes();
  const env = testEnv();
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp-the-source', contacts: [{ email: 'a@example.com' }], suppressions: [] }), env);
  await handle(admin('/admin/sends', { key: 'odd', list: 'the-source', kind: 'live', subject: 'S', html: '<a href="https://example.com/smörgås?q=a b">x</a><a href="*|UNSUB|*">u</a>' }), env);
  await handle(admin('/admin/sends/odd/batch', { max: 10 }), env);
  const [{ token }] = await rows<{ token: string }>(env, 'SELECT token FROM deliveries');
  const res = await handle(get(`/c/${token}/0`), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://example.com/sm%C3%B6rg%C3%A5s?q=a%20b');
});
