// Numbers across sends and lists: how the latest sends compare, whether the sending reputation is
// healthy, and how each list grows. Counts only, as everywhere: never who. The dashboard and the
// assistants' tools read the same functions. One send's own numbers are stats() in send.ts.
import type { Env } from './env.ts';
import { iso } from './util.ts';

const share = (part: number, whole: number) => whole ? Math.round(10_000 * part / whole) / 10_000 : null;

// --------------------------------------------------------------------------
// The latest sends side by side
// --------------------------------------------------------------------------

export interface SendSummary {
  key: string; list: string; kind: string; subject: string; created_at: string;
  recipients: number; sent: number; bounced: number; opened: number; clicked: number; unsubscribed: number; complaints: number;
  rates: { open: number | null; click: number | null; unsubscribe: number | null };
}

// ?1: a list or null; ?2: test sends too; ?3: how many. Deliveries and events are read through
// their indexes, for these sends only.
export async function sendSummaries(env: Env, o: { list?: string | null; tests?: boolean; limit: number }): Promise<SendSummary[]> {
  const latest = `SELECT id, key, list, kind, subject, created_at FROM sends WHERE (?1 IS NULL OR list = ?1) AND (?2 OR kind != 'test') ORDER BY id DESC LIMIT ?3`;
  const params = [o.list ?? null, o.tests ? 1 : 0, o.limit];
  const [sends, events] = await Promise.all([
    env.DB.prepare(`SELECT s.*, COUNT(d.id) AS recipients, COALESCE(SUM(d.status = 'sent'), 0) AS sent
      FROM (${latest}) s LEFT JOIN deliveries d ON d.send_id = s.id GROUP BY s.id ORDER BY s.id DESC`).bind(...params)
      .all<Omit<SendSummary, 'bounced' | 'opened' | 'clicked' | 'unsubscribed' | 'complaints' | 'rates'> & { id: number }>(),
    // An open counts any open, as most tools do; a click counts people only.
    env.DB.prepare(`SELECT d.send_id, e.type, COUNT(DISTINCT CASE WHEN e.type != 'click' OR e.machine = 0 THEN e.delivery_id END) AS n
      FROM deliveries d JOIN events e ON e.delivery_id = d.id WHERE d.send_id IN (SELECT id FROM (${latest})) GROUP BY d.send_id, e.type`).bind(...params)
      .all<{ send_id: number; type: string; n: number }>(),
  ]);
  const counts = new Map<number, Record<string, number>>();
  for (const e of events.results) counts.set(e.send_id, { ...counts.get(e.send_id), [e.type]: e.n });
  return sends.results.map(({ id, ...s }) => {
    const e = counts.get(id) ?? {};
    return {
      ...s, bounced: e.bounce ?? 0, opened: e.open ?? 0, clicked: e.click ?? 0, unsubscribed: e.unsubscribe ?? 0, complaints: e.complaint ?? 0,
      rates: { open: share(e.open ?? 0, s.sent), click: share(e.click ?? 0, s.sent), unsubscribe: share(e.unsubscribe ?? 0, s.sent) },
    };
  });
}

// --------------------------------------------------------------------------
// Sending reputation
// --------------------------------------------------------------------------

// Amazon SES reviews an account at 5% hard bounces or 0.1% complaints, and may pause it at 10% or
// 0.5%. Gmail wants spam reports under 0.1% and never 0.3% or more; it reports those only in
// Google Postmaster Tools, not to SES, so the complaints here come from other mailbox providers.
const limits = {
  bounce: { watch: 0.02, act: 0.05 },
  complaint: { watch: 0.0005, act: 0.001 },
};
type Level = 'ok' | 'watch' | 'act';
const level = (rate: number | null, l: { watch: number; act: number }): Level => rate === null || rate < l.watch ? 'ok' : rate < l.act ? 'watch' : 'act';

