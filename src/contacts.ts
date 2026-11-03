// Who is on which list: imports, sign-ups, and taking addresses off.
import { isList } from './config.ts';
import type { Env } from './env.ts';
import { HttpError, iso, normalizeEmail, sha256 } from './util.ts';

type Scope = string;  // a list id, or '*' for every list
type Reason = 'unsubscribe' | 'bounce' | 'complaint' | 'mailchimp-unsubscribed' | 'mailchimp-cleaned' | 'manual';

// Bounces and spam complaints count for every list; leaving a list counts for that list.
const global: Reason[] = ['bounce', 'complaint', 'mailchimp-cleaned'];

// list_changes counts, per day and list, who joined and who left (migrations/0005). Counts only.
// Each statement runs before the change it counts, in the same batch, and counts only a real change.
export function joinedStatement(db: D1Database, list: string, email: string, hash: string, day: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO list_changes (day, list, joined) SELECT ?1, ?2, 1
    WHERE NOT EXISTS (SELECT 1 FROM subscriptions s JOIN contacts c ON c.id = s.contact_id WHERE c.email = ?3 AND s.list = ?2)
      AND NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.email_hash = ?4 AND x.scope IN (?2, '*'))
    ON CONFLICT (day, list) DO UPDATE SET joined = joined + 1`).bind(day, list, email, hash);
}

// Suppresses the hash, then deletes the address from the lists the scope covers,
// and the address itself once it is on no list. `at` keeps the original time, e.g. an import's UNSUB_TIME.
export function forgetStatements(db: D1Database, hash: string, scope: Scope, reason: Reason, at: string | null = null): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT OR IGNORE INTO suppressions (email_hash, scope, reason, created_at)
      VALUES (?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`).bind(hash, scope, reason, at),
    db.prepare(`INSERT INTO list_changes (day, list, departed) SELECT strftime('%Y-%m-%d', 'now'), s.list, 1 FROM subscriptions s
      WHERE s.contact_id = (SELECT id FROM contacts WHERE email_hash = ?1) AND (?2 = '*' OR s.list = ?2)
      ON CONFLICT (day, list) DO UPDATE SET departed = departed + 1`).bind(hash, scope),
    db.prepare(`DELETE FROM subscriptions WHERE contact_id = (SELECT id FROM contacts WHERE email_hash = ?) AND (? = '*' OR list = ?)`).bind(hash, scope, scope),
    db.prepare('DELETE FROM contacts WHERE email_hash = ? AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE contact_id = contacts.id)').bind(hash),
  ];
}

export async function forget(env: Env, email: string, scope: Scope, reason: Reason) {
  const e = normalizeEmail(email);
  if (e) await env.DB.batch(forgetStatements(env.DB, await sha256(e), scope, reason));
}

interface ImportBody {
  list: string;
  source: string;
  consent: string;
  contacts: { email: string; firstName?: string; lastName?: string; consentedAt?: string }[];
  suppressions: { email: string; reason: Reason; at?: string | null }[];
}

