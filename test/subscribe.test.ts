import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import { firstName, subscribe } from '../src/contacts.ts';
import { normalizeEmail } from '../src/util.ts';
import { admin, rows, testEnv } from './helpers.ts';

// What the FTW site sends over the service binding after its own checks.
const signup = { email: 'Tinkerer@Example.com', list: 'ftw-news', country: 'SE', consent: 'news-2026-10-30', source: 'ftw-web' };

test('a form sign-up lands on its list with its consent, time and source', async () => {
  const env = testEnv();
  assert.deepEqual(await subscribe(env, signup, new Date('2026-11-02T12:00:00Z')), { ok: true });
  assert.deepEqual(await subscribe(env, { ...signup, list: 'ftw-box', consent: 'gateway-2026-10-30' }, new Date('2026-11-02T12:01:00Z')), { ok: true });
  const subs = await rows(env, `SELECT c.email, c.country, s.list, s.consent, s.consented_at, s.source FROM subscriptions s JOIN contacts c ON c.id = s.contact_id ORDER BY s.list`);
  assert.deepEqual(subs, [
    { email: 'tinkerer@example.com', country: 'SE', list: 'ftw-box', consent: 'gateway-2026-10-30', consented_at: '2026-11-02T12:01:00Z', source: 'ftw-web' },
    { email: 'tinkerer@example.com', country: 'SE', list: 'ftw-news', consent: 'news-2026-10-30', consented_at: '2026-11-02T12:00:00Z', source: 'ftw-web' },
  ]);
});

// Until sign-ups are confirmed by mail (double opt-in), a form cannot tell the person from someone
// who typed their address, so it may not undo what the person chose. Someone who left and wants back
// writes to support. This replaces the earlier rule that a new sign-up lifted "left this list".
test('signing up again after leaving does not lift the suppression', async () => {
  const env = testEnv();
  await subscribe(env, signup);
  const { hash } = (await rows<{ hash: string }>(env, 'SELECT email_hash AS hash FROM contacts'))[0];
  await env.DB.prepare(`INSERT INTO suppressions (email_hash, scope, reason) VALUES (?, 'ftw-news', 'unsubscribe')`).bind(hash).run();
  await env.DB.prepare('DELETE FROM subscriptions').run();
  assert.deepEqual(await subscribe(env, signup), { ok: true }, 'the same answer, so the form reveals nothing');
  assert.deepEqual(await rows(env, 'SELECT scope, reason FROM suppressions'), [{ scope: 'ftw-news', reason: 'unsubscribe' }]);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM subscriptions')).at(0)!.n, 0);
  // Leaving one list does not stop a sign-up for another.
  await subscribe(env, { ...signup, list: 'ftw-box', consent: 'gateway-2026-10-30' });
  assert.deepEqual(await rows(env, 'SELECT list FROM subscriptions'), [{ list: 'ftw-box' }]);
});

test('a bounced or complaining address is not signed up again', async () => {
  const env = testEnv();
  await subscribe(env, signup);
  const { hash } = (await rows<{ hash: string }>(env, 'SELECT email_hash AS hash FROM contacts'))[0];
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare('DELETE FROM subscriptions').run();
  await env.DB.prepare(`INSERT INTO suppressions (email_hash, scope, reason) VALUES (?, '*', 'complaint')`).bind(hash).run();
  assert.deepEqual(await subscribe(env, signup), { ok: true }, 'the same answer, so the form reveals nothing');
  assert.deepEqual(await rows(env, 'SELECT * FROM subscriptions'), []);
});

test('an unknown list or a bad address is refused', async () => {
  const env = testEnv();
  await assert.rejects(subscribe(env, { ...signup, list: 'spam' }), /invalid_list/);
  await assert.rejects(subscribe(env, { ...signup, email: 'nope' }), /invalid_email/);
});

