// Creating a send, sending it in batches, and counting what happened.
import { isList } from './config.ts';
import { firstName } from './contacts.ts';
import type { Env } from './env.ts';
import { hasUnsubscribeLink, mailWarnings, render, stripComments, toText, trackedLinks } from './render.ts';
import { sendEmail, SesError, type Mail } from './ses.ts';
import { HttpError, iso, normalizeEmail, sha256 } from './util.ts';

type Kind = 'live' | 'resend' | 'test';

export interface SendRow {
  id: number;
  key: string;
  list: string;
  kind: Kind;
  subject: string;
  from_addr: string;
  reply_to: string | null;
  html: string;
  links: string;
  fname_fallback: string;
  test_name: string | null;  // a test's first name (--fname); a test never changes a contact's own
}

interface CreateBody {
  key: string;
  list: string;
  kind: Kind;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
  fnameFallback?: string;
  testTo?: { email: string; firstName?: string }[];  // kind test
  parent?: string;                                    // kind resend: the key of the live send
  afterDays?: number;                                 // kind resend: wait this long after the parent went out
  dryRun?: boolean;
}

const stuckAfterMs = 10 * 60 * 1000;

// Contact ids a send goes to. ?2 is the list, ?3 the parent send (resend only).
// The suppression check repeats at send time, so someone who leaves meanwhile is skipped.
const notSuppressed = `NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.email_hash = c.email_hash AND x.scope IN (?2, '*'))`;
const audiences: Record<Kind, string> = {
  live: `SELECT c.id FROM subscriptions s JOIN contacts c ON c.id = s.contact_id WHERE s.list = ?2 AND ${notSuppressed}`,
  // Those who got the parent and did nothing with it: no open, click, bounce, complaint or unsubscribe,
  // machine or not. Nor anyone an earlier resend of the same parent reached: one resend each, at most.
  resend: `SELECT c.id FROM deliveries d JOIN contacts c ON c.id = d.contact_id
    JOIN subscriptions s ON s.contact_id = c.id AND s.list = ?2
    WHERE d.send_id = ?3 AND d.status = 'sent' AND ${notSuppressed}
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.delivery_id = d.id AND e.type IN ('open', 'click', 'bounce', 'soft-bounce', 'complaint', 'unsubscribe'))
      AND NOT EXISTS (SELECT 1 FROM deliveries r JOIN sends rs ON rs.id = r.send_id WHERE rs.parent_id = ?3 AND rs.kind = 'resend' AND r.contact_id = c.id)`,
  // A test goes out even if the address left the list, but never to a bounce or a complaint.
  test: `SELECT c.id FROM contacts c WHERE c.email IN (SELECT value FROM json_each(?3))
    AND NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.email_hash = c.email_hash AND x.scope = '*')`,
};