// Bulk import, e.g. from Mailchimp. A suppressed address is never subscribed, so an
// old export cannot bring back someone who left. Running the same import twice changes nothing.
export async function importContacts(env: Env, body: ImportBody, now = new Date()) {
  const { list } = body;
  if (!isList(env.CONFIG, list)) throw new HttpError(400, 'invalid_list');
  if (typeof body.source !== 'string' || typeof body.consent !== 'string' || !body.source || !body.consent) throw new HttpError(400, 'invalid_consent');
  const result = { subscribed: 0, already: 0, suppressed: 0, skipped: 0 };

  // A whole export's suppressions come in one request, and D1 allows 1,000 queries per request (a batch
  // counts as one). So: hash every row, read conflicts in chunks, write in batches.
  const rows: { hash: string; scope: Scope; reason: Reason; at: string | null }[] = [];
  for (const s of body.suppressions ?? []) {
    const email = normalizeEmail(s.email);
    if (email) rows.push({ hash: await sha256(email), scope: global.includes(s.reason) ? '*' : list, reason: s.reason, at: s.at ?? null });
  }
  // Someone who left in Mailchimp and then signed up again on a form of ours gave the newer answer.
  const signups = new Map<string, { list: string; consented_at: string }[]>();
  const dated = [...new Set(rows.filter(r => r.at).map(r => r.hash))];
  for (let i = 0; i < dated.length; i += 89) {
    const chunk = dated.slice(i, i + 89);  // with the source, 90 parameters: under D1's 100
    const found = await env.DB.prepare(`SELECT c.email_hash AS hash, s.list, s.consented_at FROM subscriptions s JOIN contacts c ON c.id = s.contact_id
      WHERE s.source != ?1 AND c.email_hash IN (${chunk.map((_, j) => `?${j + 2}`).join(', ')})`)
      .bind(body.source, ...chunk).all<{ hash: string; list: string; consented_at: string }>();
    for (const f of found.results) signups.set(f.hash, [...signups.get(f.hash) ?? [], f]);
  }
  const newer = (r: typeof rows[number]) => !!r.at && !!signups.get(r.hash)?.some(s => (r.scope === '*' || s.list === r.scope) && s.consented_at > r.at!);
  const forget = rows.filter(r => !newer(r));
  for (let i = 0; i < forget.length; i += 100) {
    const results = await env.DB.batch(forget.slice(i, i + 100).flatMap(r => forgetStatements(env.DB, r.hash, r.scope, r.reason, r.at)));
    // Four statements a row; the first is the suppression, and changes 0 when it was there already.
    for (let j = 0; j < results.length; j += 4) result.suppressed += results[j].meta.changes;
  }

  const blocked = new Set((await env.DB.prepare(`SELECT email_hash FROM suppressions WHERE scope IN (?, '*')`).bind(list).all<{ email_hash: string }>()).results.map(r => r.email_hash));
  const statements: D1PreparedStatement[] = [];
  for (const c of body.contacts ?? []) {
    const email = normalizeEmail(c.email);
    const hash = email && await sha256(email);
    if (!email || !hash || blocked.has(hash)) { result.skipped++; continue; }
    const consentedAt = c.consentedAt || iso(now);
    statements.push(
      // A name goes into every greeting, so a name a bot typed into an old form ("Win at http://…") is dropped.
      env.DB.prepare(`INSERT INTO contacts (email, email_hash, first_name, last_name) VALUES (?, ?, ?, ?)
        ON CONFLICT (email) DO UPDATE SET first_name = COALESCE(excluded.first_name, contacts.first_name), last_name = COALESCE(excluded.last_name, contacts.last_name)`)
        .bind(email, hash, firstName(c.firstName), firstName(c.lastName)),
      // Growth counts each person on the day they signed up, as the export says.
      joinedStatement(env.DB, list, email, hash, consentedAt.slice(0, 10)),
      env.DB.prepare(`INSERT OR IGNORE INTO subscriptions (contact_id, list, consent, consented_at, source) SELECT id, ?, ?, ?, ? FROM contacts WHERE email = ?`)
        .bind(list, body.consent, consentedAt, body.source, email),
    );
  }
  // Three statements a contact; the third is the subscription.
  for (let i = 0; i < statements.length; i += 210) {
    const results = await env.DB.batch(statements.slice(i, i + 210));
    for (let j = 2; j < results.length; j += 3) results[j].meta.changes ? result.subscribed++ : result.already++;
  }
  return result;
}

export interface Signup {
  email: string;
  list: string;        // a list id from the config
  firstName?: string | null;
  country?: string | null;
  consent: string;     // id of the consent text the person saw
  source?: string;     // where the form was, e.g. ftw-web
}

// A first name goes into the greeting of every mail, so it is letters, spaces, hyphens and apostrophes:
// no markup, address, link or phone number.
export function firstName(name: unknown): string | null {
  const n = typeof name === 'string' ? name.trim().normalize('NFC') : '';
  return n.length <= 40 && /^\p{L}[\p{L}\p{M} '’-]*$/u.test(n) ? n : null;
}

// A sign-up someone made on a form. Until sign-ups are confirmed by mail (double opt-in), anyone can
// type anyone's address, so a sign-up only adds: it never lifts a suppression (someone who left and
// wants back writes to support), never changes a known contact, and never rewrites the consent of an
// existing subscription. A name that is not a name is dropped. The answer is the same in every case,
// so the form does not reveal who is on a list.
export async function subscribe(env: Env, s: Signup, now = new Date()): Promise<{ ok: true }> {
  const { list } = s;
  if (!isList(env.CONFIG, list)) throw new Error('invalid_list');
  const source = typeof s.source === 'string' && /^[a-z0-9-]{1,40}$/.test(s.source) ? s.source : 'form';
  const email = normalizeEmail(s.email);
  if (!email) throw new Error('invalid_email');
  if (typeof s.consent !== 'string' || !s.consent || s.consent.length > 64) throw new Error('invalid_consent');
  const country = typeof s.country === 'string' && /^[A-Z]{2}$/.test(s.country) ? s.country : null;
  const hash = await sha256(email);
  // One batch whatever the address, with the suppression checked in each insert: a suppressed
  // address takes as long as a new one, so the time of the answer tells nothing either.
  const free = `NOT EXISTS (SELECT 1 FROM suppressions WHERE email_hash = ?2 AND scope IN (?3, '*'))`;
  await env.DB.batch([
    joinedStatement(env.DB, list, email, hash, iso(now).slice(0, 10)),
    env.DB.prepare(`INSERT INTO contacts (email, email_hash, first_name, country) SELECT ?1, ?2, ?4, ?5 WHERE ${free} ON CONFLICT DO NOTHING`)
      .bind(email, hash, list, firstName(s.firstName), country),
    env.DB.prepare(`INSERT INTO subscriptions (contact_id, list, consent, consented_at, source) SELECT id, ?3, ?4, ?5, ?6 FROM contacts WHERE email = ?1 AND ${free}
      ON CONFLICT DO NOTHING`).bind(email, hash, list, s.consent, iso(now), source),
  ]);
  return { ok: true };
}
