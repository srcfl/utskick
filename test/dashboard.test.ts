import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import { forget, subscribe } from '../src/contacts.ts';
import { stats } from '../src/send.ts';
import { admin, fakeSes, rows, testConfig, testEnv } from './helpers.ts';
import { base, callTool, connect } from './oauth-helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

type TestEnv = ReturnType<typeof testEnv>;

const issueHtml = '<html><body><p>Hi *|FNAME|*,</p><p><a href="https://sourceful.energy/news">Read more</a> or <a href="https://sourceful.energy/zap">see the Zap</a></p><p><a href="*|UNSUB|*">Unsubscribe</a></p></body></html>';

// Names no page has a reason to contain, so finding one means a leak.
const people = Array.from({ length: 8 }, (_, i) => ({ email: `reader${i}@example.com`, firstName: `Ottilia${i}`, lastName: `Brandqvist${i}`, consentedAt: '2024-01-01T00:00:00Z' }));
const newcomers = ['newcomer@example.com', 'tinkerer1@example.com', 'tinkerer2@example.com'];

// The live send went out at T0; events are placed in hours after it.
const T0 = '2026-10-01T08:00:00Z';
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3600_000).toISOString().slice(0, 19) + 'Z';

async function post(env: TestEnv, path: string, body: unknown) {
  const res = await handle(admin(path, body), env);
  assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
  return res.json() as Promise<Record<string, any>>;
}

async function event(env: TestEnv, email: string, type: string, hours: number, link: number | null = null) {
  const r = await env.DB.prepare(`INSERT INTO events (delivery_id, type, link, at) SELECT d.id, ?, ?, ? FROM deliveries d
      JOIN contacts c ON c.id = d.contact_id JOIN sends s ON s.id = d.send_id WHERE c.email = ? AND s.key = 'the-source-30'`)
    .bind(type, link, at(hours), email).run();
  assert.equal(r.meta.changes, 1, `${type} for ${email}`);
}

// A list with history: an import, sign-ups from a form, a live send with opens, clicks, a bounce,
// a complaint and an unsubscribe, its resend, a send to a list without the pixel, a test send,
// and a send an assistant asked for that nobody has approved.
async function seed(env: TestEnv) {
  await post(env, '/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp', contacts: people, suppressions: [] });
  await subscribe(env, { email: newcomers[0], list: 'the-source', consent: 'news-1', source: 'ftw-web' });
  for (const email of newcomers.slice(1)) await subscribe(env, { email, list: 'ftw-news', consent: 'news-1', source: 'ftw-web' });

  await post(env, '/admin/sends', { key: 'the-source-30', list: 'the-source', kind: 'live', subject: 'Issue 30', html: issueHtml });
  await post(env, '/admin/sends/the-source-30/batch', { max: 50, now: T0 });
  await env.DB.prepare(`INSERT INTO events (delivery_id, type, at) SELECT d.id, 'delivery', ? FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.key = 'the-source-30'`).bind(at(0.02)).run();
  await event(env, 'reader0@example.com', 'open', 0.5);
  await event(env, 'reader0@example.com', 'open', 2);        // a second open: not a new reader
  await event(env, 'reader1@example.com', 'open', 5.5);
  await event(env, 'reader2@example.com', 'open', 80);       // day 4
  await event(env, 'reader3@example.com', 'open', 72 + 960); // day 44, past the chart
  await event(env, 'reader0@example.com', 'click', 0.6, 0);
  await event(env, 'reader0@example.com', 'click', 0.8, 1);
  await event(env, 'reader1@example.com', 'click', 6, 0);
  await event(env, 'reader7@example.com', 'bounce', 0.1);
  await event(env, 'reader6@example.com', 'complaint', 3);
  const [{ token }] = await rows<{ token: string }>(env, `SELECT d.token FROM deliveries d JOIN contacts c ON c.id = d.contact_id WHERE c.email = 'reader5@example.com'`);
  assert.equal((await handle(new Request(`${base}/u/${token}`, { method: 'POST' }), env)).status, 200);
  await forget(env, 'reader7@example.com', '*', 'bounce');

  await post(env, '/admin/sends', { key: 'the-source-30-resend', list: 'the-source', kind: 'resend', parent: 'the-source-30', afterDays: 0, subject: 'Issue 30, again', html: issueHtml });
  await post(env, '/admin/sends', { key: 'ftw-news-1', list: 'ftw-news', kind: 'live', subject: 'FTW 1', html: issueHtml });
  await post(env, '/admin/sends/ftw-news-1/batch', { max: 50, now: T0 });
  await post(env, '/admin/sends', { key: 'the-source-30-test-ab12', list: 'the-source', kind: 'test', subject: 'Issue 30', html: issueHtml, testTo: [{ email: 'tester@example.com', firstName: 'Testperson' }] });
  await post(env, '/admin/sends/the-source-30-test-ab12/batch', { max: 5 });

  const c = await connect(env, { scope: 'drafts.write' });
  const draft = (await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'Issue 31', html: issueHtml })).data.id;
  const asked = await callTool(env, c.access, 'request_send', { draft, key: 'the-source-31' });
  assert.equal(asked.error, null, asked.error ?? '');
  env.DEV_IDENTITY = 'admin@example.com';
  return asked.data as { approval: string; approveUrl: string };
}

