import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { admin, fakeSes, rows, testConfig, testEnv } from './helpers.ts';
import { base, callTool, connect, rpc, token } from './oauth-helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

// Everyone at team.test is a member; admin@example.com approves. Admins get the approval link by mail.
const config: Config = {
  ...testConfig,
  members: ['@team.test', 'Guest@Partner.test'],
  approval: { notifyFrom: 'Utskick <utskick@news.test>' },
};

function env(c: Config = config) {
  const e = testEnv();
  e.CONFIG = c;
  return e;
}

const all = 'stats.read subscribers.read drafts.write test.send lists.write';
const html = '<html><body><p>Hi *|FNAME|*</p><a href="https://example.com/x">x</a><a href="*|UNSUB|*">Unsubscribe</a></body></html>';

async function seed(e: ReturnType<typeof env>, n: number) {
  const contacts = Array.from({ length: n }, (_, i) => ({ email: `reader${i}@example.com`, consentedAt: '2024-01-01T00:00:00Z' }));
  await handle(admin('/admin/import', { list: 'the-source', source: 'test', consent: 'test', contacts, suppressions: [] }), e);
}

test('a member connects an assistant, reads the dashboard, but cannot approve a send', async () => {
  ses = fakeSes();
  const e = env();
  for (const who of ['kim@team.test', 'guest@partner.test']) {
    e.DEV_IDENTITY = who;
    const c = await connect(e, { scope: all });
    assert.equal(c.scope, all, who);
    assert.equal((await handle(new Request(`${base}/dashboard`), e)).status, 200, `${who} reads the dashboard`);
  }
  for (const who of ['kim@team.test.evil.example', 'kim@sub.team.test', 'someone@partner.test']) {
    e.DEV_IDENTITY = who;
    assert.equal((await handle(new Request(`${base}/dashboard`), e)).status, 403, who);
  }

  e.DEV_IDENTITY = 'kim@team.test';
  await seed(e, 3);
  const c = await connect(e, { scope: all });
  const id = (await callTool(e, c.access, 'draft_save', { list: 'the-source', subject: 'Hello', html })).data.id;
  const r = await callTool(e, c.access, 'request_send', { draft: id, key: 'the-source-40' });
  assert.equal(r.error, null, r.error ?? '');
  assert.equal(r.data.mailedAdmins, 1);
  assert.equal(r.data.approveUrl, undefined, 'the assistant never holds the link when the admins get it by mail');
  assert.match(r.data.note, /admin got a mail/);
  // About 24 hours, the default.
  const hours = (Date.parse(r.data.expiresAt) - Date.now()) / 3600_000;
  assert.ok(hours > 23.9 && hours <= 24, String(hours));

  const [mail] = ses.outbox;
  assert.equal(mail.Destination.ToAddresses[0], 'admin@example.com');
  assert.equal(mail.FromEmailAddress, 'Utskick <utskick@news.test>');
  assert.equal(mail.Content.Simple.Subject.Data, 'Approve a send: Hello');
  const link = mail.Content.Simple.Body.Text.Data.match(/https:\/\/news\.test\/approve\/[A-Za-z0-9_-]{43}/)![0];
  assert.match(mail.Content.Simple.Body.Text.Data, /kim@team\.test asked, through Test Assistant/);
  assert.doesNotMatch(JSON.stringify(mail), /reader\d/);

  // The member who asked cannot approve it; an admin can.
  const post = (who: string) => {
    e.DEV_IDENTITY = who;
    return handle(new Request(link, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: 'decision=approve' }), e);
  };
  assert.equal((await post('kim@team.test')).status, 403);
  assert.equal((await post('admin@example.com')).status, 200);
  assert.deepEqual(await rows(e, `SELECT status, decided_by FROM approvals`), [{ status: 'approved', decided_by: 'admin@example.com' }]);
});

test('without notifyFrom the assistant gets the link, and approval.hours sets how long it lasts', async () => {
  ses = fakeSes();
  const e = env({ ...config, approval: { hours: 2 } });
  e.DEV_IDENTITY = 'kim@team.test';
  await seed(e, 2);
  const c = await connect(e, { scope: all });
  const id = (await callTool(e, c.access, 'draft_save', { list: 'the-source', subject: 'Hello', html })).data.id;
  const r = await callTool(e, c.access, 'request_send', { draft: id, key: 'the-source-41' });
  assert.match(r.data.approveUrl, /^https:\/\/news\.test\/approve\//);
  assert.match(r.data.note, /within 2 hours/);
  const hours = (Date.parse(r.data.expiresAt) - Date.now()) / 3600_000;
  assert.ok(hours > 1.9 && hours <= 2, String(hours));
  assert.equal(ses.outbox.length, 0);
});

test('a test goes to the person who connected the assistant, or the allowlist, and nowhere else', async () => {
  ses = fakeSes();
  const e = env();
  e.DEV_IDENTITY = 'kim@team.test';
  const c = await connect(e, { scope: all });
  const id = (await callTool(e, c.access, 'draft_save', { list: 'the-source', subject: 'Hello', html })).data.id;
  const mine = await callTool(e, c.access, 'test_send', { draft: id });
  assert.equal(mine.data.sent, 1);
  assert.deepEqual(ses.outbox.map(m => m.Destination.ToAddresses[0]), ['kim@team.test']);
  const refused = await callTool(e, c.access, 'test_send', { draft: id, to: ['lee@team.test'] });
  assert.match(refused.error!, /only to you/);
  const shared = await callTool(e, c.access, 'test_send', { draft: id, to: ['tester@example.com', 'kim@team.test'] });
  assert.equal(shared.data.sent, 2);
});

test('someone taken out of the config takes their assistants with them, and an admin can end them at once', async () => {
  ses = fakeSes();
  const e = env();
  e.DEV_IDENTITY = 'kim@team.test';
  const c = await connect(e, { scope: all });
  assert.equal((await callTool(e, c.access, 'subscriber_counts')).error, null);

  e.CONFIG = { ...config, members: [] };
  const refused = await rpc(e, c.access, 'tools/call', { name: 'subscriber_counts', arguments: {} });
  assert.equal(refused.status, 401);
  assert.match(refused.headers.get('WWW-Authenticate')!, /no longer a member/);
  const t = await token(e, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  assert.equal(t.status, 400);
  assert.match(t.body.error_description, /no longer a member/);

  // Back in the config, the grant works again; an admin's revoke by person ends it for good.
  e.CONFIG = config;
  assert.equal((await rpc(e, c.access, 'tools/call', { name: 'subscriber_counts', arguments: {} })).status, 200);
  const res = await handle(admin('/admin/oauth/revoke', { subject: 'Kim@Team.test' }), e);
  assert.deepEqual(await res.json(), { grants: 1 });
  assert.equal((await rpc(e, c.access, 'tools/call', { name: 'subscriber_counts', arguments: {} })).status, 401);
  assert.deepEqual(await rows(e, 'SELECT COUNT(*) AS n FROM oauth_grants'), [{ n: 0 }]);
});
