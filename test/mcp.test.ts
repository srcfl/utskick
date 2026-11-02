import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import { cron, runApproved } from '../src/approvals.ts';
import { escapeHtml } from '../src/render.ts';
import { createSend } from '../src/send.ts';
import { iso } from '../src/util.ts';
import { admin, fakeSes, rows, testEnv } from './helpers.ts';
import { base, callTool, connect, resource, rpc } from './oauth-helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

const all = 'stats.read subscribers.read drafts.write test.send';

async function seed(env: ReturnType<typeof testEnv>, n: number, list = 'the-source') {
  const contacts = Array.from({ length: n }, (_, i) => ({ email: `reader${i}@example.com`, firstName: `Reader${i}`, consentedAt: '2024-01-01T00:00:00Z' }));
  assert.equal((await handle(admin('/admin/import', { list, source: 'test', consent: 'test', contacts, suppressions: [] }), env)).status, 200);
}

const issueHtml = '<html><body><p>Hi *|FNAME|*,</p><p><a href="https://sourceful.energy/news">Read more</a></p><p><a href="*|UNSUB|*">Unsubscribe</a></p></body></html>';

test('initialize and tools/list, as the initialize-based revisions ask', async () => {
  ses = fakeSes();
  const env = testEnv();
  const c = await connect(env, { scope: all });
  const init = await rpc(env, c.access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.body.result.serverInfo.name, 'utskick');
  assert.match(init.body.result.instructions, /approve/);
  const note = await handle(new Request(resource, {
    method: 'POST', headers: { Authorization: `Bearer ${c.access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }), env);
  assert.equal(note.status, 202);
  const list = await rpc(env, c.access, 'tools/list', {}, { 'MCP-Protocol-Version': '2025-06-18' });
  const tools = list.body.result.tools as Record<string, any>[];
  assert.deepEqual(tools.map(t => t.name).sort(), ['approval_status', 'draft_preview', 'draft_save', 'drafts_list', 'request_send', 'send_stats', 'sends_list', 'subscriber_counts', 'test_send']);
  const stats = tools.find(t => t.name === 'send_stats')!;
  assert.deepEqual(stats.securitySchemes, [{ type: 'oauth2', scopes: ['stats.read'] }]);
  assert.equal(stats.annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === 'request_send')!.annotations.readOnlyHint, false);
  const unknown = await rpc(env, c.access, 'tools/list', {}, { 'MCP-Protocol-Version': '1999-01-01' });
  assert.equal(unknown.status, 400);
});

test('the stateless 2026-07-28 revision: version and method mirrored in headers', async () => {
  ses = fakeSes();
  const env = testEnv();
  const c = await connect(env, { scope: all });
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  const ok = await rpc(env, c.access, 'tools/call', { name: 'subscriber_counts', arguments: {}, _meta: meta }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'subscriber_counts' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.result.resultType, 'complete');
  assert.equal(ok.body.result.isError, false);
  const mismatch = await rpc(env, c.access, 'tools/call', { name: 'subscriber_counts', arguments: {}, _meta: meta }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'sends_list' });
  assert.equal(mismatch.status, 400);
  const discover = await rpc(env, c.access, 'server/discover', { _meta: meta }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' });
  assert.ok(discover.body.result.supportedVersions.includes('2026-07-28'));
});

test('/mcp refuses GET, a foreign plain-http origin and a batch', async () => {
  ses = fakeSes();
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read' });
  const get = await handle(new Request(resource, { headers: { Authorization: `Bearer ${c.access}` } }), env);
  assert.equal(get.status, 405);
  const origin = await rpc(env, c.access, 'tools/list', undefined, { Origin: 'http://evil.example' });
  assert.equal(origin.status, 403);
  const batch = await handle(new Request(resource, { method: 'POST', headers: { Authorization: `Bearer ${c.access}`, 'Content-Type': 'application/json' }, body: '[{"jsonrpc":"2.0","id":1,"method":"ping"}]' }), env);
  assert.equal(batch.status, 400);
});

test('each tool needs its scope: a missing one is a 403 that asks for it, and is audited', async () => {
  ses = fakeSes();
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read' });
  const r = await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'S', markdown: 'Hello' });
  assert.equal(r.status, 403);
  assert.match(r.headers.get('WWW-Authenticate')!, /error="insufficient_scope"/);
  assert.match(r.headers.get('WWW-Authenticate')!, /scope="stats.read drafts.write"/);
  assert.equal(r.result.isError, true);
  for (const [tool, args] of [['test_send', { draft: 'd-x' }], ['subscriber_counts', {}], ['request_send', { draft: 'd-x' }]] as const) {
    assert.equal((await callTool(env, c.access, tool, args)).status, 403, tool);
  }
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM drafts'))[0].n, 0);
  const audit = await rows(env, `SELECT tool, scope, outcome, client_id, subject FROM audit_log ORDER BY id`);
  assert.deepEqual(audit[0], { tool: 'draft_save', scope: 'drafts.write', outcome: 'denied', client_id: c.clientId, subject: 'admin@example.com' });
  assert.equal(audit.length, 4);
});

test('stats.read: aggregate stats and clicks per link, never an address', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 3);
  await handle(admin('/admin/sends', { key: 'the-source-30', list: 'the-source', kind: 'live', subject: 'Issue 30', html: issueHtml }), env);
  await handle(admin('/admin/sends/the-source-30/batch', { max: 10 }), env);
  const [d] = await rows(env, 'SELECT token FROM deliveries LIMIT 1');
  await handle(new Request(`${base}/c/${d.token}/0`), env);
  const c = await connect(env, { scope: 'stats.read' });
  const list = await callTool(env, c.access, 'sends_list');
  assert.deepEqual(list.data.sends.map((s: any) => [s.key, s.recipients, s.sent]), [['the-source-30', 3, 3]]);
  const stats = await callTool(env, c.access, 'send_stats', { key: 'the-source-30' });
  assert.equal(stats.data.recipients, 3);
  assert.deepEqual(stats.data.links[0], { n: 0, url: 'https://sourceful.energy/news', unique: 1, total: 1 });
  const text = JSON.stringify(stats.result) + JSON.stringify(list.result);
  assert.doesNotMatch(text, /reader\d@example\.com/);
  assert.doesNotMatch(text, /@/);
  assert.equal((await callTool(env, c.access, 'send_stats', { key: 'no-such-send' })).error?.includes('no_such_send'), true);
});

test('subscribers.read: counts per list only', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 4);
  await seed(env, 2, 'ftw-news');
  await env.DB.prepare(`INSERT INTO suppressions (email_hash, scope, reason) SELECT email_hash, '*', 'bounce' FROM contacts WHERE email = 'reader0@example.com'`).run();
  const c = await connect(env, { scope: 'subscribers.read' });
  const r = await callTool(env, c.access, 'subscriber_counts');
  const byList = Object.fromEntries(r.data.lists.map((l: any) => [l.list, l]));
  assert.equal(byList['the-source'].subscribers, 4);
  assert.equal(byList['the-source'].mailable, 3);
  assert.equal(byList['ftw-news'].subscribers, 2);
  assert.equal(byList['ftw-box'].subscribers, 0);
  assert.doesNotMatch(JSON.stringify(r.result), /@/);
});

test('drafts.write: save Markdown or HTML, update, list and preview with a sample name', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 2);
  const c = await connect(env, { scope: 'drafts.write' });
  const saved = await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'Issue 31', markdown: '# Issue 31\n\nHi *|FNAME|*, read [the news](https://sourceful.energy/news).' });
  assert.equal(saved.error, null, saved.error ?? '');
  const id = saved.data.id;
  assert.match(id, /^d-[0-9a-f]{10}$/);
  assert.equal(saved.data.links, 1);
  const preview = await callTool(env, c.access, 'draft_preview', { id });
  assert.match(preview.data.html, /<h1[^>]*>Issue 31<\/h1>/);
  assert.match(preview.data.html, /Hi Alex,/);
  assert.match(preview.data.html, /href="https:\/\/sourceful\.energy\/news"/, 'no tracking in a preview');
  assert.equal(preview.data.subject, 'Issue 31');
  assert.doesNotMatch(JSON.stringify(preview.result), /reader\d@example\.com/);

  const updated = await callTool(env, c.access, 'draft_save', { id, list: 'the-source', subject: 'Issue 31, final', html: issueHtml });
  assert.equal(updated.data.id, id);
  const list = await callTool(env, c.access, 'drafts_list');
  assert.deepEqual(list.data.drafts.map((d: any) => [d.id, d.subject, d.format]), [[id, 'Issue 31, final', 'html']]);
  const bad = await callTool(env, c.access, 'draft_save', { list: 'no-such-list', subject: 'x', html: '<p>x</p>' });
  assert.match(bad.error!, /list/);
  const both = await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'x', html: '<p>x</p>', markdown: 'x' });
  assert.match(both.error!, /html or markdown/);
});

test('test.send: only to addresses on the allowlist, marked as a test', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 3);
  const c = await connect(env, { scope: 'drafts.write test.send' });
  const id = (await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'Issue 32', html: issueHtml })).data.id;
  const refused = await callTool(env, c.access, 'test_send', { draft: id, to: ['reader1@example.com'] });
  assert.match(refused.error!, /allowlist/);
  assert.equal(ses.outbox.length, 0);
  const one = await callTool(env, c.access, 'test_send', { draft: id, to: ['TESTER@example.com'] });
  assert.equal(one.error, null, one.error ?? '');
  assert.equal(one.data.sent, 1);
  assert.deepEqual(ses.outbox.map(m => m.Destination.ToAddresses[0]), ['tester@example.com']);
  assert.equal(ses.outbox[0].Content.Simple.Subject.Data, '[Test] Issue 32');
  const everyone = await callTool(env, c.access, 'test_send', { draft: id });
  assert.equal(everyone.data.sent, 2, 'no list: the whole allowlist');
  const [send] = await rows(env, `SELECT kind FROM sends ORDER BY id DESC LIMIT 1`);
  assert.equal(send.kind, 'test');

  await handle(admin('/admin/sends', { key: 'the-source-29', list: 'the-source', kind: 'live', subject: 'Issue 29', html: issueHtml }), env);
  const issue = await callTool(env, c.access, 'test_send', { send: 'the-source-29', to: ['tester@example.com'] });
  assert.equal(issue.data.sent, 1);
  assert.equal(ses.outbox.length, 4);
  assert.ok(ses.outbox.every(m => ['tester@example.com', 'second.tester@example.com'].includes(m.Destination.ToAddresses[0])));

  const audit = await rows(env, `SELECT summary FROM audit_log WHERE tool = 'test_send'`);
  assert.equal(audit.length, 4);
  for (const a of audit) assert.doesNotMatch(String(a.summary), /@/);
});

test('test sends stop at 20 an hour', async () => {
  ses = fakeSes();
  const env = testEnv();
  const c = await connect(env, { scope: 'drafts.write test.send' });
  const id = (await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'S', html: issueHtml })).data.id;
  for (let i = 0; i < 20; i++) await env.DB.prepare(`INSERT INTO test_send_slots (client_id, at) VALUES ('x', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`).run();
  const r = await callTool(env, c.access, 'test_send', { draft: id });
  assert.match(r.error!, /20 test sends an hour/);
  assert.equal(ses.outbox.length, 0);
});

async function requested(env: ReturnType<typeof testEnv>, n = 5) {
  await seed(env, n);
  const c = await connect(env, { scope: all });
  const id = (await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'Issue 33', html: issueHtml })).data.id;
  const r = await callTool(env, c.access, 'request_send', { draft: id, key: 'the-source-33' });
  assert.equal(r.error, null, r.error ?? '');
  return { c, draft: id, ...r.data } as { c: Awaited<ReturnType<typeof connect>>; draft: string; approval: string; approveUrl: string; recipients: number; expiresAt: string };
}

const approvalPost = (env: ReturnType<typeof testEnv>, url: string, decision: string, headers: Record<string, string> = { Origin: base }) =>
  handle(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: `decision=${decision}` }), env);

test('request_send: a person approves once, the cron sends at 14 a second, and the audit names who approved', async () => {
  ses = fakeSes();
  const env = testEnv();
  const r = await requested(env, 30);
  assert.equal(r.recipients, 30);
  assert.match(r.approveUrl, /^https:\/\/news\.test\/approve\/[A-Za-z0-9_-]{43}$/);
  assert.equal(ses.outbox.length, 0, 'nothing goes out on a request');
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM sends'))[0].n, 0);

  env.DEV_IDENTITY = 'admin@example.com';
  const page = await handle(new Request(r.approveUrl), env);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /The Source/);
  assert.match(html, /Issue 33/);
  assert.match(html, />30</);

  assert.equal((await approvalPost(env, r.approveUrl, 'approve', { Origin: 'https://evil.example' })).status, 403);
  const approved = await approvalPost(env, r.approveUrl, 'approve');
  assert.equal(approved.status, 200);
  assert.equal((await approvalPost(env, r.approveUrl, 'approve')).status, 409, 'single use');
  const [send] = await rows(env, `SELECT key, kind, list, subject FROM sends`);
  assert.deepEqual(send, { key: 'the-source-33', kind: 'live', list: 'the-source', subject: 'Issue 33' });
  assert.equal(ses.outbox.length, 0, 'the cron sends, not the approval');

  let clock = 0;
  const waits: number[] = [];
  const perBatch: number[] = [];
  const result = await runApproved(env, {
    clock: () => clock,
    sleep: async ms => { waits.push(ms); perBatch.push(ses.outbox.length - perBatch.reduce((a, b) => a + b, 0)); clock += ms; },
  });
  assert.equal(result.sent, 30);
  assert.deepEqual(perBatch, [14, 14, 2]);
  assert.deepEqual(waits, [1000, 1000, 1000]);
  assert.equal((await rows(env, `SELECT status FROM approvals`))[0].status, 'sent');
  const status = await callTool(env, r.c.access, 'approval_status', { approval: r.approval });
  assert.equal(status.data.status, 'sent');
  assert.equal(status.data.key, 'the-source-33');

  const audit = await rows(env, `SELECT tool, outcome, approved_by, summary FROM audit_log WHERE tool = 'request_send' ORDER BY id`);
  assert.deepEqual(audit.map(a => [a.outcome, a.approved_by]), [['ok', null], ['approved', 'admin@example.com']]);
});

test('the cron stops within its time budget and the next run goes on', async () => {
  ses = fakeSes();
  const env = testEnv();
  const r = await requested(env, 40);
  env.DEV_IDENTITY = 'admin@example.com';
  await approvalPost(env, r.approveUrl, 'approve');
  let clock = 0;
  const first = await runApproved(env, { budgetMs: 2000, clock: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(first.sent, 28);
  const second = await runApproved(env, { clock: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(second.sent, 12);
  assert.equal(ses.outbox.length, 40);
});

test('an approval expires after ten minutes, and a declined one sends nothing', async () => {
  ses = fakeSes();
  const env = testEnv();
  const r = await requested(env, 3);
  env.DEV_IDENTITY = 'admin@example.com';
  await env.DB.prepare(`UPDATE approvals SET expires_at = '2026-01-01T00:00:00Z'`).run();
  assert.equal((await handle(new Request(r.approveUrl), env)).status, 410);
  assert.equal((await approvalPost(env, r.approveUrl, 'approve')).status, 409);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM sends'))[0].n, 0);

  const env2 = testEnv();
  const r2 = await requested(env2, 3);
  env2.DEV_IDENTITY = 'admin@example.com';
  assert.equal((await approvalPost(env2, r2.approveUrl, 'decline')).status, 200);
  assert.equal((await approvalPost(env2, r2.approveUrl, 'approve')).status, 409);
  await runApproved(env2, { sleep: async () => {} });
  assert.equal((await rows(env2, 'SELECT COUNT(*) AS n FROM sends'))[0].n, 0);
  assert.equal(ses.outbox.length, 0);
  assert.deepEqual((await rows(env2, `SELECT outcome, approved_by FROM audit_log WHERE outcome = 'declined'`)), [{ outcome: 'declined', approved_by: 'admin@example.com' }]);
});

test('only an admin can open or answer an approval', async () => {
  ses = fakeSes();
  const env = testEnv();
  const r = await requested(env, 2);
  env.DEV_IDENTITY = undefined;
  assert.equal((await handle(new Request(r.approveUrl), env)).status, 401);
  env.DEV_IDENTITY = 'reader0@example.com';
  assert.equal((await approvalPost(env, r.approveUrl, 'approve')).status, 403);
  assert.equal((await rows(env, `SELECT status FROM approvals`))[0].status, 'pending');
  env.DEV_IDENTITY = undefined;
  assert.equal((await handle(new Request(`${base}/approve/${'x'.repeat(43)}`), env)).status, 401, 'who comes before what');
  env.DEV_IDENTITY = 'admin@example.com';
  assert.equal((await handle(new Request(`${base}/approve/${'x'.repeat(43)}`), env)).status, 404);
});

test('what is approved is what goes out, even if the draft changes after the request', async () => {
  ses = fakeSes();
  const env = testEnv();
  const r = await requested(env, 2);
  await callTool(env, r.c.access, 'draft_save', { id: r.draft, list: 'the-source', subject: 'Changed later', html: issueHtml.replace('Read more', 'Changed') });
  env.DEV_IDENTITY = 'admin@example.com';
  await approvalPost(env, r.approveUrl, 'approve');
  await runApproved(env, { sleep: async () => {} });
  assert.ok(ses.outbox.every(m => m.Content.Simple.Subject.Data === 'Issue 33'));
  assert.ok(ses.outbox.every(m => m.Content.Simple.Body.Html.Data.includes('Read more')));
});

test('request_send refuses a draft with no unsubscribe link, and a key already used', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 2);
  const c = await connect(env, { scope: all });
  const bare = (await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'S', html: '<p>no way out</p>' })).data.id;
  assert.match((await callTool(env, c.access, 'request_send', { draft: bare })).error!, /UNSUB/);
  await handle(admin('/admin/sends', { key: 'the-source-40', list: 'the-source', kind: 'live', subject: 'S', html: issueHtml }), env);
  const good = (await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'S', html: issueHtml })).data.id;
  assert.match((await callTool(env, c.access, 'request_send', { draft: good, key: 'the-source-40' })).error!, /exists/);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM approvals'))[0].n, 0);
});

test('every tool call is audited: time, client, scope, tool, and a summary with no addresses', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 2);
  const c = await connect(env, { scope: all });
  await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'Write to reader0@example.com', markdown: 'Hi' });
  await callTool(env, c.access, 'subscriber_counts');
  await callTool(env, c.access, 'test_send', { draft: 'd-0000000000', to: ['tester@example.com'] });
  const audit = await rows(env, `SELECT at, client_id, subject, scope, tool, summary, outcome FROM audit_log WHERE client_id != 'admin-token' ORDER BY id`);
  assert.deepEqual(audit.map(a => [a.tool, a.scope, a.outcome]), [['draft_save', 'drafts.write', 'ok'], ['subscriber_counts', 'subscribers.read', 'ok'], ['test_send', 'test.send', 'error']]);
  for (const a of audit) {
    assert.match(String(a.at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(a.client_id, c.clientId);
    assert.doesNotMatch(String(a.summary), /@/);
  }
  assert.deepEqual(JSON.parse(String(audit[0].summary)), { list: 'the-source', subject: 'Write to [address]', format: 'markdown', bytes: 2 });
  const fromAdmin = await (await handle(admin('/admin/audit'), env)).json() as { entries: unknown[] };
  assert.equal(fromAdmin.entries.length, 4, 'and the import, as admin-token');
});

test('revoking an assistant withdraws the sends it asked for and nobody has approved', async () => {
  ses = fakeSes();
  const env = testEnv();
  const r = await requested(env, 3);
  const res = await handle(admin('/admin/oauth/revoke', { clientId: r.c.clientId }), env);
  assert.equal((await res.json() as Record<string, number>).approvalsWithdrawn, 1);
  env.DEV_IDENTITY = 'admin@example.com';
  assert.notEqual((await approvalPost(env, r.approveUrl, 'approve')).status, 200);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM sends'))[0].n, 0);
  assert.equal(ses.outbox.length, 0);
});

// --- Security review, 2026-11-02 ---

test('test sends stop at 20 an hour, also when the calls come all at once', async () => {
  ses = fakeSes();
  const env = testEnv();
  const c = await connect(env, { scope: 'drafts.write test.send' });
  const id = (await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'Loop', html: '<p>x</p>' })).data.id;
  const results = await Promise.all(Array.from({ length: 40 }, () => callTool(env, c.access, 'test_send', { draft: id, to: ['tester@example.com'] })));
  assert.equal(results.filter(r => !r.error).length, 20);
  assert.ok(results.filter(r => r.error).every(r => /20 test sends an hour/.test(r.error!)));
  assert.equal(ses.outbox.length, 20);
  // A call that fails before it would send takes no slot.
  const env2 = testEnv();
  const c2 = await connect(env2, { scope: 'test.send' });
  for (let i = 0; i < 25; i++) await callTool(env2, c2.access, 'test_send', { draft: 'd-0000000000' });
  assert.equal((await rows(env2, 'SELECT COUNT(*) AS n FROM test_send_slots'))[0].n, 0);
});

// A draft that hides things from the preview: an Outlook-only block, and text hidden with CSS
// that still lands in the text/plain part.
const sneakyHtml = `<html><head><link rel="stylesheet" href="https://tracker.example/s.css"></head><body>
<div style="display:none;max-height:0;overflow:hidden">October in short</div>
<p>Hi *|FNAME|*, the October issue. <a href="https://sourceful.energy/news">News</a> <img src="https://tracker.example/pixel.png" alt=""></p>
<!--[if mso]><p>OUTLOOK-ONLY: your account is locked, <a href="https://attacker.example/login">sign in here</a></p><![endif]-->
<div style="display: none">TEXT-PART-ONLY: verify at https://attacker.example/verify</div>
<span style="font-size:0px;line-height:0">ZERO-SIZE text</span>
<p><a href="*|UNSUB|*">Unsubscribe</a> or <a href='mailto:info@example.com'>write to us</a></p></body></html>`;

test('the approval page shows the text part, every link target, what is hidden, and which assistants wrote the draft', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 3);
  const writer = await connect(env, { scope: 'drafts.write' });
  const draft = (await callTool(env, writer.access, 'draft_save', { list: 'the-source', subject: 'October', html: issueHtml })).data.id;
  // Drafts are shared: another assistant changes it, and the first one asks to send it.
  const other = await connect(env, { scope: 'drafts.write' });
  assert.equal((await callTool(env, other.access, 'draft_save', { id: draft, list: 'the-source', subject: 'October', html: sneakyHtml })).error, null);
  const req = (await callTool(env, writer.access, 'request_send', { draft, key: 'october' })).data;

  env.DEV_IDENTITY = 'admin@example.com';
  const res = await handle(new Request(req.approveUrl), env);
  assert.equal(res.status, 200);
  const page = await res.text();
  const outside = page.replace(/<iframe[\s\S]*?<\/iframe>/, '');

  // The text/plain part, as it goes out: the hidden text is in it.
  const text = outside.match(/<pre id="text-part"[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(text, 'the text part is on the page');
  assert.match(text[1], /TEXT-PART-ONLY: verify at https:\/\/attacker\.example\/verify/);
  assert.match(text[1], /Hi 👋, the October issue\./);

  // Every link target, as text: the Outlook-only one too, and none of them a link.
  const links = outside.match(/<ul id="links"[\s\S]*?<\/ul>/)?.[0] ?? '';
  for (const l of ['https://sourceful.energy/news', 'https://attacker.example/login', '*|UNSUB|*', 'mailto:info@example.com']) assert.ok(links.includes(escapeHtml(l)), l);
  assert.doesNotMatch(outside, /<a\b[^>]*href="(https:\/\/attacker|https:\/\/tracker|mailto:)/, 'no link target is clickable outside the preview');
  assert.ok(outside.includes('https://tracker.example/pixel.png'), 'images it loads are listed');

  // Warnings for what the preview does not show.
  const outlook = outside.match(/<div id="outlook-only"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(outlook, /OUTLOOK-ONLY: your account is locked/);
  const hidden = outside.match(/<div id="hidden-content"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(hidden, /TEXT-PART-ONLY/);
  assert.match(hidden, /ZERO-SIZE text/);
  assert.doesNotMatch(hidden, /October in short/, 'the preheader is not a warning');
  assert.match(outside, /October in short/, 'but it is shown');

  // Who asked, who made the draft, who changed it last.
  const who = outside.match(/<tr id="draft-by">[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.ok(who.includes(writer.clientId) && who.includes(other.clientId), who);
  assert.match(who, /another assistant/i);

  // Opening the page loads nothing from elsewhere: the preview inherits this policy.
  const csp = res.headers.get('Content-Security-Policy')!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src 'self' data:(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.doesNotMatch(csp, /https?:|\*/);
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  const srcdoc = page.match(/srcdoc="([^"]*)"/)![1];
  assert.doesNotMatch(srcdoc, /&lt;link/i, 'no prefetch or stylesheet link in the preview');
});

test('a plain draft and the Markdown layout raise no warning on the approval page', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 2);
  const c = await connect(env, { scope: 'drafts.write' });
  const preheader = issueHtml.replace('<body>', '<body><span style="display:none !important; visibility:hidden; mso-hide:all; font-size:1px; max-height:0px; overflow:hidden">This month: the Zap&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</span>');
  for (const [key, args] of [
    ['plain', { html: issueHtml }],
    ['preheader', { html: preheader }],
    ['markdown', { markdown: '# October\n\nHi *|FNAME|*, read [the news](https://sourceful.energy/news).' }],
  ] as const) {
    const draft = (await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'October', ...args })).data.id;
    const req = (await callTool(env, c.access, 'request_send', { draft, key: `october-${key}` })).data;
    env.DEV_IDENTITY = 'admin@example.com';
    const page = await (await handle(new Request(req.approveUrl), env)).text();
    assert.doesNotMatch(page, /id="hidden-content"|id="outlook-only"/, key);
    assert.match(page, /<pre id="text-part"/, key);
    assert.doesNotMatch(page.match(/<tr id="draft-by">[\s\S]*?<\/tr>/)![0], /another assistant/i, key);
  }
});

test('the cron leaves an approval whose send is not created yet, and fails one that never got its send', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env, 5);
  const html = '<a href="*|UNSUB|*">u</a>';
  const approval = (id: string, key: string, decided: Date) => env.DB.prepare(`INSERT INTO approvals (id, token_hash, draft_id, send_key, list, subject, html, recipients, client_id, requested_by, status, decided_at, expires_at)
      VALUES (?, ?, 'd-1', ?, 'the-source', 'S', ?, 5, 'c', 'admin@example.com', 'approved', ?, '2099-01-01T00:00:00Z')`).bind(id, `h-${id}`, key, html, iso(decided)).run();
  // An admin has just approved; the approval route has not created the send yet when the cron runs.
  await approval('a-1', 'issue-1', new Date());
  await runApproved(env, { sleep: async () => {} });
  assert.deepEqual(await rows(env, `SELECT status, error FROM approvals`), [{ status: 'approved', error: null }]);
  await createSend(env, { key: 'issue-1', list: 'the-source', kind: 'live', subject: 'S', html });
  await runApproved(env, { sleep: async () => {} });
  assert.equal((await rows(env, `SELECT status FROM approvals WHERE id = 'a-1'`))[0].status, 'sent');
  assert.equal(ses.outbox.length, 5);
  // The Worker died between the approval and the send, minutes ago: that one cannot be sent.
  await approval('a-2', 'issue-2', new Date(Date.now() - 3 * 60_000));
  await runApproved(env, { sleep: async () => {} });
  assert.deepEqual((await rows(env, `SELECT status, error FROM approvals WHERE id = 'a-2'`))[0], { status: 'failed', error: 'no_such_send' });
});

test('a draft records the assistant that made it and the one that changed it last', async () => {
  ses = fakeSes();
  const env = testEnv();
  const a = await connect(env, { scope: 'drafts.write' });
  const b = await connect(env, { scope: 'drafts.write' });
  const id = (await callTool(env, a.access, 'draft_save', { list: 'the-source', subject: 'S', html: issueHtml })).data.id;
  await callTool(env, b.access, 'draft_save', { id, list: 'the-source', subject: 'S2', html: issueHtml });
  assert.deepEqual(await rows(env, 'SELECT created_by, client_id FROM drafts'), [{ created_by: a.clientId, client_id: b.clientId }]);
  const list = await callTool(env, a.access, 'drafts_list');
  assert.equal(list.data.drafts[0].created_by, a.clientId);
  assert.equal(list.data.drafts[0].changed_by, b.clientId);
  const req = await callTool(env, a.access, 'request_send', { draft: id, key: 'k-1' });
  assert.equal(req.error, null, req.error ?? '');
  assert.deepEqual(await rows(env, 'SELECT draft_created_by, draft_changed_by FROM approvals'), [{ draft_created_by: a.clientId, draft_changed_by: b.clientId }]);
});

test('an SES account error stops the cron run with one log line, and the approval waits for the next run', async () => {
  ses = fakeSes();
  const env = testEnv();
  const r = await requested(env, 20);
  env.DEV_IDENTITY = 'admin@example.com';
  assert.equal((await approvalPost(env, r.approveUrl, 'approve')).status, 200);
  // Sending is paused on the account: every mail of the batch is refused the same way.
  ses.fail.push(...Array(14).fill({ status: 400, type: 'SendingPausedException' }));
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  let result: Awaited<ReturnType<typeof cron>>;
  try {
    result = await cron(env);
  } finally {
    console.error = original;
  }
  assert.equal(result.sent, 0);
  assert.equal(result.stopped, 'ses_account_error: SendingPaused 400');
  assert.equal(logged.length, 1, 'once, not once a batch');
  assert.match(logged[0], /"event":"cron_stopped"/);
  assert.match(logged[0], /SendingPaused 400/);
  assert.doesNotMatch(logged[0], /@/);
  assert.equal((await rows(env, 'SELECT status FROM approvals'))[0].status, 'approved');
  assert.deepEqual(await rows(env, 'SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status'), [{ status: 'pending', n: 20 }]);
  assert.equal(ses.outbox.length, 0);
  // The cause is fixed; the next run sends everyone.
  ses.fail.length = 0;
  const next = await runApproved(env, { sleep: async () => {} });
  assert.equal(next.sent, 20);
  assert.equal(next.stopped, null);
  assert.equal((await rows(env, 'SELECT status FROM approvals'))[0].status, 'sent');
});