const get = (env: TestEnv, path: string, init: RequestInit = {}) => handle(new Request(`${base}${path}`, init), env);

async function page(env: TestEnv, path: string) {
  const res = await get(env, path);
  assert.equal(res.status, 200, path);
  return res.text();
}

// The text of each cell in the table row with this id.
function cells(html: string, id: string): string[] {
  const m = html.match(new RegExp(`<tr id="${id}"[^>]*>([\\s\\S]*?)</tr>`));
  assert.ok(m, `a row ${id}`);
  return [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function figure(html: string, id: string): string {
  const m = html.match(new RegExp(`<figure id="${id}"[\\s\\S]*?</figure>`));
  assert.ok(m, `a figure ${id}`);
  return m[0];
}

const security = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

function assertSecured(res: Response, what: string) {
  for (const [name, value] of Object.entries(security)) assert.equal(res.headers.get(name), value, `${what}: ${name}`);
}

test('sign-in: nobody gets 401, a non-admin 403, an installation without sign-in 503, before anything is read', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env);
  env.DEV_IDENTITY = undefined;
  for (const path of ['/dashboard', '/dashboard/sends/the-source-30', '/dashboard/sends/no-such-send', '/dashboard/anything']) {
    const res = await get(env, path);
    assert.equal(res.status, 401, path);
    assertSecured(res, path);
    const html = await res.text();
    assert.match(html, /Sign-in needed/);
    assert.doesNotMatch(html, /the-source-30/);
  }
  env.DEV_IDENTITY = 'reader0@example.com';
  const outsider = await get(env, '/dashboard');
  assert.equal(outsider.status, 403);
  assertSecured(outsider, '403');
  assert.doesNotMatch(await outsider.text(), /reader0|@/, 'the page does not repeat an address');

  const bare = testEnv();
  bare.CONFIG = { ...testConfig, access: undefined };
  const unset = await get(bare, '/dashboard');
  assert.equal(unset.status, 503);
  assertSecured(unset, '503');
});

test('only GET and HEAD, and every answer carries the security headers', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await get(env, '/dashboard', { method, body: method === 'DELETE' ? undefined : 'x=1' });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('Allow'), 'GET, HEAD');
    assertSecured(res, method);
  }
  const head = await get(env, '/dashboard', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assertSecured(head, 'HEAD');
  for (const path of ['/dashboard', '/dashboard/', '/dashboard?tests=1', '/dashboard/sends/the-source-30']) {
    const res = await get(env, path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('Content-Type')!, /^text\/html/);
    assertSecured(res, path);
    const html = await res.text();
    assert.doesNotMatch(html, /<script|<form|<button|<link|<img|https?:\/\/[^"<\s]*\.(css|js|woff2?)\b/i, `${path}: no script, form, button or outside asset`);
  }
});

test('a bad, unknown or odd path under /dashboard is a 404 with the same headers', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env);
  for (const path of ['/dashboard/sends/no-such-send', '/dashboard/sends/The-Source-30', '/dashboard/sends/the_source', '/dashboard/sends/' + 'a'.repeat(81),
    '/dashboard/sends/the-source-30/extra', '/dashboard/sends/%3Cb%3E', '/dashboard/sends/', '/dashboard/other']) {
    const res = await get(env, path);
    assert.equal(res.status, 404, path);
    assertSecured(res, path);
    assert.doesNotMatch(await res.text(), /<b>/);
  }
  assert.equal((await get(env, '/dashboardx')).status, 404, 'not a dashboard path');
});

