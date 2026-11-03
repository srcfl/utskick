import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import { subscribe } from '../src/contacts.ts';
import { stats } from '../src/send.ts';
import { deliverability, listGrowth, sendSummaries } from '../src/stats.ts';
import { iso } from '../src/util.ts';
import { admin, aged, browser, fakeSes, reader, rows, testEnv } from './helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

const html = `<html><body><p>Hi *|FNAME|*</p>
<a href="https://example.com/a">A</a> <a href="https://example.com/b">B</a> <a href="https://example.com/c">C</a>
<a href="*|UNSUB|*">Unsubscribe</a></body></html>`;

async function sent(n = 4, key = 'the-source-50') {
  ses = fakeSes();
  const env = testEnv();
  const contacts = Array.from({ length: n }, (_, i) => ({ email: `r${i}@example.com`, consentedAt: '2026-09-15T10:00:00Z' }));
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'c', contacts, suppressions: [] }), env);
  await handle(admin('/admin/sends', { key, list: 'the-source', kind: 'live', subject: 'S', html }), env);
  await handle(admin('/admin/sends/' + key + '/batch', { max: 50 }), env);
  const tokens = (await rows(env, 'SELECT token FROM deliveries ORDER BY id')).map(r => r.token as string);
  return { env, tokens };
}

// A request as it reaches the Worker, with Cloudflare's view of the network it came from.
function from(url: string, cf: Record<string, unknown>, agent = browser) {
  const r = new Request(url, { headers: { 'User-Agent': agent } });
  Object.defineProperty(r, 'cf', { value: cf });
  return r;
}

test('scanners and machines are told apart from people, and a person\'s click still counts after a scanner\'s', async () => {
  const { env, tokens } = await sent();
  const c = (t: string, n: number) => `https://news.test/c/${t}/${n}`;
  // Right after the send: only a scanner clicks this soon.
  await handle(reader(c(tokens[0], 0)), env);
  await aged(env);
  // A mail server's checks, by network and by user agent; a click with no user agent.
  await handle(from(c(tokens[1], 0), { asn: 8075, asOrganization: 'MICROSOFT-CORP-MSN-AS-BLOCK' }), env);
  await handle(from(c(tokens[1], 1), { asn: 64500, asOrganization: 'Proofpoint, Inc.' }), env);
  await handle(new Request(c(tokens[1], 2)), env);
  // A scanner that follows every link in turn, from a network nobody knows.
  for (const n of [0, 1, 2]) await handle(reader(c(tokens[2], n)), env);
  // A person, later, on the link a scanner clicked first.
  await handle(reader(c(tokens[0], 0)), env);
  // Opens: Apple's proxy, and a person.
  await handle(from(`https://news.test/o/${tokens[3]}.gif`, { asn: 714, asOrganization: 'APPLE-ENGINEERING' }), env);
  await handle(reader(`https://news.test/o/${tokens[0]}.gif`), env);

  const s = await stats(env, 'the-source-50');
  assert.deepEqual(s.clicks, { unique: 1, total: 1, machine: 2, any: 3 });
  assert.deepEqual(s.opens, { unique: 1, total: 1, machine: 1, any: 2 });
  assert.deepEqual(s.links.map(l => [l.unique, l.machine]), [[1, 2], [0, 2], [0, 2]]);
  assert.deepEqual(s.rates, { delivered: 0, open: 0.5, openPeople: 0.25, click: 0.25, clickToOpen: 0.5, unsubscribe: 0, bounce: 0, complaint: 0 });
  // Nothing but the verdict is kept.
  assert.deepEqual(Object.keys((await rows(env, 'SELECT * FROM events LIMIT 1'))[0]).sort(), ['at', 'delivery_id', 'detail', 'id', 'link', 'machine', 'type']);

  // The dashboard counts the person's click only, and says how many only scanners touched.
  env.DEV_IDENTITY = 'admin@example.com';
  const page = await (await handle(new Request('https://news.test/dashboard/sends/the-source-50'), env)).text();
  assert.match(page, /<div class="label">Unique clicks<\/div><div class="value">1<\/div><div class="sub">25\.0% of sent · 1 in all · 2 more only by scanners/);
});

test('sends side by side, sending health, and when SES events do not arrive', async () => {
  const { env } = await sent(40);
  const summary = await sendSummaries(env, { limit: 10 });
  assert.equal(summary.length, 1);
  assert.deepEqual([summary[0].sent, summary[0].rates], [40, { open: 0, click: 0, unsubscribe: 0 }]);
  let health = await deliverability(env);
  assert.equal(health.sent, 40);
  assert.equal(health.eventsMissing, true, 'mail went out and no delivery event came back');
  assert.equal(health.health.overall, 'ok');

  // Two hard bounces and one complaint in 40: 5% bounces, 2.5% complaints.
  const ids = (await rows(env, 'SELECT id FROM deliveries ORDER BY id')).map(r => r.id as number);
  for (const id of ids) await env.DB.prepare(`INSERT INTO events (delivery_id, type) VALUES (?, 'delivery')`).bind(id).run();
  for (const id of ids.slice(0, 2)) await env.DB.prepare(`INSERT INTO events (delivery_id, type) VALUES (?, 'bounce')`).bind(id).run();
  await env.DB.prepare(`INSERT INTO events (delivery_id, type) VALUES (?, 'complaint')`).bind(ids[5]).run();
  health = await deliverability(env);
  assert.deepEqual([health.bounced, health.complaints, health.rates.bounce, health.rates.complaint], [2, 1, 0.05, 0.025]);
  assert.deepEqual(health.health, { bounce: 'act', complaint: 'act', overall: 'act' });
  assert.equal(health.eventsMissing, false);

  env.DEV_IDENTITY = 'admin@example.com';
  const page = await (await handle(new Request('https://news.test/dashboard'), env)).text();
  assert.match(page, /id="health"[\s\S]*Hard bounces[\s\S]*5\.0%[\s\S]*act now/);
  assert.doesNotMatch(page, /id="events-missing"/);
});

test('list growth counts who joined and left, by month, and counts a person once', async () => {
  const { env, tokens } = await sent(3);
  const now = new Date();
  const month = iso(now).slice(0, 7);
  await subscribe(env, { email: 'new@example.com', list: 'the-source', consent: 'c', source: 'web' });
  await subscribe(env, { email: 'new@example.com', list: 'the-source', consent: 'c', source: 'web' });
  await handle(new Request(`https://news.test/u/${tokens[0]}`, { method: 'POST' }), env);
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'c', contacts: [{ email: 'r1@example.com', consentedAt: '2026-09-15T10:00:00Z' }], suppressions: [] }), env);

  const g = await listGrowth(env, { months: 24 }, now);
  const source = g.lists.find(l => l.list === 'the-source')!;
  assert.equal(source.subscribers, 3);
  assert.deepEqual(source.months.find(m => m.month === '2026-09'), { month: '2026-09', joined: 3, departed: 0, net: 3 }, 'an import counts people when they signed up');
  assert.deepEqual(source.months.find(m => m.month === month), { month, joined: 1, departed: 1, net: 0 });
  assert.equal(g.lists.some(l => l.list === 'ftw-news'), true);

  env.DEV_IDENTITY = 'admin@example.com';
  const page = await (await handle(new Request('https://news.test/dashboard'), env)).text();
  assert.match(page, new RegExp(`<tr id="growth-${month}"><th scope="row">${month}</th><td class="num">\\+1 −1</td>`));
});
