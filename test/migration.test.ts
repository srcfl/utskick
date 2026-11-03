import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { handle } from '../src/app.ts';
import { subscribe } from '../src/contacts.ts';
import { admin, fakeSes, rows, testEnv } from './helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

const dir = new URL('../migrations/', import.meta.url);
const migration = (f: string) => readFileSync(new URL(f, dir), 'utf8');
const before = readdirSync(dir).filter(f => f.endsWith('.sql') && f < '0003').sort();

function shape(db: DatabaseSync) {
  const columns = db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('contacts') ORDER BY cid`).all();
  const unique = db.prepare(`SELECT l."unique", (SELECT group_concat(name) FROM pragma_index_info(l.name)) AS cols FROM pragma_index_list('contacts') l ORDER BY cols`).all();
  return JSON.stringify({ columns, unique });
}

// A database as production has it before 0003: ids with gaps, and deliveries that point at
// contacts deleted since (6 and 7 left after their mail; 7 was the newest).
function current() {
  const db = new DatabaseSync(':memory:');
  for (const f of before) db.exec(migration(f));
  db.exec(`
    INSERT INTO contacts (id, email, email_hash, first_name, last_name, country, created_at) VALUES
      (1, 'anna@example.com', 'h1', 'Anna', 'Berg', 'SE', '2021-03-04T10:15:00Z'),
      (2, 'bo@example.com', 'h2', NULL, NULL, NULL, '2022-01-01T00:00:00Z'),
      (5, 'carl@example.com', 'h5', 'Carl', NULL, 'NO', '2026-11-01T08:00:00Z');
    INSERT INTO subscriptions (contact_id, list, consent, consented_at, source) VALUES (1, 'the-source', 'c', '2021-03-04T10:15:00Z', 'mailchimp-import');
    INSERT INTO sends (id, key, list, kind, subject, from_addr, html, content_hash, links) VALUES (1, 'the-source-20', 'the-source', 'live', 'S', 'a@news.test', '<p>x</p>', 'x', '[]');
    INSERT INTO deliveries (send_id, contact_id, token, status) VALUES
      (1, 1, '${'1'.repeat(32)}', 'sent'), (1, 2, '${'2'.repeat(32)}', 'sent'),
      (1, 6, '${'6'.repeat(32)}', 'sent'), (1, 7, '${'7'.repeat(32)}', 'sent');
    UPDATE deliveries SET status = 'failed', error = '{"message":"Address blacklisted: bo@example.com"}' WHERE contact_id = 2;
  `);
  return db;
}

test('0003 keeps every contact, column and unique index, and never hands out an id a delivery used', () => {
  const db = current();
  const shapeBefore = shape(db);
  const contactsBefore = db.prepare('SELECT * FROM contacts ORDER BY id').all();
  db.exec(migration('0003_data.sql'));

  assert.equal(shape(db), shapeBefore);
  assert.match(db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'contacts'`).get()!.sql as string, /AUTOINCREMENT/);
  assert.deepEqual(db.prepare('SELECT * FROM contacts ORDER BY id').all(), contactsBefore);
  assert.throws(() => db.exec(`INSERT INTO contacts (email, email_hash) VALUES ('anna@example.com', 'hx')`), /UNIQUE/);
  assert.throws(() => db.exec(`INSERT INTO contacts (email, email_hash) VALUES ('new@example.com', 'h1')`), /UNIQUE/);

  // 6 and 7 belong to people who left; their old links must never reach someone new.
  db.exec(`INSERT INTO contacts (email, email_hash) VALUES ('dana@example.com', 'h8')`);
  assert.equal(db.prepare(`SELECT id FROM contacts WHERE email = 'dana@example.com'`).get()!.id, 8);
  db.exec(`DELETE FROM contacts WHERE id = 8; INSERT INTO contacts (email, email_hash) VALUES ('erik@example.com', 'h9')`);
  assert.equal(db.prepare(`SELECT id FROM contacts WHERE email = 'erik@example.com'`).get()!.id, 9);
  assert.match(db.prepare(`SELECT created_at FROM contacts WHERE id = 9`).get()!.created_at as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(db.prepare(`SELECT error FROM deliveries WHERE error IS NOT NULL`).all().map(r => r.error), ['text removed'], 'an old SES text named the recipient');
});

