import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import { runApproved } from '../src/approvals.ts';
import type { Config } from '../src/config.ts';
import { admin, fakeSes, rows, testConfig, testEnv } from './helpers.ts';
import { base, callTool, connect } from './oauth-helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

const config: Config = { ...testConfig, members: ['@team.test'], adhoc: { from: 'Test Org <hello@news.test>', fname: 'there' } };
const html = '<html><body><p>Hi *|FNAME|*, welcome to the partner day.</p><a href="https://example.com/agenda">Agenda</a><a href="*|UNSUB|*">Unsubscribe</a></body></html>';
const purpose = 'Guests who signed up for the partner day on 12 November';

async function member(c: Config = config) {
  ses = fakeSes();
  const e = testEnv();
  e.CONFIG = c;
  e.DEV_IDENTITY = 'kim@team.test';
  const a = await connect(e, { scope: 'stats.read subscribers.read drafts.write test.send lists.write' });
  return { e, a, call: (name: string, args: Record<string, unknown> = {}) => callTool(e, a.access, name, args) };
}

test('a colleague makes a list, adds people, and an admin approves the send; replies go to the colleague', async () => {
  const { e, call } = await member();
  // Someone who bounced before is not added again.
  await e.DB.prepare(`INSERT INTO suppressions (email_hash, scope, reason) VALUES (?, '*', 'bounce')`)
    .bind([...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('gone@example.com')))].map(b => b.toString(16).padStart(2, '0')).join('')).run();

  const made = await call('list_create', { id: 'partner-day', name: 'Partner day 2026', purpose });
  assert.equal(made.error, null, made.error ?? '');
  assert.equal(made.data.replyTo, 'kim@team.test');
  assert.equal((await call('list_create', { id: 'the-source', name: 'X', purpose })).error?.includes('already'), true, 'a config list id is taken');

  const added = await call('list_add', { list: 'partner-day', people: [
    'Ann@Example.com', { email: 'bo@example.com', firstName: 'Bo' }, 'ann@example.com', 'gone@example.com', 'not an address', { email: 'eve@example.com', firstName: '<b>Eve</b>' },
  ] });
  assert.deepEqual(added.data, { list: 'partner-day', added: 3, already: 0, suppressed: 1, invalid: 1, onList: 3 });
  assert.doesNotMatch(JSON.stringify(added.result), /@/, 'the answer names nobody');
  assert.deepEqual(await rows(e, `SELECT c.email, c.first_name, s.source, s.consent FROM subscriptions s JOIN contacts c ON c.id = s.contact_id ORDER BY c.email`), [
    { email: 'ann@example.com', first_name: null, source: 'assistant', consent: 'adhoc' },
    { email: 'bo@example.com', first_name: 'Bo', source: 'assistant', consent: 'adhoc' },
    { email: 'eve@example.com', first_name: null, source: 'assistant', consent: 'adhoc' },
  ]);
  const again = await call('list_add', { list: 'partner-day', people: ['ann@example.com'] });
  assert.equal(again.data.already, 1);

  const counts = (await call('subscriber_counts')).data.lists.find((l: any) => l.list === 'partner-day');
  assert.deepEqual(counts, { list: 'partner-day', name: 'Partner day 2026', subscribers: 3, mailable: 3, unsubscribed: 0, adhoc: true, purpose });

  const draft = (await call('draft_save', { list: 'partner-day', subject: 'See you on Thursday', html })).data;
  assert.deepEqual(draft.warnings, []);
  const r = await call('request_send', { draft: draft.id, key: 'partner-day-1' });
  assert.equal(r.error, null, r.error ?? '');
  assert.equal(r.data.recipients, 3);

  e.DEV_IDENTITY = 'admin@example.com';
  const page = await (await handle(new Request(r.data.approveUrl), e)).text();
  assert.match(page, /id="adhoc-purpose"[\s\S]*Guests who signed up for the partner day/);
  assert.match(page, /id="adhoc-reply"[\s\S]*kim@team\.test/);
  const approved = await handle(new Request(r.data.approveUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: 'decision=approve' }), e);
  assert.equal(approved.status, 200);
  await runApproved(e, { sleep: async () => {} });
  assert.equal(ses.outbox.length, 3);
  for (const m of ses.outbox) {
    assert.equal(m.FromEmailAddress, 'Test Org <hello@news.test>');
    assert.deepEqual(m.ReplyToAddresses, ['kim@team.test']);
    assert.doesNotMatch(m.Content.Simple.Body.Html.Data, /\/o\//, 'no open pixel unless the config asks for one');
  }

  // Leaving it takes the reader off this list only, and its page names the list.
  await call('list_add', { list: 'partner-day', people: ['reader@example.com'] });
  await handle(admin('/admin/import', { list: 'the-source', source: 'test', consent: 'test', contacts: [{ email: 'ann@example.com' }], suppressions: [] }), e);
  const [ann] = await rows(e, `SELECT d.token FROM deliveries d JOIN contacts c ON c.id = d.contact_id WHERE c.email = 'ann@example.com'`);
  assert.match(await (await handle(new Request(`${base}/u/${ann.token}`), e)).text(), /Partner day 2026/);
  assert.equal((await handle(new Request(`${base}/u/${ann.token}`, { method: 'POST' }), e)).status, 200);
  assert.deepEqual(await rows(e, `SELECT s.list FROM subscriptions s JOIN contacts c ON c.id = s.contact_id WHERE c.email = 'ann@example.com'`), [{ list: 'the-source' }]);
});

