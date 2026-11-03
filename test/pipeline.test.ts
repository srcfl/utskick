// What must hold for the first live send: no mail twice, a send that stops when SES refuses the
// sender rather than the readers, and no mail to a list without a way off it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import { escapeHtml, render } from '../src/render.ts';
import { runBatch } from '../src/send.ts';
import { normalizeEmail } from '../src/util.ts';
import { admin, fakeSes, rows, testEnv } from './helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

const html = '<html><body><p>Hi *|FNAME|*</p><a href="https://example.com/x">x</a><a href="*|UNSUB|*">Unsubscribe</a></body></html>';

async function listOf(n: number) {
  ses = fakeSes();
  const env = testEnv();
  const contacts = Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.com`, consentedAt: '2024-01-01T00:00:00Z' }));
  await handle(admin('/admin/import', { list: 'the-source', source: 'test', consent: 'c', contacts, suppressions: [] }), env);
  return env;
}

async function create(env: ReturnType<typeof testEnv>, body: Record<string, unknown>) {
  const res = await handle(admin('/admin/sends', { list: 'the-source', kind: 'live', subject: 'S', ...body }), env);
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const statuses = async (env: ReturnType<typeof testEnv>) =>
  Object.fromEntries((await rows(env, 'SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status')).map(r => [r.status, r.n]));

test('a mail to a list needs a link to *|UNSUB|*, not just the tag; a test may go without', async () => {
  const env = await listOf(2);
  for (const bad of ['<p>Hi</p>', '<p>Hi</p><!-- <a href="*|UNSUB|*">u</a> -->', '<p>Leave: *|UNSUB|*</p>']) {
    const r = await create(env, { key: 'k-1', html: bad });
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, /^no_unsubscribe_link/);
  }
  const t = await create(env, { key: 'k-test', kind: 'test', html: '<p>Hi</p>', testTo: [{ email: 'me@example.com' }] });
  assert.equal(t.status, 200);
});

test('the dry run warns of merge tags left in the mail and of a mail Gmail would cut', async () => {
  const env = await listOf(1);
  const r = await create(env, { key: 'k-1', html: html.replace('</body>', `<p>*|MC:SUBJECT|* *|LNAME|*</p>${'<p>padding</p>'.repeat(9000)}</body>`), dryRun: true });
  assert.equal(r.status, 200);
  assert.ok(r.body.bytes > 100 * 1024);
  assert.equal(r.body.warnings.length, 2);
  assert.match(r.body.warnings[0], /\*\|MC:SUBJECT\|\*, \*\|LNAME\|\*/);
  assert.match(r.body.warnings[1], /Gmail cuts/);
  assert.deepEqual((await create(env, { key: 'k-2', html, dryRun: true })).body.warnings, []);
});

test('when SES refuses every mail of a batch the same way, the send stops with the rows back in line', async () => {
  const env = await listOf(5);
  await create(env, { key: 'k-1', html });
  ses.fail.push(...Array(5).fill({ status: 400, type: 'BadRequest' }));
  const res = await handle(admin('/admin/sends/k-1/batch', { max: 10 }), env);
  assert.equal(res.status, 502);
  assert.match((await res.json() as { error: string }).error, /^ses_account_error: BadRequest for every mail in a batch/);
  assert.deepEqual(await statuses(env), { pending: 5 });
  // Fixed: the send goes on.
  assert.deepEqual(await (await handle(admin('/admin/sends/k-1/batch', { max: 10 }), env)).json(), { sent: 5, skipped: 0, failed: 0, retry: 0, pending: 0, unknown: 0, sending: 0 });
});

test('one address SES refuses fails alone, and the rest go out', async () => {
  const env = await listOf(4);
  await create(env, { key: 'k-1', html });
  ses.fail.push({ status: 400, type: 'MessageRejected' });
  const r = await (await handle(admin('/admin/sends/k-1/batch', { max: 10 }), env)).json() as Record<string, number>;
  assert.deepEqual([r.sent, r.failed], [3, 1]);
});

test('the sandbox, an unknown sender and a spent daily quota stop the send at once', async () => {
  for (const [type, message] of [['MessageRejected', 'Email address is not verified. The following identities failed the check: p0@example.com'], ['Throttling', 'Daily message quota exceeded.']]) {
    const env = await listOf(2);
    await create(env, { key: 'k-1', html });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ message }, { status: 400, headers: { 'x-amzn-ErrorType': type } })) as typeof fetch;
    try {
      const res = await handle(admin('/admin/sends/k-1/batch', { max: 10 }), env);
      assert.equal(res.status, 502, type);
      assert.doesNotMatch(JSON.stringify(await res.json()), /@/, 'SES\'s text, which names the reader, is not passed on');
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(await statuses(env), { pending: 2 }, type);
    assert.doesNotMatch(JSON.stringify(await rows(env, 'SELECT error FROM deliveries')), /@/);
  }
});

test('the Worker\'s own limit on outgoing requests stops the send, with the rows not yet sent back in line', async () => {
  const env = await listOf(3);
  await create(env, { key: 'k-1', html });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Too many subrequests.'); }) as typeof fetch;
  try {
    assert.equal((await handle(admin('/admin/sends/k-1/batch', { max: 10 }), env)).status, 502);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(await statuses(env), { pending: 3 });
});

test('each row is settled as SES answers: a settle that fails leaves that one row, not the batch', async t => {
  const env = await listOf(4);
  await create(env, { key: 'k-1', html });
  const [target] = (await rows(env, 'SELECT id FROM deliveries ORDER BY id DESC LIMIT 1')).map(r => r.id);
  const prepare = env.DB.prepare;
  env.DB.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes("status = 'sent', message_id")) return statement;
    return { ...statement, bind: (...p: (string | number | null)[]) => {
      const bound = statement.bind(...p);
      return { ...bound, run: async () => { if (p[2] === target) throw new Error('D1_ERROR: Network connection lost.'); return bound.run(); } };
    } };
  }) as typeof env.DB.prepare;
  const logged = t.mock.method(console, 'error', () => {});
  const r = await runBatch(env, 'k-1', 10);
  assert.equal(r.sent, 4);
  assert.deepEqual(await statuses(env), { sending: 1, sent: 3 });
  assert.equal(logged.mock.callCount(), 1);
  assert.doesNotMatch(String(logged.mock.calls[0].arguments[0]), /@/);
});

test('a second resend of an issue reaches nobody the first resend reached', async () => {
  const env = await listOf(3);
  await create(env, { key: 'k-1', html });
  await runBatch(env, 'k-1', 10, new Date('2026-11-01T10:00:00Z'));
  const resend = (key: string) => create(env, { key, kind: 'resend', parent: 'k-1', html, subject: 'Again', now: '2026-11-08T10:00:00Z' });
  assert.equal((await resend('k-1-resend')).body.recipients, 3);
  assert.equal((await resend('k-1-resend-2')).body.recipients, 0);
});

test('a name with $ patterns in it lands in the greeting as it is', () => {
  for (const name of ['Al$`', "Bob$'", 'Cy$&']) {
    const out = render('<p>Hi *|FNAME|*!</p><a href="*|UNSUB|*">u</a>', { firstName: name, fallback: 'there', unsubscribeUrl: 'U', archiveUrl: 'A' });
    assert.equal(out, `<p>Hi ${escapeHtml(name)}!</p><a href="U">u</a>`);
  }
});