export async function createSend(env: Env, body: CreateBody, now = new Date()) {
  const { key, list, kind, subject } = body;
  if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(key)) throw new HttpError(400, 'invalid_key');
  if (!isList(env.CONFIG, list)) throw new HttpError(400, 'invalid_list');
  if (env.CONFIG.lists[list].adhoc?.deleted) throw new HttpError(400, 'list_deleted');
  if (!Object.hasOwn(audiences, kind)) throw new HttpError(400, 'invalid_kind');
  if (typeof body.html !== 'string' || !body.html.trim()) throw new HttpError(400, 'invalid_html');
  // Every mail to a list carries a link off it, in the body as well as the List-Unsubscribe header.
  // A test may go without, so a draft can be tried before its footer is done.
  if (kind !== 'test' && !hasUnsubscribeLink(body.html)) throw new HttpError(400, 'no_unsubscribe_link: the HTML needs a link to *|UNSUB|*');
  // A line break in a subject would start a new header.
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200 || /\p{Cc}/u.test(subject)) throw new HttpError(400, 'invalid_subject');
  // A resend goes to those who did not open. Without the pixel that is everyone, and they would get it twice.
  if (kind === 'resend' && !env.CONFIG.lists[list].opens) throw new HttpError(400, `resend_needs_opens: ${list} has no open pixel, so a resend would go to everyone again`);
  const html = stripComments(body.html);
  const links = trackedLinks(html);
  const contentHash = await sha256(JSON.stringify([list, kind, subject, html, body.parent ?? null]));

  const existing = await env.DB.prepare('SELECT id, content_hash FROM sends WHERE key = ?').bind(key).first<{ id: number; content_hash: string }>();
  if (existing) {
    if (existing.content_hash !== contentHash) throw new HttpError(409, 'send_exists_with_other_content');
    const recipients = await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE send_id = ?').bind(existing.id).first<number>('n');
    return { key, existing: true, recipients, links };
  }

  // The third parameter: the parent send's id for a resend, the test addresses for a test.
  let third: number | string | null = null;
  const testTo = (body.testTo ?? []).map(t => ({ email: normalizeEmail(t.email), firstName: t.firstName?.trim() || null }));
  let testName: string | null = null;
  if (kind === 'test') {
    if (!testTo.length || testTo.some(t => !t.email)) throw new HttpError(400, 'invalid_test_address');
    third = JSON.stringify(testTo.map(t => t.email));
    // One name for the whole test (the CLI's --fname); it is kept on the send, not on any contact.
    const given = testTo.find(t => t.firstName)?.firstName;
    testName = given ? firstName(given) : null;
    if (given && !testName) throw new HttpError(400, 'invalid_first_name');
  }
  let parentId: number | null = null;
  if (kind === 'resend') {
    const parent = await env.DB.prepare(`SELECT s.id, s.list, s.kind, MAX(d.sent_at) AS last_sent FROM sends s LEFT JOIN deliveries d ON d.send_id = s.id AND d.status = 'sent' WHERE s.key = ?`)
      .bind(body.parent ?? '').first<{ id: number | null; list: string; kind: Kind; last_sent: string | null }>();
    if (!parent?.id || parent.kind !== 'live' || parent.list !== list) throw new HttpError(400, 'invalid_parent');
    if (!parent.last_sent) throw new HttpError(409, 'parent_not_sent');
    const due = new Date(Date.parse(parent.last_sent) + (body.afterDays ?? 3) * 86_400_000);
    if (now < due) throw new HttpError(409, `too_early: not before ${iso(due)}`);
    parentId = third = parent.id;
  }

  const audience = audiences[kind];
  // ?1 is the send's key; a live audience has no third parameter, and SQLite refuses extra ones.
  const params = kind === 'live' ? [key, list] : [key, list, third];
  const meta = env.CONFIG.lists[list];
  const fallback = body.fnameFallback ?? meta.fname ?? 'there';
  // A list a colleague made takes its sender from the config's adhoc section, which may be gone.
  if (!(body.from ?? meta.from)) throw new HttpError(400, 'no_sender: the config names no sender for this list');

  if (body.dryRun) {
    const recipients = await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${audience})`).bind(...params).first<number>('n');
    const excluded = kind === 'live'
      ? await env.DB.prepare(`SELECT COUNT(*) AS n FROM subscriptions s JOIN contacts c ON c.id = s.contact_id WHERE s.list = ?2 AND NOT ${notSuppressed}`).bind(key, list).first<number>('n')
      : 0;
    const first = await env.DB.prepare(`SELECT c.email, c.first_name FROM contacts c WHERE c.id IN (${audience}) ORDER BY c.id LIMIT 1`).bind(...params).first<{ email: string; first_name: string | null }>();
    const sample = { email: first?.email ?? testTo[0]?.email ?? 'someone@example.com', first_name: first?.first_name ?? null };
    const draft: SendRow = { id: 0, key, list, kind, subject, from_addr: body.from ?? meta.from, reply_to: body.replyTo ?? meta.replyTo ?? null, html, links: JSON.stringify(links), fname_fallback: fallback, test_name: testName };
    const token = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    const mail = mailFor(env, draft, { ...sample, token });
    return { key, dryRun: true, recipients, excluded, links, bytes: new TextEncoder().encode(mail.html).length, warnings: mailWarnings(html, mail.html), sample: mail };
  }

  // A test address needs a contact row for its delivery. A known one stays as it is, and a bounced or
  // complaining address is not stored again: the test audience leaves it out anyway.
  const statements: D1PreparedStatement[] = [];
  for (const t of testTo) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO contacts (email, email_hash) SELECT ?1, ?2
      WHERE NOT EXISTS (SELECT 1 FROM suppressions WHERE email_hash = ?2 AND scope = '*')`).bind(t.email, await sha256(t.email!)));
  }
  statements.push(
    env.DB.prepare(`INSERT INTO sends (key, list, kind, parent_id, subject, from_addr, reply_to, html, content_hash, links, fname_fallback, test_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(key, list, kind, parentId, subject, body.from ?? meta.from, body.replyTo ?? meta.replyTo ?? null, html, contentHash, JSON.stringify(links), fallback, testName),
    env.DB.prepare(`INSERT INTO deliveries (send_id, contact_id, token)
      SELECT (SELECT id FROM sends WHERE key = ?1), a.id, lower(hex(randomblob(16))) FROM (${audience}) a`).bind(...params),
  );
  const results = await env.DB.batch(statements);
  return { key, existing: false, recipients: results.at(-1)!.meta.changes, links };
}

interface Recipient { email: string; first_name: string | null; token: string }

export function mailFor(env: Env, send: SendRow, r: Recipient): Mail & { to: string } {
  const base = env.PUBLIC_URL;
  const list = env.CONFIG.lists[send.list] ?? { name: send.list };
  const unsubscribeUrl = `${base}/u/${r.token}`;
  const name = send.kind === 'test' && send.test_name ? send.test_name : r.first_name;
  const urls = { firstName: name, fallback: send.fname_fallback, unsubscribeUrl, archiveUrl: `${base}/a/${send.key}` };
  // SES takes only ASCII in a header value, and RFC 2919 makes the name optional.
  const listId = `<${send.list}.${new URL(base).hostname}>`;
  const plainName = /^[\x20-\x7e]+$/.test(list.name) && !/[<>"\\]/.test(list.name);
  return {
    from: send.from_addr,
    to: r.email,
    replyTo: send.reply_to,
    subject: send.kind === 'test' ? `[Test] ${send.subject}` : send.subject,
    html: render(send.html, {
      ...urls,
      links: JSON.parse(send.links),
      clickUrl: n => `${base}/c/${r.token}/${n}`,
      openUrl: list.opens ? `${base}/o/${r.token}.gif` : undefined,
    }),
    text: toText(render(send.html, urls)),
    // RFC 8058: Gmail and Yahoo show their own unsubscribe button and POST to this URL.
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Id': plainName ? `${list.name} ${listId}` : listId,
    },
    tags: { send: send.key },
  };
}

// Sends up to `max` pending deliveries. Each row is claimed before SES is called and settled after,
// so an interrupted run picks up where it stopped. The caller paces the calls to stay under SES's rate.
export async function runBatch(env: Env, key: string, max: number, now = new Date()) {
  const send = await env.DB.prepare('SELECT * FROM sends WHERE key = ?').bind(key).first<SendRow>();
  if (!send) throw new HttpError(404, 'no_such_send');
  const limit = Math.max(1, Math.min(50, Math.floor(max) || 10));

  // A row stuck in sending means SES may or may not have the mail. Rather none than two.
  await env.DB.prepare(`UPDATE deliveries SET status = 'unknown' WHERE send_id = ? AND status = 'sending' AND claimed_at < ?`)
    .bind(send.id, iso(new Date(now.getTime() - stuckAfterMs))).run();
  const claimed = (await env.DB.prepare(`UPDATE deliveries SET status = 'sending', claimed_at = ?1
    WHERE id IN (SELECT id FROM deliveries WHERE send_id = ?2 AND status = 'pending' ORDER BY id LIMIT ?3) RETURNING id`)
    .bind(iso(now), send.id, limit).all<{ id: number }>()).results.map(r => r.id);

  const result = { sent: 0, skipped: 0, failed: 0, retry: 0, pending: 0, unknown: 0, sending: 0 };
  let stop = null as string | null;  // why the send stops; set in the callbacks below
  if (claimed.length) {
    const recipients = (await env.DB.prepare(`SELECT d.id, d.token, d.error, c.email, c.first_name,
        CASE WHEN c.id IS NULL THEN 0
          WHEN EXISTS (SELECT 1 FROM suppressions x WHERE x.email_hash = c.email_hash AND (x.scope = '*' OR (x.scope = ?1 AND ?2 != 'test'))) THEN 0
          WHEN ?2 = 'test' THEN 1
          WHEN EXISTS (SELECT 1 FROM subscriptions s WHERE s.contact_id = c.id AND s.list = ?1) THEN 1
          ELSE 0 END AS ok
      FROM deliveries d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.id IN (${claimed.map((_, i) => `?${i + 3}`).join(', ')})`)
      .bind(send.list, send.kind, ...claimed).all<Recipient & { id: number; ok: number; error: string | null }>()).results;

    // Each row is settled as soon as SES answers, so a Worker that stops halfway leaves only the mails
    // in flight in sending. A settle that fails three times leaves its row in sending too: it turns
    // unknown, and SES's delivery event, once it comes, marks it sent (app.ts).
    const settle = async (sql: string, ...params: (string | number | null)[]) => {
      for (let attempt = 1; ; attempt++) {
        try {
          await env.DB.prepare(sql).bind(...params).run();
          return;
        } catch (error) {
          if (attempt === 3) {
            console.error(JSON.stringify({ event: 'settle_failed', key, message: String(error).slice(0, 200) }));
            return;
          }
        }
      }
    };
    const refused: { id: number; type: string; again: boolean }[] = [];
    await Promise.all(recipients.map(async r => {
      if (!r.ok) {
        result.skipped++;
        return settle(`UPDATE deliveries SET status = 'skipped' WHERE id = ?`, r.id);
      }
      let messageId: string;
      try {
        messageId = await sendEmail(env, mailFor(env, send, r));
      } catch (error) {
        // The Worker's own limit on outgoing requests: this one never left, and nor will the next.
        const local = !(error instanceof SesError) && /too many subrequests/i.test(String(error));
        const ses = error instanceof SesError ? error : local ? new SesError(0, 'SubrequestLimit') : null;
        // No answer at all: the request may have reached SES. Unsure, like a 5xx.
        const outcome = ses?.outcome ?? 'unsure';
        const why = ses?.message ?? 'network';
        if (outcome === 'recipient') {
          result.failed++;
          refused.push({ id: r.id, type: ses!.type, again: r.error === why });
          return settle(`UPDATE deliveries SET status = 'failed', error = ? WHERE id = ?`, why, r.id);
        }
        // Rather none than two: a person checks and decides (retry-unknown).
        if (outcome === 'unsure') return settle(`UPDATE deliveries SET status = 'unknown', error = ? WHERE id = ?`, why, r.id);
        if (outcome === 'account') stop ??= why;
        else result.retry++;
        return settle(`UPDATE deliveries SET status = 'pending', claimed_at = NULL, error = ? WHERE id = ?`, why, r.id);
      }
      result.sent++;
      return settle(`UPDATE deliveries SET status = 'sent', message_id = ?, sent_at = ?, error = NULL WHERE id = ?`, messageId, iso(now), r.id);
    }));
    // SES refused every mail of a batch for the same reason: that is the sender, the account or the
    // content, not the readers (a From SES cannot parse, say). Those rows go back in line, and the send
    // stops. Once only: rows SES refused the same way before stay failed, so a send whose cause
    // lasts (content SES will not take) does not stop on them for ever, nor hold up the sends after it.
    const tried = recipients.filter(r => r.ok).length;
    if (!stop && refused.length >= 3 && refused.length === tried && new Set(refused.map(f => f.type)).size === 1 && !refused.every(f => f.again)) {
      await env.DB.prepare(`UPDATE deliveries SET status = 'pending', claimed_at = NULL WHERE status = 'failed' AND id IN (${refused.map(() => '?').join(', ')})`)
        .bind(...refused.map(f => f.id)).run();
      stop = `${refused[0].type || 'HTTP'} for every mail in a batch`;
    }
  }
  // The key, the account or a setting is wrong: every other row would fail the same way, so stop
  // here with the rows back in pending, and let a person fix it and resume.
  if (stop) throw new HttpError(502, `ses_account_error: ${stop}`);

  for (const row of (await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM deliveries WHERE send_id = ? AND status IN ('pending', 'unknown', 'sending') GROUP BY status`)
    .bind(send.id).all<{ status: 'pending' | 'unknown' | 'sending'; n: number }>()).results) result[row.status] = row.n;
  return result;
}

