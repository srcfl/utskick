import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle } from '../src/app.ts';
import { runBatch } from '../src/send.ts';
import { admin, fakeSes, rows, testEnv } from './helpers.ts';

const issue20 = readFileSync(new URL('./fixtures/issue-20-the-source.html', import.meta.url), 'utf8');
let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

async function seed(env: ReturnType<typeof testEnv>, n = 5) {
  const contacts = Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.com`, firstName: i === 0 ? 'Anna' : '', consentedAt: '2024-01-01T00:00:00Z' }));
  const res = await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp-the-source', contacts, suppressions: [] }), env);
  assert.equal(res.status, 200);
}

const issue = { key: 'the-source-20', list: 'the-source', kind: 'live', subject: 'The Source #20: We are live', html: issue20 };

async function create(env: ReturnType<typeof testEnv>, body: Record<string, unknown> = issue) {
  const res = await handle(admin('/admin/sends', body), env);
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function batch(env: ReturnType<typeof testEnv>, key: string, max = 10) {
  const res = await handle(admin(`/admin/sends/${key}/batch`, { max }), env);
  assert.equal(res.status, 200);
  return res.json() as Promise<Record<string, number>>;
}

test('dry run reports the audience and writes nothing', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 5);
  const { status, body } = await create(env, { ...issue, dryRun: true });
  assert.equal(status, 200);
  assert.equal(body.recipients, 5);
  assert.equal(body.links.length, 9);
  assert.match(body.sample.html, /Hi Anna,/);
  assert.match(body.sample.headers['List-Unsubscribe'], /^<https:\/\/news\.test\/u\/[0-9a-f]{32}>$/);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM sends'))[0].n, 0);
  assert.equal(ses.outbox.length, 0);
});

test('a send goes once to each subscriber, with one-click unsubscribe headers', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 5);
  const created = await create(env);
  assert.equal(created.status, 200);
  assert.equal(created.body.recipients, 5);
  assert.deepEqual(await batch(env, 'the-source-20', 3), { sent: 3, skipped: 0, failed: 0, retry: 0, pending: 2, unknown: 0, sending: 0 });
  assert.deepEqual(await batch(env, 'the-source-20', 3), { sent: 2, skipped: 0, failed: 0, retry: 0, pending: 0, unknown: 0, sending: 0 });
  assert.deepEqual(await batch(env, 'the-source-20', 3), { sent: 0, skipped: 0, failed: 0, retry: 0, pending: 0, unknown: 0, sending: 0 });
  assert.deepEqual(ses.outbox.map(m => m.Destination.ToAddresses[0]).sort(), ['p0@example.com', 'p1@example.com', 'p2@example.com', 'p3@example.com', 'p4@example.com']);

  const mail = ses.outbox.find(m => m.Destination.ToAddresses[0] === 'p0@example.com')!;
  const headers = Object.fromEntries(mail.Content.Simple.Headers.map(h => [h.Name, h.Value]));
  const token = (await rows(env, `SELECT d.token FROM deliveries d JOIN contacts c ON c.id = d.contact_id WHERE c.email = 'p0@example.com'`))[0].token;
  assert.equal(headers['List-Unsubscribe'], `<https://news.test/u/${token}>`);
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(mail.Content.Simple.Subject.Data, 'The Source #20: We are live');
  assert.match(mail.Content.Simple.Body.Html.Data, /Hi Anna,/);
  assert.match(mail.Content.Simple.Body.Html.Data, new RegExp(`href="https://news.test/u/${token}"`));
  assert.match(mail.Content.Simple.Body.Html.Data, new RegExp(`src="https://news.test/o/${token}.gif"`));
  assert.match(mail.Content.Simple.Body.Text.Data, /Hi Anna,/);
  assert.match(ses.outbox.find(m => m.Destination.ToAddresses[0] === 'p1@example.com')!.Content.Simple.Body.Html.Data, /Hi 👋,/, 'no first name: what Mailchimp showed');
  assert.deepEqual(mail.EmailTags, [{ Name: 'send', Value: 'the-source-20' }]);
});

test('creating the same send again is a no-op, and other content under the same key is refused', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 3);
  await create(env);
  await batch(env, 'the-source-20', 2);
  const again = await create(env);
  assert.equal(again.status, 200);
  assert.equal(again.body.recipients, 3);
  assert.equal(again.body.existing, true);
  const other = await create(env, { ...issue, subject: 'Something else' });
  assert.equal(other.status, 409);
  await batch(env, 'the-source-20', 10);
  assert.equal(ses.outbox.length, 3);
});