test('0003 on an empty database still starts ids at 1', () => {
  const db = new DatabaseSync(':memory:');
  for (const f of before) db.exec(migration(f));
  db.exec(migration('0003_data.sql'));
  db.exec(`INSERT INTO contacts (email, email_hash) VALUES ('a@example.com', 'h')`);
  assert.equal(db.prepare('SELECT id FROM contacts').get()!.id, 1);
});

test('the soft-bounce count in the SES webhook and the sends side by side read by index, not whole tables', () => {
  const db = new DatabaseSync(':memory:');
  for (const f of [...before, '0003_data.sql', '0004_auth.sql', '0005_stats_lists.sql']) db.exec(migration(f));
  const latest = `SELECT id, key, list, kind, subject, created_at FROM sends WHERE (?1 IS NULL OR list = ?1) AND (?2 OR kind != 'test') ORDER BY id DESC LIMIT ?3`;
  for (const sql of [
    `SELECT COUNT(DISTINCT e.delivery_id) AS n FROM events e JOIN deliveries x ON x.id = e.delivery_id
      WHERE e.type = 'soft-bounce' AND e.detail = 'MailboxFull' AND x.contact_id = ? AND e.at > ?`,
    `SELECT d.send_id, e.type, COUNT(DISTINCT CASE WHEN e.type != 'click' OR e.machine = 0 THEN e.delivery_id END) AS n
      FROM deliveries d JOIN events e ON e.delivery_id = d.id WHERE d.send_id IN (SELECT id FROM (${latest})) GROUP BY d.send_id, e.type`,
  ]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => r.detail as string);
    assert.ok(!plan.some(p => /^SCAN (e|d|x|deliveries|events)\b/.test(p)), plan.join('\n'));
  }
});

// review: the newest contact leaves, the next sign-up got their id, and the old mail then acted on the new person.
test('an old unsubscribe link never reaches the person who signed up after its owner left', async () => {
  ses = fakeSes();
  const env = testEnv();
  const oneClick = (t: string) => new Request(`https://news.test/u/${t}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'c', contacts: [{ email: 'old1@example.com' }, { email: 'old2@example.com' }], suppressions: [] }), env);
  await subscribe(env, { email: 'carl@example.com', list: 'the-source', consent: 'x', source: 'web' });
  await handle(admin('/admin/sends', { key: 'the-source-23', list: 'the-source', kind: 'live', subject: 'S', html: '<p>Hi</p><a href="https://example.com/x">x</a><a href="*|UNSUB|*">u</a>' }), env);
  await handle(admin('/admin/sends/the-source-23/batch', { max: 10 }), env);
  const [carl] = await rows(env, `SELECT c.id, d.token FROM deliveries d JOIN contacts c ON c.id = d.contact_id WHERE c.email = 'carl@example.com'`);

  await handle(oneClick(carl.token as string), env);
  await subscribe(env, { email: 'dana@example.com', list: 'the-source', consent: 'x', source: 'web' });
  const [dana] = await rows(env, `SELECT id FROM contacts WHERE email = 'dana@example.com'`);
  assert.notEqual(dana.id, carl.id);

  // Carl presses unsubscribe again in his old mail, and clicks a link in it.
  await handle(oneClick(carl.token as string), env);
  await handle(new Request(`https://news.test/c/${carl.token}/0`), env);
  assert.equal((await rows(env, `SELECT COUNT(*) AS n FROM subscriptions s JOIN contacts c ON c.id = s.contact_id WHERE c.email = 'dana@example.com'`))[0].n, 1);
  assert.deepEqual(await rows(env, `SELECT COUNT(*) AS n FROM deliveries d JOIN contacts c ON c.id = d.contact_id WHERE d.token = ?`, carl.token), [{ n: 0 }]);
});