// review: an unconfirmed sign-up rewrote the consent record and gave a nameless subscriber a "name"
// that then went into the greeting of every mail.
test('a sign-up for a known address changes neither the contact nor an existing subscription', async () => {
  const env = testEnv();
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp-the-source',
    contacts: [{ email: 'eva@example.com', consentedAt: '2021-03-04T10:15:00Z' }, { email: 'olle@example.com', firstName: 'Olle', consentedAt: '2021-03-04T10:15:00Z' }],
    suppressions: [{ email: 'left@example.com', reason: 'mailchimp-unsubscribed', at: '2025-01-01T00:00:00Z' }] }), env);
  await env.DB.prepare(`UPDATE contacts SET country = 'NO' WHERE email = 'olle@example.com'`).run();
  const before = await rows(env, 'SELECT * FROM contacts ORDER BY id');
  const subsBefore = await rows(env, 'SELECT * FROM subscriptions ORDER BY contact_id, list');
  const later = new Date('2026-11-03T09:00:00Z');
  for (const s of [
    { email: 'eva@example.com', firstName: 'Call 0701234567 to verify your account', country: 'SE' },
    { email: 'Olle@Example.com', firstName: 'Someone Else', country: 'SE' },
    { email: 'left@example.com', firstName: 'Left' },
  ]) assert.deepEqual(await subscribe(env, { ...s, list: 'the-source', consent: 'the-source-2026-11', source: 'web' }, later), { ok: true });
  assert.deepEqual(await rows(env, 'SELECT * FROM contacts ORDER BY id'), before);
  assert.deepEqual(await rows(env, 'SELECT * FROM subscriptions ORDER BY contact_id, list'), subsBefore);
  assert.deepEqual(await rows(env, 'SELECT scope, reason FROM suppressions'), [{ scope: 'the-source', reason: 'mailchimp-unsubscribed' }]);
  // A new list for a known contact is a new subscription; the contact still stays as it was.
  await subscribe(env, { email: 'olle@example.com', list: 'ftw-news', consent: 'news-1', firstName: 'X', country: 'SE', source: 'ftw-web' }, later);
  assert.deepEqual(await rows(env, 'SELECT * FROM contacts ORDER BY id'), before);
  assert.deepEqual(await rows(env, `SELECT list, consent, consented_at, source FROM subscriptions s JOIN contacts c ON c.id = s.contact_id WHERE c.email = 'olle@example.com' ORDER BY list`), [
    { list: 'ftw-news', consent: 'news-1', consented_at: '2026-11-03T09:00:00Z', source: 'ftw-web' },
    { list: 'the-source', consent: 'mailchimp-the-source', consented_at: '2021-03-04T10:15:00Z', source: 'mailchimp-import' },
  ]);
});

test('a first name is letters, spaces, hyphens and apostrophes, at most 40 characters; anything else is dropped', async () => {
  for (const ok of ['Anna', 'Anna-Lena', "O'Brien", 'D’Angelo', 'José María', 'Zoë', 'Åsa', 'Nguyễn', 'x'.repeat(40)]) assert.equal(firstName(ok), ok);
  for (const bad of ['Call 0701234567', '+46701234567', 'Visit https://spam.example', 'spam.example', 'www example com/x', 'a@b', '<b>Bo</b>', 'x'.repeat(41), '-', "'", 'Bo\nBcc']) {
    assert.equal(firstName(bad), null, bad);
  }
  const env = testEnv();
  await subscribe(env, { ...signup, firstName: 'Win 1000 kr at spam.example' });
  assert.deepEqual(await rows(env, 'SELECT email, first_name FROM contacts'), [{ email: 'tinkerer@example.com', first_name: null }]);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM subscriptions')).at(0)!.n, 1, 'the sign-up itself counts');
});

test('an address is stored in Unicode NFC, so two spellings of one address are one contact', async () => {
  const composed = 'jos\u00e9@example.com', decomposed = 'Jose\u0301@Example.com';
  assert.equal(normalizeEmail(decomposed), composed);
  const env = testEnv();
  await subscribe(env, { ...signup, email: composed });
  await subscribe(env, { ...signup, email: decomposed });
  assert.deepEqual(await rows(env, 'SELECT email FROM contacts'), [{ email: composed }]);
});