test('an interrupted send resumes without duplicates; a row stuck mid-send is left for a person to decide', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 4);
  await create(env);
  // The Worker died after SES took this one but before D1 heard back.
  await env.DB.prepare(`UPDATE deliveries SET status = 'sending', claimed_at = '2026-11-02T10:00:00Z' WHERE id = (SELECT MIN(id) FROM deliveries)`).run();
  const result = await runBatch(env, 'the-source-20', 10, new Date('2026-11-02T10:30:00Z'));
  assert.deepEqual(result, { sent: 3, skipped: 0, failed: 0, retry: 0, pending: 0, unknown: 1, sending: 0 });
  assert.equal(ses.outbox.length, 3);
  const retried = await handle(admin('/admin/sends/the-source-20/retry-unknown', {}), env);
  assert.deepEqual(await retried.json(), { requeued: 1 });
  await batch(env, 'the-source-20');
  assert.equal(ses.outbox.length, 4);
});

test('throttling puts the row back; a rejected address is marked failed', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 2);
  await create(env);
  ses.fail.push(429, { status: 400, type: 'MessageRejected' });
  assert.deepEqual(await batch(env, 'the-source-20', 2), { sent: 0, skipped: 0, failed: 1, retry: 1, pending: 1, unknown: 0, sending: 0 });
  assert.deepEqual(await batch(env, 'the-source-20', 2), { sent: 1, skipped: 0, failed: 0, retry: 0, pending: 0, unknown: 0, sending: 0 });
  assert.equal(ses.outbox.length, 1);
});

test('someone who leaves or bounces after the send was created is skipped', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 3);
  await create(env);
  await env.DB.prepare(`DELETE FROM subscriptions WHERE contact_id = (SELECT id FROM contacts WHERE email = 'p1@example.com')`).run();
  assert.deepEqual(await batch(env, 'the-source-20'), { sent: 2, skipped: 1, failed: 0, retry: 0, pending: 0, unknown: 0, sending: 0 });
});

test('FTW mail counts clicks but has no open pixel', async () => {
  ses = fakeSes();
  const env = testEnv();
  await handle(admin('/admin/import', { list: 'ftw-news', source: 'ftw-web', consent: 'news-2026-10-30', contacts: [{ email: 'a@example.com' }], suppressions: [] }), env);
  await create(env, { key: 'ftw-news-1', list: 'ftw-news', kind: 'live', subject: 'FTW', html: '<html><body><a href="https://ftw.sourceful.energy">FTW</a></body></html>' });
  await batch(env, 'ftw-news-1');
  const html = ses.outbox[0].Content.Simple.Body.Html.Data;
  assert.match(html, /href="https:\/\/news\.test\/c\/[0-9a-f]{32}\/0"/);
  assert.doesNotMatch(html, /\/o\//);
  assert.equal(ses.outbox[0].FromEmailAddress, 'FTW <ftw@news.test>');
});

test('a test send goes only to the test address, marked as a test', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 3);
  const { body } = await create(env, { ...issue, key: 'the-source-20-test-1', kind: 'test', testTo: [{ email: 'Editor@Example.com', firstName: 'Fredrik' }] });
  assert.equal(body.recipients, 1);
  await batch(env, 'the-source-20-test-1');
  assert.equal(ses.outbox.length, 1);
  assert.deepEqual(ses.outbox[0].Destination.ToAddresses, ['editor@example.com']);
  assert.equal(ses.outbox[0].Content.Simple.Subject.Data, '[Test] The Source #20: We are live');
  assert.match(ses.outbox[0].Content.Simple.Body.Html.Data, /Hi Fredrik,/);
});