// The last 30 days of live sends and resends, read through each send's deliveries.
export async function deliverability(env: Env, now = new Date()) {
  const days = 30;
  const since = iso(new Date(now.getTime() - days * 86_400_000));
  // A send made up to a week before the window may still have mailed inside it.
  const recent = `SELECT id FROM sends WHERE kind != 'test' AND created_at >= ?2`;
  const created = iso(new Date(now.getTime() - (days + 7) * 86_400_000));
  const [mail, events, suppressed] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE(SUM(d.status = 'sent' AND d.sent_at >= ?1), 0) AS sent, COALESCE(SUM(d.status = 'failed'), 0) AS failed,
        COALESCE(SUM(d.status = 'unknown'), 0) AS unknown
      FROM deliveries d WHERE d.send_id IN (${recent})`).bind(since, created).first<{ sent: number; failed: number; unknown: number }>(),
    env.DB.prepare(`SELECT e.type, COUNT(DISTINCT e.delivery_id) AS n FROM deliveries d JOIN events e ON e.delivery_id = d.id
      WHERE d.send_id IN (${recent}) AND d.status = 'sent' AND d.sent_at >= ?1 AND e.type IN ('delivery', 'bounce', 'soft-bounce', 'complaint', 'unsubscribe')
      GROUP BY e.type`).bind(since, created).all<{ type: string; n: number }>(),
    env.DB.prepare(`SELECT reason, COUNT(*) AS n FROM suppressions WHERE scope = '*' GROUP BY reason`).all<{ reason: string; n: number }>(),
  ]);
  const n = Object.fromEntries(events.results.map(r => [r.type, r.n])) as Record<string, number>;
  const sent = mail?.sent ?? 0;
  const bounceRate = share(n.bounce ?? 0, sent);
  const complaintRate = share(n.complaint ?? 0, sent);
  const bounce = level(bounceRate, limits.bounce);
  const complaint = level(complaintRate, limits.complaint);
  return {
    days, sent,
    delivered: n.delivery ?? 0,
    bounced: n.bounce ?? 0,
    softBounced: n['soft-bounce'] ?? 0,
    complaints: n.complaint ?? 0,
    unsubscribed: n.unsubscribe ?? 0,
    failed: mail?.failed ?? 0,
    unknown: mail?.unknown ?? 0,
    rates: { bounce: bounceRate, complaint: complaintRate, delivered: share(n.delivery ?? 0, sent) },
    health: { bounce, complaint, overall: ([bounce, complaint].includes('act') ? 'act' : [bounce, complaint].includes('watch') ? 'watch' : 'ok') as Level },
    limits,
    blockedOnEveryList: Object.fromEntries(suppressed.results.map(r => [r.reason, r.n])),
    // No delivery events while mail went out: SES's events do not reach Utskick (docs/setup.md, step 2).
    eventsMissing: sent >= 20 && !n.delivery,
  };
}

// --------------------------------------------------------------------------
// List growth
// --------------------------------------------------------------------------

export interface GrowthMonth { month: string; joined: number; departed: number; net: number }

// Per list, a month a row, newest first, for the last `months` months, with today's size. Before
// an import only those still subscribed count as joined, and those who left in Mailchimp not at all.
export async function listGrowth(env: Env, o: { list?: string | null; months: number }, now = new Date()) {
  const months = Math.max(1, Math.min(24, Math.floor(o.months) || 12));
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1));
  const ids = Object.keys(env.CONFIG.lists).filter(id => !env.CONFIG.lists[id].adhoc && (!o.list || id === o.list));
  const [rows, sizes] = await Promise.all([
    env.DB.prepare(`SELECT substr(day, 1, 7) AS month, list, SUM(joined) AS joined, SUM(departed) AS departed
      FROM list_changes WHERE day >= ? GROUP BY month, list`).bind(iso(first).slice(0, 10)).all<{ month: string; list: string; joined: number; departed: number }>(),
    env.DB.prepare('SELECT list, COUNT(*) AS n FROM subscriptions GROUP BY list').all<{ list: string; n: number }>(),
  ]);
  const size = new Map(sizes.results.map(r => [r.list, r.n]));
  const labels = Array.from({ length: months }, (_, i) => iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))).slice(0, 7));
  return {
    months,
    lists: ids.map(id => {
      const mine = new Map(rows.results.filter(r => r.list === id).map(r => [r.month, r]));
      const history: GrowthMonth[] = labels.map(month => {
        const r = mine.get(month);
        return { month, joined: r?.joined ?? 0, departed: r?.departed ?? 0, net: (r?.joined ?? 0) - (r?.departed ?? 0) };
      });
      return { list: id, name: env.CONFIG.lists[id].name, subscribers: size.get(id) ?? 0, months: history };
    }),
  };
}
