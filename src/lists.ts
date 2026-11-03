// Lists a colleague makes through an assistant, for a mailing to people they name: an event's
// guests, a group of partners. They live in D1 beside the config's lists. Once withLists has put
// them into env.CONFIG for a request, the rest of Utskick treats them as lists like any other:
// every mail needs an unsubscribe link, suppressions hold, and an admin approves each send.
//
// An assistant can add people and take them off. It never reads who is on a list: every answer
// here is a count. People join a config list (a newsletter) only themselves, through a form.
import { firstName, joinedStatement } from './contacts.ts';
import type { Env } from './env.ts';
import { isAdmin } from './identity.ts';
import type { Grant } from './oauth.ts';
import { HttpError, iso, normalizeEmail, sha256 } from './util.ts';

interface ListRow { id: string; name: string; purpose: string; reply_to: string; deleted_at: string | null }

const idPattern = /^[a-z0-9][a-z0-9-]{1,39}$/;
const maxPeople = 500;

let warned = false;

export async function withLists(env: Env): Promise<Env> {
  let rows: ListRow[];
  try {
    rows = (await env.DB.prepare('SELECT id, name, purpose, reply_to, deleted_at FROM lists').all<ListRow>()).results;
  } catch (error) {
    // Before migration 0005 there is no table: readers' links and sign-ups go on with the config's lists.
    if (!warned) console.error(JSON.stringify({ event: 'lists_unreadable', message: String(error).slice(0, 200) }));
    warned = true;
    return env;
  }
  if (!rows.length) return env;
  const a = env.CONFIG.adhoc;
  const lists = { ...env.CONFIG.lists };
  for (const r of rows) {
    // A config list given the same id later wins: the config is the installation's own word. Say so,
    // since the people a colleague named are then on a newsletter.
    if (Object.hasOwn(lists, r.id)) {
      if (r.deleted_at === null) console.error(JSON.stringify({ event: 'list_id_clash', list: r.id }));
      continue;
    }
    lists[r.id] = {
      name: r.name, from: a?.from ?? '', replyTo: r.reply_to, opens: !!a?.opens, fname: a?.fname ?? 'there',
      adhoc: { purpose: r.purpose, deleted: r.deleted_at !== null, owner: r.reply_to },
    };
  }
  return { ...env, CONFIG: { ...env.CONFIG, lists } };
}

// A list of the assistant's own kind, still open, that the person behind the grant made (or an
// admin), or why not. Members share drafts, but not each other's lists of people.
function adhocList(env: Env, grant: Grant, id: unknown): string {
  if (typeof id !== 'string' || !Object.hasOwn(env.CONFIG.lists, id)) throw new HttpError(404, 'No such list. subscriber_counts lists them.');
  const l = env.CONFIG.lists[id];
  if (!l.adhoc) throw new HttpError(403, `${id} is a newsletter from the config. People join it themselves, through a form; an assistant cannot add or remove them.`);
  if (l.adhoc.deleted) throw new HttpError(410, `${id} was deleted.`);
  if (l.adhoc.owner !== grant.subject && !isAdmin(env.CONFIG, grant.subject)) throw new HttpError(403, `${id} belongs to the colleague who made it. Only they, or an admin, can change it.`);
  return id;
}

const plain = (v: unknown, min: number, max: number) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max && !/\p{Cc}/u.test(v);

