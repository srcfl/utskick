import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import { admin, fakeSes, rows, testEnv } from './helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

// Two subscribers of The Source; anna is also on the FTW news list. One delivery each.
async function sentIssue() {
  ses = fakeSes();
  const env = testEnv();
  const contacts = [{ email: 'anna@example.com', consentedAt: '2024-01-01T00:00:00Z' }, { email: 'bo@example.com', consentedAt: '2024-01-01T00:00:00Z' }];
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp-the-source', contacts, suppressions: [] }), env);
  await handle(admin('/admin/import', { list: 'ftw-news', source: 'ftw-web', consent: 'news-2026-10-30', contacts: contacts.slice(0, 1), suppressions: [] }), env);
  await handle(admin('/admin/sends', { key: 'the-source-22', list: 'the-source', kind: 'live', subject: 'S', html: '<p>Hi *|FNAME|*</p><a href="*|UNSUB|*">Unsubscribe</a>' }), env);
  await handle(admin('/admin/sends/the-source-22/batch', { max: 10 }), env);
  const tokens = Object.fromEntries((await rows(env, `SELECT c.email, d.token FROM deliveries d JOIN contacts c ON c.id = d.contact_id`)).map(r => [r.email, r.token as string]));
  return { env, tokens };
}

// What Gmail and Apple Mail send for RFC 8058: a POST, no cookies, this exact body.
function oneClick(token: string) {
  return new Request(`https://news.test/u/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
}

test('opening the link shows a button and changes nothing, so link scanners cannot unsubscribe anyone', async () => {
  const { env, tokens } = await sentIssue();
  const res = await handle(new Request(`https://news.test/u/${tokens['bo@example.com']}`), env);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /<form method="post"/);
  assert.match(page, /The Source/);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM subscriptions')).at(0)!.n, 3);
});

test('one-click POST unsubscribes, deletes the address and suppresses it for that list', async () => {
  const { env, tokens } = await sentIssue();
  const res = await handle(oneClick(tokens['bo@example.com']), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await rows(env, `SELECT email FROM contacts WHERE email = 'bo@example.com'`), []);
  assert.deepEqual(await rows(env, `SELECT scope, reason FROM suppressions`), [{ scope: 'the-source', reason: 'unsubscribe' }]);
  assert.deepEqual(await rows(env, `SELECT type FROM events`), [{ type: 'unsubscribe' }]);
});

test('leaving The Source keeps the other lists', async () => {
  const { env, tokens } = await sentIssue();
  await handle(oneClick(tokens['anna@example.com']), env);
  const left = await rows(env, `SELECT s.list FROM subscriptions s JOIN contacts c ON c.id = s.contact_id WHERE c.email = 'anna@example.com'`);
  assert.deepEqual(left, [{ list: 'ftw-news' }]);
});

test('unsubscribing twice is fine', async () => {
  const { env, tokens } = await sentIssue();
  assert.equal((await handle(oneClick(tokens['bo@example.com']), env)).status, 200);
  assert.equal((await handle(oneClick(tokens['bo@example.com']), env)).status, 200);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM suppressions')).at(0)!.n, 1);
});

test('the footer form posts the same body and gets a page back', async () => {
  const { env, tokens } = await sentIssue();
  const res = await handle(oneClick(tokens['bo@example.com']), env);
  assert.match(res.headers.get('Content-Type')!, /text\/html/);
  assert.match(await res.text(), /unsubscribed/i);
});

test('an unsubscribed address gets no later issue, and an import cannot bring it back', async () => {
  const { env, tokens } = await sentIssue();
  await handle(oneClick(tokens['bo@example.com']), env);
  const reimport = await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp-the-source', contacts: [{ email: 'bo@example.com', consentedAt: '2024-01-01T00:00:00Z' }], suppressions: [] }), env);
  assert.equal((await reimport.json() as Record<string, number>).skipped, 1);
  const next = await handle(admin('/admin/sends', { key: 'the-source-23', list: 'the-source', kind: 'live', subject: 'S', html: '<p>x</p><a href="*|UNSUB|*">u</a>' }), env);
  assert.equal((await next.json() as Record<string, number>).recipients, 1);
});

test('an unknown token gets a 404 page', async () => {
  const { env } = await sentIssue();
  assert.equal((await handle(oneClick('0'.repeat(32)), env)).status, 404);
  assert.equal((await handle(new Request('https://news.test/u/not-a-token'), env)).status, 404);
});

test('the link in a test mail reaches the database but takes nobody off a list', async () => {
  const { env } = await sentIssue();
  await handle(admin('/admin/sends', { key: 'the-source-22-test-1', list: 'the-source', kind: 'test', subject: 'S', html: '<a href="*|UNSUB|*">U</a>', testTo: [{ email: 'bo@example.com' }] }), env);
  await handle(admin('/admin/sends/the-source-22-test-1/batch', { max: 10 }), env);
  const [{ token }] = await rows<{ token: string }>(env, `SELECT d.token FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.kind = 'test'`);
  const res = await handle(oneClick(token), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /test email/i);
  assert.deepEqual(await rows(env, 'SELECT * FROM suppressions'), []);
  assert.equal((await rows(env, `SELECT COUNT(*) AS n FROM contacts WHERE email = 'bo@example.com'`)).at(0)!.n, 1);
  assert.deepEqual(await rows(env, `SELECT type FROM events`), [{ type: 'unsubscribe' }]);
});