test('an assistant cannot add people to a newsletter, and a deleted list is closed for good', async () => {
  const { e, call } = await member();
  const refused = await call('list_add', { list: 'the-source', people: ['someone@example.com'] });
  assert.match(refused.error!, /join it themselves/);
  assert.deepEqual(await rows(e, 'SELECT * FROM contacts'), []);

  await call('list_create', { id: 'board-dinner', name: 'Board dinner', purpose: 'The board and their partners, for the dinner on 4 December' });
  await call('list_add', { list: 'board-dinner', people: ['a@example.com', 'b@example.com', 'c@example.com'] });
  await handle(admin('/admin/import', { list: 'the-source', source: 'test', consent: 'test', contacts: [{ email: 'c@example.com' }], suppressions: [] }), e);
  const removed = await call('list_remove', { list: 'board-dinner', people: ['a@example.com', 'nobody@example.com'] });
  assert.deepEqual(removed.data, { list: 'board-dinner', removed: 1, notOnList: 1, invalid: 0, onList: 2 });
  assert.equal((await rows(e, `SELECT COUNT(*) AS n FROM contacts WHERE email = 'a@example.com'`))[0].n, 0, 'an address on no list is deleted');

  const draft = (await call('draft_save', { list: 'board-dinner', subject: 'Dinner', html })).data;
  const asked = await call('request_send', { draft: draft.id });
  assert.equal(asked.error, null, asked.error ?? '');
  const deleted = await call('list_delete', { list: 'board-dinner' });
  assert.deepEqual(deleted.data, { list: 'board-dinner', removed: 2, approvalsWithdrawn: 1 });
  assert.deepEqual(await rows(e, 'SELECT email FROM contacts'), [{ email: 'c@example.com' }], 'someone on another list stays');
  assert.match((await call('list_add', { list: 'board-dinner', people: ['d@example.com'] })).error!, /deleted/);
  assert.match((await call('draft_save', { list: 'board-dinner', subject: 'Dinner', html })).error!, /Unknown list/);
  assert.equal((await call('subscriber_counts')).data.lists.some((l: any) => l.list === 'board-dinner'), false);
  // The dashboard keeps the name for the sends made to it, and lists it no more.
  e.DEV_IDENTITY = 'admin@example.com';
  assert.doesNotMatch(await (await handle(new Request(`${base}/dashboard`), e)).text(), /id="list-board-dinner"/);
});

test('lists made through an assistant are off without an adhoc sender in the config', async () => {
  const { call } = await member({ ...config, adhoc: undefined });
  assert.match((await call('list_create', { id: 'x-list', name: 'X', purpose })).error!, /adhoc/);
});