test('the overview: lists, sends with their rates, approvals waiting and the audit log', async () => {
  ses = fakeSes();
  const env = testEnv();
  const asked = await seed(env);
  const html = await page(env, '/dashboard');

  // The Source: 8 imported and 1 from the form, less one who left and one who bounced.
  assert.deepEqual(cells(html, 'list-the-source'), ['The Source the-source', '7', '1', '1', 'ftw-web 1']);
  assert.deepEqual(cells(html, 'list-ftw-news'), ['FTW news ftw-news', '2', '0', '2', 'ftw-web 2']);
  assert.deepEqual(cells(html, 'list-ftw-box'), ['the FTW box waitlist ftw-box', '0', '0', '0', '–']);
  assert.match(html, /id="suppressed-everywhere"[^>]*>[^<]*<strong>1<\/strong>/);

  // Sends, newest first; the numbers are the ones stats() gives.
  const sends = [...html.matchAll(/<tr id="send-([a-z0-9-]+)"/g)].map(m => m[1]);
  assert.deepEqual(sends, ['ftw-news-1', 'the-source-30-resend', 'the-source-30'], 'test sends hidden');
  const s = await stats(env, 'the-source-30');
  assert.deepEqual([s.recipients, s.status.sent, s.delivered, s.opens.unique, s.clicks.unique, s.bounced, s.complaints, s.unsubscribed], [9, 9, 9, 4, 2, 1, 1, 1]);
  assert.deepEqual(cells(html, 'send-the-source-30').slice(1).filter((_, i) => i !== 1), ['live', '9', '9', '9', '4 44.4%', '2 22.2%', '1', '1', '1']);
  const resend = await stats(env, 'the-source-30-resend');
  const r = cells(html, 'send-the-source-30-resend');
  assert.equal(r[1], 'resend');
  assert.deepEqual(r.slice(3), [String(resend.recipients), '0', '0', '0 –', '0 –', '0', '0', '0'], 'rates of nothing sent are a dash');
  assert.equal(cells(html, 'send-ftw-news-1')[6], 'no pixel', 'a list without the open pixel shows no open rate');

  const withTests = await page(env, '/dashboard?tests=1');
  assert.deepEqual([...withTests.matchAll(/<tr id="send-([a-z0-9-]+)"/g)].map(m => m[1]), ['the-source-30-test-ab12', 'ftw-news-1', 'the-source-30-resend', 'the-source-30']);
  assert.equal(cells(withTests, 'send-the-source-30-test-ab12')[1], 'test');
  assert.match(html, /href="\/dashboard\/sends\/the-source-30"/);

  // The approval waits: what, for whom, from which assistant. Its link is not here: only its hash is stored.
  const a = cells(html, `approval-${asked.approval}`);
  assert.equal(a[0], asked.approval);
  assert.ok(a.includes('the-source-31'));
  assert.ok(a.includes('Issue 31'));
  assert.ok(a.includes('7'), 'recipients when asked');
  assert.ok(a.some(c => c.includes('Test Assistant')));

  // The audit log, newest first.
  const audit = html.match(/<table id="audit"[\s\S]*?<\/table>/)![0];
  const tools = [...audit.matchAll(/<tr id="audit-\d+"[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  assert.equal(tools.length, 7);
  assert.match(tools[0], /request_send/);
  assert.match(tools[0], /the-source-31/);
  assert.match(tools[1], /draft_save/);
  // What the CLI did with the admin token: the import and three sends (a batch that went well is not logged).
  assert.ok(tools.slice(2).every(t => /admin-token/.test(t) && /POST \/admin\//.test(t)), 'the CLI\'s changes are in the log too');
  assert.match(tools.at(-1)!, /POST \/admin\/import/);
  assert.doesNotMatch(audit, /reader\d|Ottilia|@/);

  assert.match(html, /Apple Mail Privacy Protection/);
});

test('the audit log shows the latest 20 entries', async () => {
  ses = fakeSes();
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  for (let i = 0; i < 25; i++) await env.DB.prepare(`INSERT INTO audit_log (client_id, tool, summary, outcome) VALUES ('c', ?, '{}', 'ok')`).bind(`tool_${i}`).run();
  const html = await page(env, '/dashboard');
  const shown = [...html.matchAll(/<tr id="audit-(\d+)"/g)].map(m => Number(m[1]));
  assert.equal(shown.length, 20);
  assert.deepEqual(shown.slice(0, 2), [25, 24]);
  assert.match(html, /No sends yet/);
});

test('a send page: the numbers, clicks per link, statuses, and first opens and clicks over time', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env);
  const html = await page(env, '/dashboard/sends/the-source-30');
  assert.match(html, /<h1>the-source-30<\/h1>/);
  assert.match(html, /Issue 30/);
  for (const [label, value] of [['Recipients', '9'], ['Sent', '9'], ['Delivered', '9'], ['Unique opens', '4'], ['Unique clicks', '2'], ['Hard bounces', '1'], ['Complaints', '1'], ['Unsubscribes', '1']]) {
    assert.match(html, new RegExp(`<div class="label">${label}</div><div class="value">${value}</div>`), label);
  }
  assert.match(html, /44\.4% of sent · 5 in all/);

  // Clicks per link, in the order the links appear in the mail.
  const links = [...html.matchAll(/<div class="bar" id="link-(\d+)">([\s\S]*?)<\/div>\s*<\/div>/g)];
  assert.equal(links.length, 2);
  assert.match(links[0][2], /https:\/\/sourceful\.energy\/news/);
  assert.match(links[0][2], /width:100%/);
  assert.match(links[0][2], /class="count">2 · 22\.2%$/);
  assert.match(links[1][2], /https:\/\/sourceful\.energy\/zap/);
  assert.match(links[1][2], /width:50%/);

  assert.match(html, /<div class="bar" id="status-sent">[\s\S]*?width:100%[\s\S]*?>9 · 100\.0%</);

  // One bar per hour, then per day; a reader's later opens do not count again.
  const titles = (id: string) => [...figure(html, id).matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1]);
  assert.deepEqual(titles('opens-over-time'), ['Hour 1: 1', 'Hour 6: 1', 'Day 4: 1']);
  assert.deepEqual(titles('clicks-over-time'), ['Hour 1: 1', 'Hour 7: 1']);
  assert.match(figure(html, 'opens-over-time'), /1 more after day 33/);
  assert.match(figure(html, 'opens-over-time'), /<svg [^>]*role="img"/);

  assert.match(html, /href="\/dashboard\/sends\/the-source-30-resend"/, 'the live send links its resend');
  const child = await page(env, '/dashboard/sends/the-source-30-resend');
  assert.match(child, /href="\/dashboard\/sends\/the-source-30"/, 'the resend links its parent');
  assert.match(child, /No mail has gone out yet/);

  const noPixel = await page(env, '/dashboard/sends/ftw-news-1');
  assert.match(noPixel, /<div class="label">Unique opens<\/div><div class="value">no pixel<\/div>/);
  assert.doesNotMatch(noPixel, /id="opens-over-time"/);
  assert.match(noPixel, /Apple Mail Privacy Protection/);
});

test('no address, name, token or message id on any dashboard page', async () => {
  ses = fakeSes();
  const env = testEnv();
  const asked = await seed(env);
  const secrets = [
    ...people.flatMap(p => [p.email, p.firstName, p.lastName]), ...newcomers, 'tester@example.com', 'Testperson', 'admin@example.com',
    ...(await rows<{ token: string; message_id: string | null }>(env, 'SELECT token, message_id FROM deliveries')).flatMap(d => [d.token, d.message_id ?? d.token]),
    asked.approveUrl.split('/').at(-1)!,
  ];
  assert.ok(secrets.length > 40);
  const keys = (await rows<{ key: string }>(env, 'SELECT key FROM sends')).map(s => s.key);
  const paths = ['/dashboard', '/dashboard?tests=1', ...keys.map(k => `/dashboard/sends/${k}`), '/dashboard/sends/no-such-send'];
  const pages: [string, string][] = [];
  for (const path of paths) pages.push([path, await (await get(env, path)).text()]);
  env.DEV_IDENTITY = 'reader1@example.com';
  pages.push(['403', await (await get(env, '/dashboard')).text()]);
  for (const [path, html] of pages) {
    for (const secret of secrets) assert.ok(!html.includes(secret), `${path} shows ${secret}`);
    assert.doesNotMatch(html, /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[a-z]{2,}/i, `${path} shows something shaped like an address`);
  }
});

test('everything from the database or the config is escaped', async () => {
  ses = fakeSes();
  const env = testEnv();
  env.CONFIG = { ...testConfig, lists: { ...testConfig.lists, 'the-source': { ...testConfig.lists['the-source'], name: 'The <Source>' } } };
  env.DEV_IDENTITY = 'admin@example.com';
  await post(env, '/admin/import', { list: 'the-source', source: '<i>form</i>', consent: 'c', contacts: [{ email: 'reader0@example.com', consentedAt: '2099-01-01T00:00:00Z' }], suppressions: [] });
  await post(env, '/admin/sends', { key: 'the-source-1', list: 'the-source', kind: 'live', subject: '<i>Issue</i> & "more"', html: '<a href="https://example.com/?q=&lt;u&gt;x">x</a> *|UNSUB|*' });
  await env.DB.prepare(`INSERT INTO oauth_grants (id, client_id, client_name, subject, scope, resource, expires_at) VALUES ('g', 'evil', '<script>alert(1)</script>', 'admin@example.com', 'drafts.write', 'x', '2099-01-01T00:00:00Z')`).run();
  await env.DB.prepare(`INSERT INTO audit_log (client_id, tool, summary, outcome) VALUES ('evil', '<b>tool</b>', '{"subject":"<img src=x onerror=alert(1)>","to":"reader0@example.com","ref":"0123456789abcdef0123456789abcdef"}', 'ok')`).run();
  await env.DB.prepare(`INSERT INTO approvals (id, token_hash, draft_id, send_key, list, subject, html, recipients, client_id, requested_by, expires_at)
      VALUES ('a-1', 'h', 'd-1', 'the-source-2', 'the-source', '<u>Next</u>', 'x', 1, 'evil', 'admin@example.com', '2099-01-01T00:00:00Z')`).run();
  const html = (await page(env, '/dashboard')) + (await page(env, '/dashboard/sends/the-source-1'));
  assert.doesNotMatch(html, /<(script|img|i|u|b)[\s>]/);
  for (const escaped of ['The &lt;Source&gt;', '&lt;i&gt;form&lt;/i&gt;', '&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;b&gt;tool&lt;/b&gt;', '&lt;img src=x onerror=alert(1)&gt;',
    '&lt;u&gt;Next&lt;/u&gt;', '&lt;i&gt;Issue&lt;/i&gt; &amp; &quot;more&quot;', 'https://example.com/?q=&lt;u&gt;x']) {
    assert.ok(html.includes(escaped), escaped);
  }
  assert.ok(!html.includes('reader0@example.com'), 'an address in an audit summary is blanked');
  assert.ok(!html.includes('0123456789abcdef0123456789abcdef'), 'so is anything shaped like a delivery token');
});

test('the dashboard reads deliveries and events only through their indexes', async () => {
  ses = fakeSes();
  const env = testEnv();
  await seed(env);
  const seen = new Set<string>();
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql: string) => { seen.add(sql); return prepare(sql); };
  await page(env, '/dashboard');
  await page(env, '/dashboard/sends/the-source-30');
  assert.ok(seen.size >= 8);
  for (const sql of seen) {
    const plan = env.DB.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => String(r.detail)).join('\n');
    assert.doesNotMatch(plan, /\bSCAN (d|e|deliveries|events)\b/, `${sql}\n${plan}`);
  }
});