export async function retryUnknown(env: Env, key: string) {
  const r = await env.DB.prepare(`UPDATE deliveries SET status = 'pending', claimed_at = NULL
    WHERE status = 'unknown' AND send_id = (SELECT id FROM sends WHERE key = ?)`).bind(key).run();
  return { requeued: r.meta.changes };
}

// Failed rows are those SES refused, so none of them went out. Once the cause is fixed (an unverified
// sender, say), they can go again.
export async function retryFailed(env: Env, key: string) {
  const r = await env.DB.prepare(`UPDATE deliveries SET status = 'pending', claimed_at = NULL, error = NULL
    WHERE status = 'failed' AND send_id = (SELECT id FROM sends WHERE key = ?)`).bind(key).run();
  return { requeued: r.meta.changes };
}

// One send's numbers. Opens and clicks are counted for people (unique mails, total events), for
// mails only machines touched (a scanner, Apple's privacy proxy: src/tracking.ts), and for any.
// Rates are of mails sent, as fractions; null when nothing was sent.
export async function stats(env: Env, key: string) {
  const send = await env.DB.prepare('SELECT id, key, list, kind, subject, links, created_at FROM sends WHERE key = ?').bind(key)
    .first<{ id: number; key: string; list: string; kind: Kind; subject: string; links: string; created_at: string }>();
  if (!send) throw new HttpError(404, 'no_such_send');
  const status: Record<string, number> = {};
  let recipients = 0;
  for (const r of (await env.DB.prepare('SELECT status, COUNT(*) AS n FROM deliveries WHERE send_id = ? GROUP BY status ORDER BY status').bind(send.id).all<{ status: string; n: number }>()).results) {
    status[r.status] = r.n;
    recipients += r.n;
  }
  // unique and total: people; machine: mails only machines touched; any: unique + machine.
  type Count = { unique: number; total: number; machine: number; any: number };
  const counted = `SUM(e.machine = 0) AS total, COUNT(DISTINCT CASE WHEN e.machine = 0 THEN e.delivery_id END) AS uniq, COUNT(DISTINCT e.delivery_id) AS any`;
  const count = (r?: { total: number; uniq: number; any: number }): Count =>
    ({ unique: r?.uniq ?? 0, total: r?.total ?? 0, machine: (r?.any ?? 0) - (r?.uniq ?? 0), any: r?.any ?? 0 });
  const events = new Map((await env.DB.prepare(`SELECT e.type, ${counted}
      FROM events e JOIN deliveries d ON d.id = e.delivery_id WHERE d.send_id = ? GROUP BY e.type`).bind(send.id)
    .all<{ type: string; total: number; uniq: number; any: number }>()).results.map(r => [r.type, r]));
  const urls: string[] = JSON.parse(send.links);
  const clicks = new Map((await env.DB.prepare(`SELECT e.link, ${counted}
      FROM events e JOIN deliveries d ON d.id = e.delivery_id WHERE d.send_id = ? AND e.type = 'click' GROUP BY e.link`).bind(send.id)
    .all<{ link: number; total: number; uniq: number; any: number }>()).results.map(r => [r.link, r]));
  const once = (type: string) => events.get(type)?.any ?? 0;
  const sent = status.sent ?? 0;
  const opens = count(events.get('open')), clickCount = count(events.get('click'));
  const share = (part: number, whole: number) => whole ? Math.round(10_000 * part / whole) / 10_000 : null;
  return {
    key: send.key, list: send.list, kind: send.kind, subject: send.subject, created_at: send.created_at,
    recipients, status,
    delivered: once('delivery'),
    bounced: once('bounce'),
    softBounced: once('soft-bounce'),
    complaints: once('complaint'),
    unsubscribed: once('unsubscribe'),
    opens, clicks: clickCount,
    rates: {
      delivered: share(once('delivery'), sent),
      open: share(opens.any, sent),                 // any open, Apple's proxy too: what most tools report
      openPeople: share(opens.unique, sent),        // without Apple's proxy and scanners
      click: share(clickCount.unique, sent),        // people only
      clickToOpen: share(clickCount.unique, opens.any),
      unsubscribe: share(once('unsubscribe'), sent),
      bounce: share(once('bounce'), sent),
      complaint: share(once('complaint'), sent),
    },
    links: urls.map((url, n) => ({ n, url, ...count(clicks.get(n)) })),
  };
}