export async function createList(env: Env, grant: Grant, a: Record<string, unknown>, now = new Date()) {
  const adhoc = env.CONFIG.adhoc;
  if (!adhoc?.from) throw new HttpError(400, 'Lists made through an assistant are off here: the config has no adhoc section with a sender.');
  const { id } = a;
  if (typeof id !== 'string' || !idPattern.test(id)) throw new HttpError(400, 'id must be lowercase letters, digits and hyphens, 2 to 40 of them, e.g. partner-day-2026.');
  // Taken: a list now, or one that ever had people, suppressions or sends under this id.
  const used = Object.hasOwn(env.CONFIG.lists, id) || await env.DB.prepare(`SELECT 1 FROM lists WHERE id = ?1 UNION ALL SELECT 1 FROM subscriptions WHERE list = ?1
      UNION ALL SELECT 1 FROM suppressions WHERE scope = ?1 UNION ALL SELECT 1 FROM sends WHERE list = ?1 LIMIT 1`).bind(id).first();
  if (used) throw new HttpError(409, `There is, or was, a list ${id} already. Pick another id.`);
  if (!plain(a.name, 1, 80)) throw new HttpError(400, 'name must be 1 to 80 characters. Readers see it on the unsubscribe page.');
  if (!plain(a.purpose, 10, 500)) throw new HttpError(400, 'purpose must say in 10 to 500 characters why these people get mail, e.g. "Guests who signed up for the partner day on 12 November". The admin who approves a send reads it.');
  await env.DB.prepare(`INSERT INTO lists (id, name, purpose, reply_to, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, (a.name as string).trim(), (a.purpose as string).trim(), grant.subject, grant.clientId, iso(now)).run();
  return {
    list: id, name: (a.name as string).trim(), from: adhoc.from, replyTo: grant.subject, openPixel: !!adhoc.opens,
    note: 'Add people with list_add, then write a draft for this list. Replies go to the person who made the list. Every mail needs an *|UNSUB|* link, and an admin approves each send.',
  };
}

// The addresses in a call, as given: an address, or { email, firstName }.
function people(a: Record<string, unknown>): { email: string | null; firstName: string | null }[] {
  const given = a.people;
  if (!Array.isArray(given) || !given.length || given.length > maxPeople) throw new HttpError(400, `people must list 1 to ${maxPeople} people. Call again for more.`);
  return given.map(p => typeof p === 'string'
    ? { email: normalizeEmail(p), firstName: null }
    : { email: normalizeEmail((p as Record<string, unknown>)?.email), firstName: firstName((p as Record<string, unknown>)?.firstName) });
}

// Adds people to a list of the assistant's kind. A known address keeps its name; one that bounced,
// complained or left this list is not added again. The answer counts, and never names anyone.
export async function addToList(env: Env, grant: Grant, a: Record<string, unknown>, now = new Date()) {
  const list = adhocList(env, grant, a.list);
  const result = { list, added: 0, already: 0, suppressed: 0, invalid: 0, onList: 0 };
  const seen = new Map<string, string | null>();
  for (const p of people(a)) {
    if (!p.email) result.invalid++;
    else if (!seen.has(p.email)) seen.set(p.email, p.firstName);
  }
  const rows = await Promise.all([...seen].map(async ([email, name]) => ({ email, name, hash: await sha256(email) })));
  const blocked = new Set<string>();
  for (let i = 0; i < rows.length; i += 90) {
    const chunk = rows.slice(i, i + 90);
    const found = await env.DB.prepare(`SELECT email_hash FROM suppressions WHERE scope IN (?1, '*') AND email_hash IN (${chunk.map((_, j) => `?${j + 2}`).join(', ')})`)
      .bind(list, ...chunk.map(r => r.hash)).all<{ email_hash: string }>();
    for (const f of found.results) blocked.add(f.email_hash);
  }
  const day = iso(now).slice(0, 10);
  const statements: D1PreparedStatement[] = [];
  for (const r of rows) {
    if (blocked.has(r.hash)) { result.suppressed++; continue; }
    statements.push(
      env.DB.prepare(`INSERT INTO contacts (email, email_hash, first_name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).bind(r.email, r.hash, r.name),
      joinedStatement(env.DB, list, r.email, r.hash, day),
      env.DB.prepare(`INSERT OR IGNORE INTO subscriptions (contact_id, list, consent, consented_at, source) SELECT id, ?, 'adhoc', ?, 'assistant' FROM contacts WHERE email = ?`)
        .bind(list, iso(now), r.email),
    );
  }
  // Three statements a person; the third is the subscription.
  for (let i = 0; i < statements.length; i += 210) {
    const results = await env.DB.batch(statements.slice(i, i + 210));
    for (let j = 2; j < results.length; j += 3) results[j].meta.changes ? result.added++ : result.already++;
  }
  result.onList = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE list = ?').bind(list).first<number>('n') ?? 0;
  return result;
}

// Takes people off a list, as when they were added by mistake. Nothing is suppressed: they could
// be added again. An address on no list any more is deleted.
export async function removeFromList(env: Env, grant: Grant, a: Record<string, unknown>, now = new Date()) {
  const list = adhocList(env, grant, a.list);
  const result = { list, removed: 0, notOnList: 0, invalid: 0, onList: 0 };
  const emails = new Set<string>();
  for (const p of people(a)) p.email ? emails.add(p.email) : result.invalid++;
  const day = iso(now).slice(0, 10);
  const statements = [...emails].flatMap(email => [
    env.DB.prepare(`INSERT INTO list_changes (day, list, departed) SELECT ?1, ?2, 1
      WHERE EXISTS (SELECT 1 FROM subscriptions s JOIN contacts c ON c.id = s.contact_id WHERE c.email = ?3 AND s.list = ?2)
      ON CONFLICT (day, list) DO UPDATE SET departed = departed + 1`).bind(day, list, email),
    env.DB.prepare(`DELETE FROM subscriptions WHERE list = ? AND contact_id = (SELECT id FROM contacts WHERE email = ?)`).bind(list, email),
    env.DB.prepare(`DELETE FROM contacts WHERE email = ? AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE contact_id = contacts.id)`).bind(email),
  ]);
  for (let i = 0; i < statements.length; i += 210) {
    const results = await env.DB.batch(statements.slice(i, i + 210));
    for (let j = 1; j < results.length; j += 3) results[j].meta.changes ? result.removed++ : result.notOnList++;
  }
  result.onList = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE list = ?').bind(list).first<number>('n') ?? 0;
  return result;
}

// Empties a list and closes it: everyone comes off, addresses on no other list are deleted, and a
// send that waits for approval is declined. The list's name stays, for the pages of sends made to it.
export async function deleteList(env: Env, grant: Grant, a: Record<string, unknown>, now = new Date()) {
  const list = adhocList(env, grant, a.list);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO list_changes (day, list, departed) SELECT ?1, ?2, COUNT(*) FROM subscriptions WHERE list = ?2
      ON CONFLICT (day, list) DO UPDATE SET departed = departed + excluded.departed`).bind(iso(now).slice(0, 10), list),
    env.DB.prepare(`DELETE FROM contacts WHERE id IN (SELECT contact_id FROM subscriptions WHERE list = ?1)
      AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.contact_id = contacts.id AND s.list != ?1)`).bind(list),
    env.DB.prepare('DELETE FROM subscriptions WHERE list = ?').bind(list),
    env.DB.prepare('UPDATE lists SET deleted_at = ? WHERE id = ?').bind(iso(now), list),
    env.DB.prepare(`UPDATE approvals SET status = 'declined', decided_by = 'list deleted', decided_at = ? WHERE list = ? AND status = 'pending'`).bind(iso(now), list),
  ]);
  return { list, removed: results[2].meta.changes, approvalsWithdrawn: results[4].meta.changes };
}