test('a resend goes to those who did not open, and not before the wait is over', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 4);
  await create(env);
  await runBatch(env, 'the-source-20', 10, new Date('2026-11-05T14:00:00Z'));
  const [opened, bounced] = await rows(env, `SELECT d.id FROM deliveries d ORDER BY d.id LIMIT 2`);
  await env.DB.prepare(`INSERT INTO events (delivery_id, type) VALUES (?, 'open')`).bind(opened.id).run();
  await env.DB.prepare(`INSERT INTO events (delivery_id, type) VALUES (?, 'soft-bounce')`).bind(bounced.id).run();
  const resend = { key: 'the-source-20-resend', list: 'the-source', kind: 'resend', parent: 'the-source-20', afterDays: 3, subject: 'In case you missed it: The Source #20', html: issue20 };
  const early = await handle(admin('/admin/sends', { ...resend, now: '2026-11-07T14:00:00Z' }), env);
  assert.equal(early.status, 409);
  const { status, body } = await create(env, { ...resend, now: '2026-11-08T14:00:01Z' });
  assert.equal(status, 200);
  assert.equal(body.recipients, 2, 'the opener and the bounce are left out');
  await batch(env, 'the-source-20-resend');
  assert.equal(ses.outbox.length, 6);
});

// review: a bad or rotated key (403) or paused sending (400) was taken as a refusal of one address,
// so the CLI kept going until every row on the list was failed.
test('an account-level SES error puts the rows back, stops the batch and says why', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 20);
  await create(env);
  for (const type of ['AccessDeniedException', 'SendingPausedException', 'AccountSuspendedException', 'MailFromDomainNotVerifiedException', 'NotFoundException', '']) {
    const status = type === 'AccessDeniedException' ? 403 : type === 'NotFoundException' ? 404 : 400;
    ses.fail.push(...Array(14).fill(type ? { status, type } : status));
    const res = await handle(admin('/admin/sends/the-source-20/batch', { max: 14 }), env);
    assert.equal(res.status, 502);
    const { error } = await res.json() as { error: string };
    assert.match(error, new RegExp(`^ses_account_error: ${type.replace(/Exception$/, '') || 'HTTP'} ${status}`));
    assert.deepEqual(await rows(env, `SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status`), [{ status: 'pending', n: 20 }]);
    ses.fail.length = 0;
  }
  assert.equal(ses.outbox.length, 0);
  // Fixed: the same send carries on with everyone.
  await batch(env, 'the-source-20', 20);
  assert.equal(ses.outbox.length, 20);
});

test('a refused address is failed with the error type and status, never SES\'s text', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 3);
  await create(env);
  ses.fail.push({ status: 400, type: 'MessageRejected' }, { status: 400, type: 'BadRequestException' });
  assert.deepEqual(await batch(env, 'the-source-20'), { sent: 1, skipped: 0, failed: 2, retry: 0, pending: 0, unknown: 0, sending: 0 });
  assert.deepEqual((await rows(env, `SELECT error FROM deliveries WHERE status = 'failed' ORDER BY error`)).map(r => r.error), ['BadRequest 400', 'MessageRejected 400']);
});

// "Rather none than two": SES may have taken a mail it answered with a 5xx, or whose answer was lost.
test('a network error or a 5xx marks the row unknown, never pending', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 4);
  await create(env);
  ses.fail.push('network', 500, { status: 503, type: 'ServiceUnavailable' });
  assert.deepEqual(await batch(env, 'the-source-20'), { sent: 1, skipped: 0, failed: 0, retry: 0, pending: 0, unknown: 3, sending: 0 });
  assert.deepEqual((await rows(env, `SELECT error FROM deliveries WHERE status = 'unknown' ORDER BY error`)).map(r => r.error), ['HTTP 500', 'ServiceUnavailable 503', 'network']);
  await batch(env, 'the-source-20');
  assert.equal(ses.outbox.length, 1, 'nothing is sent again by itself');
});

test('retry-failed sends the failed rows again, once the cause is fixed', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 2);
  await create(env);
  ses.fail.push({ status: 400, type: 'MessageRejected' }, { status: 400, type: 'MessageRejected' });
  await batch(env, 'the-source-20');
  const res = await handle(admin('/admin/sends/the-source-20/retry-failed', {}), env);
  assert.deepEqual(await res.json(), { requeued: 2 });
  assert.deepEqual(await batch(env, 'the-source-20'), { sent: 2, skipped: 0, failed: 0, retry: 0, pending: 0, unknown: 0, sending: 0 });
  assert.deepEqual(await rows(env, `SELECT DISTINCT status, error FROM deliveries`), [{ status: 'sent', error: null }]);
});