test('a waiting approval shows which assistants made and last changed its draft', async () => {
  ses = fakeSes();
  const env = testEnv();
  await post(env, '/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp', contacts: people, suppressions: [] });
  const a = await connect(env, { scope: 'drafts.write' });
  const b = await connect(env, { scope: 'drafts.write' });
  await env.DB.prepare(`UPDATE oauth_grants SET client_name = 'Writer One' WHERE client_id = ?`).bind(a.clientId).run();
  await env.DB.prepare(`UPDATE oauth_grants SET client_name = 'Editor Two' WHERE client_id = ?`).bind(b.clientId).run();
  const draft = (await callTool(env, a.access, 'draft_save', { list: 'the-source', subject: 'Issue 31', html: issueHtml })).data.id;
  await callTool(env, b.access, 'draft_save', { id: draft, list: 'the-source', subject: 'Issue 31', html: issueHtml });
  const asked = (await callTool(env, a.access, 'request_send', { draft, key: 'the-source-31' })).data;
  env.DEV_IDENTITY = 'admin@example.com';
  const html = await page(env, '/dashboard');
  assert.match(html, /<th>Draft by<\/th>/);
  const row = cells(html, `approval-${asked.approval}`);
  assert.ok(row.includes('Writer One'), 'asked by');
  assert.ok(row.some(c => /made by Writer One/.test(c) && /changed by Editor Two/.test(c)), JSON.stringify(row));
});