test('an address with control or invisible characters, or a trailing dot, is not an address', () => {
  for (const bad of ['vic\u0001tim@example.com', 'vic​tim@example.com', 'victim@example.com.', 'a\u007f@example.com']) assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  assert.equal(normalizeEmail(' Anna@Example.COM '), 'anna@example.com');
});

test('a short admin token works only on a local Worker', async () => {
  const env = testEnv();
  assert.equal((await handle(admin('/admin/sends/x'), env)).status, 404, 'news.test is local, so the test token is fine');
  const live = { ...env, PUBLIC_URL: 'https://news.example.com' };
  assert.equal((await handle(admin('/admin/sends/x'), live)).status, 503);
  const long = { ...live, ADMIN_TOKEN: 'x'.repeat(40) };
  const res = await handle(new Request('https://news.example.com/admin/sends/x', { headers: { Authorization: `Bearer ${'x'.repeat(40)}` } }), long);
  assert.equal(res.status, 404);
});

// review: content SES will never take must not stop the send, and the sends after it, for ever.
test('a batch SES refuses the same way twice stays failed, and the send goes on', async () => {
  const env = await listOf(4);
  await create(env, { key: 'k-1', html });
  ses.fail.push(...Array(4).fill({ status: 400, type: 'MessageRejected' }));
  assert.equal((await handle(admin('/admin/sends/k-1/batch', { max: 10 }), env)).status, 502);
  assert.deepEqual(await statuses(env), { pending: 4 });
  ses.fail.push(...Array(4).fill({ status: 400, type: 'MessageRejected' }));
  const second = await handle(admin('/admin/sends/k-1/batch', { max: 10 }), env);
  assert.equal(second.status, 200);
  assert.deepEqual(await statuses(env), { failed: 4 });
});

test('one token cannot fill the events table, whatever the clicks turn into', async () => {
  const env = await listOf(1);
  await create(env, { key: 'k-1', html: html.replace('</body>', '<a href="https://example.com/y">y</a><a href="https://example.com/z">z</a></body>') });
  await runBatch(env, 'k-1', 10);
  const [d] = await rows(env, 'SELECT token FROM deliveries');
  const ua = { 'User-Agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15' };
  for (let i = 0; i < 60; i++) await handle(new Request(`https://news.test/c/${d.token}/${i % 3}`, { headers: ua }), env);
  assert.ok((await rows(env, 'SELECT COUNT(*) AS n FROM events'))[0].n as number <= 30);
});