// review: rows a killed batch left in sending were not reported, so a resume ended in silence.
test('rows still in sending are counted', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 5);
  await create(env);
  await env.DB.prepare(`UPDATE deliveries SET status = 'sending', claimed_at = '2026-11-02T10:00:00Z' WHERE id IN (SELECT id FROM deliveries LIMIT 3)`).run();
  assert.deepEqual(await runBatch(env, 'the-source-20', 14, new Date('2026-11-02T10:01:00Z')), { sent: 2, skipped: 0, failed: 0, retry: 0, pending: 0, unknown: 0, sending: 3 });
});

// review: `--test anna@… --fname You` overwrote Anna's stored name, and stored a bounced address again.
test('a test send changes no contact, and its first name is for the test mail only', async () => {
  ses = fakeSes();
  const env = testEnv();
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'c', contacts: [{ email: 'anna@example.com', firstName: 'Anna' }],
    suppressions: [{ email: 'gone@example.com', reason: 'mailchimp-cleaned', at: null }] }), env);
  const html = '<p>Hi *|FNAME|*</p><a href="*|UNSUB|*">u</a>';
  const { body } = await create(env, { key: 'k-test-1', list: 'the-source', kind: 'test', subject: 'S', html, testTo: [{ email: 'anna@example.com', firstName: 'You' }, { email: 'gone@example.com', firstName: 'You' }, { email: 'new@example.com', firstName: 'You' }] });
  assert.equal(body.recipients, 2);
  assert.deepEqual(await rows(env, `SELECT email, first_name FROM contacts ORDER BY email`), [{ email: 'anna@example.com', first_name: 'Anna' }, { email: 'new@example.com', first_name: null }]);
  await batch(env, 'k-test-1');
  assert.deepEqual(ses.outbox.map(m => m.Content.Simple.Body.Text.Data.split('\n')[0]), ['Hi You', 'Hi You']);
  await create(env, { key: 'k-live-1', list: 'the-source', kind: 'live', subject: 'S', html });
  await batch(env, 'k-live-1');
  assert.equal(ses.outbox[2].Content.Simple.Body.Text.Data.split('\n')[0], 'Hi Anna');
});

test('a subject with a line break or another control character is refused', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 1);
  for (const subject of ['Hi\r\nBcc: someone@example.com', 'Hi\nthere', 'Tab\there', 'Nul\u0000', 'C1\u0085']) {
    const { status, body } = await create(env, { ...issue, subject });
    assert.equal(status, 400, JSON.stringify(subject));
    assert.equal(body.error, 'invalid_subject');
  }
});

test('List-Id leaves out a list name that is not plain ASCII', async () => {
  ses = fakeSes();
  const env = testEnv();
  env.CONFIG = { ...env.CONFIG, lists: { ...env.CONFIG.lists, 'ftw-box': { ...env.CONFIG.lists['ftw-box'], name: 'Väntelistan för FTW' } } };
  const listId = (key: string) => ses.outbox.find(m => m.EmailTags?.[0].Value === key)!.Content.Simple.Headers.find(h => h.Name === 'List-Id')!.Value;
  for (const list of ['ftw-news', 'ftw-box']) {
    await handle(admin('/admin/import', { list, source: 's', consent: 'c', contacts: [{ email: 'a@example.com' }], suppressions: [] }), env);
    await create(env, { key: list, list, kind: 'live', subject: 'S', html: '<p>x</p>' });
    await batch(env, list);
  }
  assert.equal(listId('ftw-news'), 'FTW news <ftw-news.news.test>');
  assert.equal(listId('ftw-box'), '<ftw-box.news.test>');
});

// Without the pixel, "did not open" is everyone, so a resend would mail the whole list again.
test('a resend is refused for a list without the open pixel', async () => {
  ses = fakeSes();
  const env = testEnv();
  await handle(admin('/admin/import', { list: 'ftw-news', source: 's', consent: 'c', contacts: [{ email: 'a@example.com' }], suppressions: [] }), env);
  await create(env, { key: 'ftw-news-1', list: 'ftw-news', kind: 'live', subject: 'FTW', html: '<p>x</p>' });
  await runBatch(env, 'ftw-news-1', 10, new Date('2026-11-01T10:00:00Z'));
  for (const dryRun of [true, false]) {
    const { status, body } = await create(env, { key: 'ftw-news-1-resend', list: 'ftw-news', kind: 'resend', parent: 'ftw-news-1', subject: 'Again', html: '<p>x</p>', dryRun, now: '2026-11-08T10:00:00Z' });
    assert.equal(status, 400);
    assert.match(body.error, /^resend_needs_opens/);
  }
});