test('every list tool call is audited with counts, never an address', async () => {
  const { e, call } = await member();
  await call('list_create', { id: 'partner-day', name: 'Partner day', purpose });
  await call('list_add', { list: 'partner-day', people: ['ann@example.com', 'bo@example.com'] });
  await call('list_remove', { list: 'partner-day', people: ['ann@example.com'] });
  const audit = await rows(e, `SELECT tool, summary, outcome FROM audit_log WHERE tool LIKE 'list_%' ORDER BY id`);
  assert.deepEqual(audit.map(a => [a.tool, a.outcome]), [['list_create', 'ok'], ['list_add', 'ok'], ['list_remove', 'ok']]);
  assert.equal(JSON.parse(String(audit[1].summary)).people, 2);
  for (const a of audit) assert.doesNotMatch(String(a.summary), /@/);
});

// review: members share drafts, not each other's lists of people.
test('only the colleague who made a list, or an admin, can change it; an old id cannot be taken over', async () => {
  const { e, call } = await member();
  await call('list_create', { id: 'kims-guests', name: 'Guests', purpose });
  await call('list_add', { list: 'kims-guests', people: ['a@example.com', 'b@example.com'] });

  e.DEV_IDENTITY = 'lee@team.test';
  const lee = await connect(e, { scope: 'lists.write' });
  for (const [tool, args] of [['list_add', { people: ['c@example.com'] }], ['list_remove', { people: ['a@example.com'] }], ['list_delete', {}]] as const) {
    const r = await callTool(e, lee.access, tool, { list: 'kims-guests', ...args });
    assert.match(r.error!, /belongs to the colleague who made it/, tool);
  }
  e.DEV_IDENTITY = 'admin@example.com';
  const boss = await connect(e, { scope: 'lists.write' });
  assert.equal((await callTool(e, boss.access, 'list_delete', { list: 'kims-guests' })).data.removed, 2);

  // A deleted list's id, or one with old subscribers or sends, is not free.
  assert.match((await call('list_create', { id: 'kims-guests', name: 'Again', purpose })).error!, /or was/);
  await handle(admin('/admin/import', { list: 'the-source', source: 'test', consent: 'c', contacts: [{ email: 'x@example.com' }], suppressions: [] }), e);
  await e.DB.prepare(`UPDATE subscriptions SET list = 'old-list'`).run();
  assert.match((await call('list_create', { id: 'old-list', name: 'Old', purpose })).error!, /or was/);
});

test('a mailing to a list a colleague made has no public web version, and the Markdown layout leaves the link out', async () => {
  const { e, call } = await member();
  await call('list_create', { id: 'partner-day', name: 'Partner day', purpose });
  await call('list_add', { list: 'partner-day', people: ['ann@example.com'] });
  const md = (await call('draft_save', { list: 'partner-day', subject: 'Hi', markdown: 'See you there.' })).data;
  assert.deepEqual(md.warnings, []);
  assert.equal((await call('draft_preview', { id: md.id })).data.html.includes('View in your browser'), false);
  const linked = (await call('draft_save', { list: 'partner-day', subject: 'Hi', html: html.replace('</body>', '<a href="*|ARCHIVE|*">web</a></body>') })).data;
  assert.match(linked.warnings[0], /no public web version/);

  const r = await call('request_send', { draft: md.id, key: 'partner-day-1' });
  e.DEV_IDENTITY = 'admin@example.com';
  await handle(new Request(r.data.approveUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: 'decision=approve' }), e);
  await runApproved(e, { sleep: async () => {} });
  assert.equal(ses.outbox.length, 1);
  assert.equal((await handle(new Request(`${base}/a/partner-day-1`), e)).status, 404);
});

test('one person asks for at most 10 sends an hour', async () => {
  const { call } = await member();
  await call('list_create', { id: 'partner-day', name: 'Partner day', purpose });
  await call('list_add', { list: 'partner-day', people: ['ann@example.com'] });
  const id = (await call('draft_save', { list: 'partner-day', subject: 'Hi', html })).data.id;
  for (let i = 0; i < 10; i++) assert.equal((await call('request_send', { draft: id, key: `partner-day-${i}` })).error, null);
  assert.match((await call('request_send', { draft: id, key: 'partner-day-10' })).error!, /10 send requests an hour/);
});

test('before migration 0005 the lists table is missing, and readers\' pages still work', async t => {
  const { e } = await member();
  e.DB.sqlite.exec('DROP TABLE lists');
  t.mock.method(console, 'error', () => {});
  assert.equal((await handle(new Request(`${base}/unsubscribe`), e)).status, 200);
});
