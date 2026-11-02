import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseCsv, readExport } from '../cli/mailchimp.ts';
import { handle } from '../src/app.ts';
import { importContacts, subscribe } from '../src/contacts.ts';
import { admin, rows, testEnv } from './helpers.ts';

const exportDir = fileURLToPath(new URL('./fixtures/mailchimp/', import.meta.url));

test('parses quoted CSV fields, doubled quotes, commas and a BOM', () => {
  const out = parseCsv('﻿"Email Address",Name\r\n"a@example.se","Carl ""CJ"", Jr"\r\nb@example.se,\n');
  assert.deepEqual(out, [{ 'Email Address': 'a@example.se', Name: 'Carl "CJ", Jr' }, { 'Email Address': 'b@example.se', Name: '' }]);
});

test('reads a Mailchimp export: subscribed with opt-in time, unsubscribed and cleaned as suppressions', () => {
  const { contacts, suppressions } = readExport(exportDir);
  assert.equal(contacts.length, 6);
  assert.deepEqual(contacts[0], { email: 'anna@example.com', firstName: 'Anna', lastName: 'Berg', consentedAt: '2021-03-04T10:15:00Z' });
  assert.equal(contacts[1].email, 'bo.ek@example.com');
  assert.equal(contacts[1].consentedAt, '2022-05-06T07:08:09Z');
  assert.equal(contacts[2].firstName, 'Carl "CJ"');
  assert.equal(contacts[2].consentedAt, '2023-07-08T09:10:11Z', 'falls back to LAST_CHANGED');
  assert.deepEqual(suppressions, [
    { email: 'gustav@example.com', reason: 'mailchimp-unsubscribed', at: '2025-09-10T13:20:00Z' },
    { email: 'fia@example.com', reason: 'mailchimp-unsubscribed', at: '2025-09-10T13:20:00Z' },
    { email: 'hugo@example.com', reason: 'mailchimp-cleaned', at: '2025-10-05T15:00:00Z' },
  ]);
});

async function importFixture(env: ReturnType<typeof testEnv>) {
  const { contacts, suppressions } = readExport(exportDir);
  const res = await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp-the-source', contacts, suppressions }), env);
  assert.equal(res.status, 200);
  return res.json() as Promise<Record<string, number>>;
}

test('import subscribes, and a suppression wins over a subscribed row', async () => {
  const env = testEnv();
  const result = await importFixture(env);
  assert.deepEqual(result, { subscribed: 5, already: 0, suppressed: 3, skipped: 1 });
  const subs = await rows(env, `SELECT c.email, s.consent, s.consented_at, s.source FROM subscriptions s JOIN contacts c ON c.id = s.contact_id ORDER BY c.email`);
  assert.deepEqual(subs.map(s => s.email), ['anna@example.com', 'bo.ek@example.com', 'carl@example.com', 'dana@example.com', 'erik@example.com']);
  assert.equal(subs[0].consent, 'mailchimp-the-source');
  assert.equal(subs[0].consented_at, '2021-03-04T10:15:00Z');
  assert.equal(subs[0].source, 'mailchimp-import');
  const supp = await rows(env, `SELECT scope, reason, created_at FROM suppressions ORDER BY reason, scope`);
  assert.deepEqual(supp, [
    { scope: '*', reason: 'mailchimp-cleaned', created_at: '2025-10-05T15:00:00Z' },
    { scope: 'the-source', reason: 'mailchimp-unsubscribed', created_at: '2025-09-10T13:20:00Z' },
    { scope: 'the-source', reason: 'mailchimp-unsubscribed', created_at: '2025-09-10T13:20:00Z' },
  ], 'cleaned is a bounce on every list; each keeps the time Mailchimp recorded');
  assert.deepEqual(await rows(env, `SELECT email FROM contacts WHERE email IN ('fia@example.com', 'gustav@example.com', 'hugo@example.com')`), [], 'suppressed addresses are not kept');
});

test('importing the same export twice changes nothing', async () => {
  const env = testEnv();
  await importFixture(env);
  assert.deepEqual(await importFixture(env), { subscribed: 0, already: 5, suppressed: 0, skipped: 1 });
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM subscriptions'))[0].n, 5);
});

test('admin routes need the token', async () => {
  const env = testEnv();
  const res = await handle(new Request('https://news.test/admin/import', { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 401);
  const wrong = await handle(new Request('https://news.test/admin/import', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' }), env);
  assert.equal(wrong.status, 401);
});

test('an old Mailchimp unsubscribe does not undo a newer sign-up on our own form', async () => {
  const env = testEnv();
  await subscribe(env, { email: 'gustav@example.com', list: 'the-source', consent: 'the-source-2026-11', source: 'sourceful-web' }, new Date('2026-11-03T09:00:00Z'));
  await importFixture(env);
  const subs = await rows(env, `SELECT s.source FROM subscriptions s JOIN contacts c ON c.id = s.contact_id WHERE c.email = 'gustav@example.com'`);
  assert.deepEqual(subs, [{ source: 'sourceful-web' }]);
  assert.equal((await rows(env, `SELECT COUNT(*) AS n FROM suppressions WHERE scope = 'the-source'`))[0].n, 1, 'only fia, who left and never came back');
});

// D1 allows 1,000 queries in one Worker invocation (a batch counts as one), and the CLI sends every
// unsubscribed and cleaned row of an export in one request.
test('a 5,000-row suppression import stays far under D1\'s query limit, and a newer form sign-up still wins', async () => {
  const env = testEnv();
  await subscribe(env, { email: 'u-4321@example.com', list: 'the-source', consent: 'the-source-2026-11', source: 'sourceful-web' }, new Date('2026-11-03T09:00:00Z'));
  await subscribe(env, { email: 'u-17@example.com', list: 'the-source', consent: 'the-source-2025', source: 'sourceful-web' }, new Date('2024-06-01T09:00:00Z'));
  let queries = 0;
  const db = env.DB;
  const count = (s: any): any => ({ bind: (...p: any[]) => count(s.bind(...p)), first: (...a: any[]) => { queries++; return s.first(...a); }, all: () => { queries++; return s.all(); }, run: () => { queries++; return s.run(); }, s });
  (env as any).DB = { prepare: (sql: string) => count(db.prepare(sql)), batch: (st: any[]) => { queries++; return db.batch(st.map(x => x.s)); } };
  const suppressions = Array.from({ length: 5000 }, (_, i) => ({ email: `u-${i}@example.com`, reason: i % 10 ? 'mailchimp-unsubscribed' as const : 'mailchimp-cleaned' as const, at: '2025-01-01T00:00:00Z' }));
  const result = await importContacts(env, { list: 'the-source', source: 'mailchimp-import', consent: 'c', contacts: [], suppressions });
  assert.ok(queries < 200, `${queries} queries`);
  assert.equal(result.suppressed, 4999);
  (env as any).DB = db;
  assert.equal((await rows(env, `SELECT COUNT(*) AS n FROM suppressions`))[0].n, 4999);
  assert.deepEqual(await rows(env, `SELECT c.email FROM subscriptions s JOIN contacts c ON c.id = s.contact_id`), [{ email: 'u-4321@example.com' }], 'u-17 signed up before leaving');
});
