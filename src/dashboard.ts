// A read-only view for admins of how the newsletter does: lists, sends, approvals that wait,
// and the latest audit entries. Counts only: no address, name, token or message id reaches the
// page. Admins sign in as on /oauth/authorize and /approve/ (src/identity.ts). docs/dashboard.md.
import type { Env } from './env.ts';
import { signedInAdmin } from './identity.ts';
import { messagePage } from './oauth.ts';
import { escapeHtml } from './render.ts';
import { stats } from './send.ts';
import { HttpError, iso } from './util.ts';

const keyPattern = /^[a-z0-9][a-z0-9-]{1,79}$/;
// Each send shown costs a read of its deliveries and events, so the overview keeps to the latest.
const sendsShown = 25;
const auditShown = 20;
// The timeline: an hour a bar for the first 72 hours, when most reading happens, then a day a bar.
const hourly = 72;
const daily = 30;

// The page only shows: no script, no outside asset, no form, no frame.
const securityHeaders: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'X-Content-Type-Options': 'nosniff',
};

export async function dashboardRoute(request: Request, env: Env, url: URL): Promise<Response> {
  let res: Response;
  try {
    res = await route(request, env, url);
  } catch (error) {
    console.error(JSON.stringify({ event: 'error', path: url.pathname, message: String(error) }));
    res = messagePage(env, 500, 'Something went wrong', 'The numbers could not be read. Try again in a minute.');
  }
  // Every answer, sign-in pages and errors too, so no response falls outside the policy.
  for (const [name, value] of Object.entries(securityHeaders)) res.headers.set(name, value);
  return request.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  // Who comes before what: a stranger learns nothing, not even which sends exist.
  const who = await signedInAdmin(request, env);
  if (!who.ok) {
    // The identity check's 403 reason names the address; this page shows none.
    return who.status === 403
      ? messagePage(env, 403, 'Not an admin', 'You are signed in, but not as an admin of this installation. Sign in with another account.')
      : messagePage(env, who.status, 'Sign-in needed', who.reason);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('GET or HEAD', { status: 405, headers: { Allow: 'GET, HEAD' } });
  if (url.pathname === '/dashboard' || url.pathname === '/dashboard/') return overview(env, url.searchParams.get('tests') === '1');
  const m = url.pathname.match(/^\/dashboard\/sends\/([^/]+)$/);
  if (m && keyPattern.test(m[1])) {
    try {
      return await sendPage(env, m[1]);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
    }
  }
  return messagePage(env, 404, 'Not found', 'There is no such page or send.');
}

async function all<T>(env: Env, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...params).all<T>()).results;
}

// --------------------------------------------------------------------------
// /dashboard
// --------------------------------------------------------------------------

interface SendRow { id: number; key: string; list: string; kind: string; created_at: string; recipients: number; sent: number }
interface PendingRow {
  id: string; send_key: string; list: string; subject: string; recipients: number; created_at: string; expires_at: string;
  client_id: string; client_name: string | null;
  // Drafts are shared: which assistant made the one asked for, and which changed it last.
  draft_id: string; draft_created_by: string | null; draft_created_name: string | null; draft_changed_by: string | null; draft_changed_name: string | null;
}

// The assistant's name as the admin saw it on the consent page, while its grant lasts.
const clientName = (alias: string, column = 'client_id') => `(SELECT g.client_name FROM oauth_grants g WHERE g.client_id = ${alias}.${column} ORDER BY g.created_at DESC LIMIT 1)`;
// ?1: show test sends; ?2: how many.
const latestSends = `SELECT id, key, list, kind, created_at FROM sends WHERE ?1 OR kind != 'test' ORDER BY id DESC LIMIT ?2`;

async function overview(env: Env, tests: boolean): Promise<Response> {
  const now = new Date();
  const since = iso(new Date(now.getTime() - 30 * 86_400_000));
  // Subscriptions and suppressions are read whole (one row per address); deliveries and events
  // only for the sends shown, through their indexes.
  const [subs, suppressed, sends, events, approvals, audit] = await Promise.all([
    // consented_at, not created_at: an import keeps the time each person signed up.
    all<{ list: string; source: string; total: number; recent: number }>(env,
      `SELECT list, source, COUNT(*) AS total, SUM(consented_at >= ?) AS recent FROM subscriptions GROUP BY list, source`, since),
    all<{ scope: string; n: number }>(env, `SELECT scope, COUNT(*) AS n FROM suppressions GROUP BY scope`),
    all<SendRow>(env, `SELECT s.id, s.key, s.list, s.kind, s.created_at, COUNT(d.id) AS recipients, COALESCE(SUM(d.status = 'sent'), 0) AS sent
      FROM (${latestSends}) s LEFT JOIN deliveries d ON d.send_id = s.id GROUP BY s.id ORDER BY s.id DESC`, tests ? 1 : 0, sendsShown),
    all<{ send_id: number; type: string; n: number }>(env, `SELECT d.send_id, e.type, COUNT(DISTINCT e.delivery_id) AS n
      FROM deliveries d JOIN events e ON e.delivery_id = d.id WHERE d.send_id IN (SELECT id FROM (${latestSends})) GROUP BY d.send_id, e.type`, tests ? 1 : 0, sendsShown),
    all<PendingRow>(env,
      `SELECT a.id, a.send_key, a.list, a.subject, a.recipients, a.created_at, a.expires_at, a.client_id, ${clientName('a')} AS client_name,
        a.draft_id, a.draft_created_by, ${clientName('a', 'draft_created_by')} AS draft_created_name, a.draft_changed_by, ${clientName('a', 'draft_changed_by')} AS draft_changed_name
      FROM approvals a WHERE a.status = 'pending' AND a.expires_at > ? ORDER BY a.created_at`, iso(now)),
    all<{ id: number; at: string; client_id: string; scope: string | null; tool: string; summary: string; outcome: string; client_name: string | null }>(env,
      `SELECT l.id, l.at, l.client_id, l.scope, l.tool, l.summary, l.outcome, ${clientName('l')} AS client_name FROM audit_log l ORDER BY l.id DESC LIMIT ?`, auditShown),
  ]);

  const left = new Map(suppressed.map(r => [r.scope, r.n]));
  const lists = Object.entries(env.CONFIG.lists).map(([id, l]) => {
    const mine = subs.filter(r => r.list === id);
    const sources = mine.filter(r => r.recent > 0).sort((a, b) => b.recent - a.recent || a.source.localeCompare(b.source));
    return `<tr id="list-${escapeHtml(id)}"><th scope="row">${escapeHtml(l.name)}<span class="sub">${escapeHtml(id)}</span></th>`
      + `<td class="num">${num(sum(mine.map(r => r.total)))}</td><td class="num">${num(left.get(id) ?? 0)}</td><td class="num">${num(sum(mine.map(r => r.recent)))}</td>`
      + `<td>${sources.map(r => `${text(r.source)} ${num(r.recent)}`).join('<br>') || '–'}</td></tr>`;
  });

  const counts = new Map<number, Record<string, number>>();
  for (const e of events) counts.set(e.send_id, { ...counts.get(e.send_id), [e.type]: e.n });
  const sendRows = sends.map(s => {
    const e = counts.get(s.id) ?? {};
    const pixel = !!env.CONFIG.lists[s.list]?.opens;
    const share = (n: number) => `${num(n)} <span class="pct">${rate(n, s.sent)}</span>`;
    return `<tr id="send-${escapeHtml(s.key)}"><th scope="row"><a href="/dashboard/sends/${escapeHtml(s.key)}">${escapeHtml(s.key)}</a><span class="sub">${escapeHtml(listName(env, s.list))}</span></th>`
      + `<td>${kind(s.kind)}</td><td>${when(s.created_at)}</td>`
      + [s.recipients, s.sent, e.delivery ?? 0].map(n => `<td class="num">${num(n)}</td>`).join('')
      + `<td class="num">${pixel ? share(e.open ?? 0) : '<span class="muted">no pixel</span>'}</td><td class="num">${share(e.click ?? 0)}</td>`
      + [e.bounce ?? 0, e.complaint ?? 0, e.unsubscribe ?? 0].map(n => `<td class="num">${num(n)}</td>`).join('')
      + '</tr>';
  });

  const approvalRows = approvals.map(a => `<tr id="approval-${escapeHtml(a.id)}"><td class="mono">${escapeHtml(a.id)}</td><td>${escapeHtml(a.send_key)}</td>`
    + `<td>${escapeHtml(listName(env, a.list))}</td><td class="wrap">${text(a.subject)}</td><td class="num">${num(a.recipients)}</td>`
    + `<td class="wrap">${assistant(a.client_name, a.client_id)}</td><td class="wrap">${draftBy(a)}</td><td>${when(a.created_at)}</td><td>${when(a.expires_at)}</td></tr>`);

  const auditRows = audit.map(l => `<tr id="audit-${l.id}"><td>${when(l.at)}</td><td class="wrap">${assistant(l.client_name, l.client_id)}</td>`
    + `<td class="mono">${text(l.tool)}</td><td class="mono">${text(l.scope ?? '')}</td><td>${text(l.outcome)}</td><td class="wrap">${summary(l.summary)}</td></tr>`);

  return shell(env, 'Dashboard', `<h1>How the newsletter does</h1>
<h2>Lists</h2>
<div class="scroll"><table>
<thead><tr><th>List</th><th class="num">Subscribers</th><th class="num">Suppressed here</th><th class="num">New, 30 days</th><th>New, by source</th></tr></thead>
<tbody>${lists.join('\n')}</tbody>
</table></div>
<p id="suppressed-everywhere">Suppressed on every list (hard bounces, complaints, addresses Mailchimp cleaned): <strong>${num(left.get('*') ?? 0)}</strong></p>
<p class="small">“Suppressed here” counts those who left the list. “New” counts by the time each person signed up, so an import of old subscribers adds none.</p>
<h2>Sends</h2>
<p class="small">The latest ${sendsShown}, newest first. Rates are of mails sent. ${tests ? '<a href="/dashboard">Hide test sends</a>' : '<a href="/dashboard?tests=1">Show test sends</a>'}</p>
${sendRows.length ? `<div class="scroll"><table>
<thead><tr><th>Send</th><th>Kind</th><th>Created</th><th class="num">Recipients</th><th class="num">Sent</th><th class="num">Delivered</th><th class="num">Unique opens</th><th class="num">Unique clicks</th><th class="num">Hard bounces</th><th class="num">Complaints</th><th class="num">Unsubscribes</th></tr></thead>
<tbody>${sendRows.join('\n')}</tbody>
</table></div>` : '<p>No sends yet.</p>'}
<h2>Waiting for approval</h2>
${approvalRows.length ? `<div class="scroll"><table>
<thead><tr><th>Request</th><th>Key</th><th>List</th><th>Subject</th><th class="num">Recipients</th><th>Asked by</th><th>Draft by</th><th>Asked</th><th>Ends</th></tr></thead>
<tbody>${approvalRows.join('\n')}</tbody>
</table></div>
<p class="small">An admin approves a request through the link the assistant got. Utskick keeps only a hash of that link, so it cannot be shown here: ask the assistant for it.</p>` : '<p>No send waits for approval.</p>'}
<h2>Audit log</h2>
${auditRows.length ? `<div class="scroll"><table id="audit">
<thead><tr><th>When</th><th>Assistant</th><th>Tool</th><th>Scope</th><th>Outcome</th><th>Summary</th></tr></thead>
<tbody>${auditRows.join('\n')}</tbody>
</table></div>
<p class="small">The latest ${auditShown} entries. The full log, with the admin behind each grant, is at /admin/audit.</p>` : '<p>Nothing in the audit log yet.</p>'}
${opensNote}`);
}

// --------------------------------------------------------------------------
// /dashboard/sends/<key>
// --------------------------------------------------------------------------

const statuses: [string, string][] = [
  ['sent', 'SES took the mail'],
  ['pending', 'waits for its batch'],
  ['sending', 'a batch has it now'],
  ['unknown', 'SES may or may not have the mail: no answer, an SES server error, or a run that stopped between SES and the database; check, then retry-unknown sends these again'],
  ['skipped', 'left the list or was suppressed before its turn'],
  ['failed', 'SES refused that address, so the mail did not go out; once the cause is fixed, retry-failed puts these back in line'],
];

async function sendPage(env: Env, key: string): Promise<Response> {
  const s = await stats(env, key);
  const [start, family] = await Promise.all([
    env.DB.prepare(`SELECT MIN(d.sent_at) AS t FROM deliveries d WHERE d.send_id = (SELECT id FROM sends WHERE key = ?) AND d.status = 'sent'`).bind(key).first<string>('t'),
    all<{ id: number; key: string; kind: string; rel: 'parent' | 'resend' }>(env, `SELECT id, key, kind, 'parent' AS rel FROM sends WHERE id = (SELECT parent_id FROM sends WHERE key = ?1)
      UNION ALL SELECT id, key, kind, 'resend' AS rel FROM sends WHERE parent_id = (SELECT id FROM sends WHERE key = ?1) ORDER BY id`, key),
  ]);
  // Each mail's first open and first click, counted in the hour or day after the first mail went out.
  const slots = start ? await all<{ type: string; slot: number; n: number }>(env, `SELECT type, CASE WHEN h < ${hourly} THEN h ELSE ${hourly} + (h - ${hourly}) / 24 END AS slot, COUNT(*) AS n FROM (
      SELECT e.type, MAX(0, (CAST(strftime('%s', MIN(e.at)) AS INTEGER) - CAST(strftime('%s', ?2) AS INTEGER)) / 3600) AS h
      FROM deliveries d JOIN events e ON e.delivery_id = d.id
      WHERE d.send_id = (SELECT id FROM sends WHERE key = ?1) AND e.type IN ('open', 'click') GROUP BY e.delivery_id, e.type
    ) GROUP BY type, slot`, key, start) : [];

  const sent = s.status.sent ?? 0;
  const pixel = !!env.CONFIG.lists[s.list]?.opens;
  const ofSent = (n: number) => sent ? `${rate(n, sent)} of sent` : '';
  const parts = (...p: string[]) => p.filter(Boolean).join(' · ');
  const tiles = [
    tile('Recipients', num(s.recipients)),
    tile('Sent', num(sent), s.recipients ? `${rate(sent, s.recipients)} of recipients` : ''),
    tile('Delivered', num(s.delivered), ofSent(s.delivered)),
    pixel ? tile('Unique opens', num(s.opens.unique), parts(ofSent(s.opens.unique), `${num(s.opens.total)} in all`)) : tile('Unique opens', 'no pixel', 'This list has no open pixel.'),
    tile('Unique clicks', num(s.clicks.unique), parts(ofSent(s.clicks.unique), `${num(s.clicks.total)} in all`)),
    tile('Hard bounces', num(s.bounced), `${num(s.softBounced)} soft`),
    tile('Complaints', num(s.complaints), ofSent(s.complaints)),
    tile('Unsubscribes', num(s.unsubscribed), ofSent(s.unsubscribed)),
  ];

  const most = Math.max(0, ...s.links.map(l => l.unique));
  const links = s.links.map(l => bar(`link-${l.n}`, `${text(l.url)}<span class="muted"> · ${num(l.total)} in all</span>`, l.unique, most, `${num(l.unique)} · ${rate(l.unique, sent)}`));
  const known = new Set(statuses.map(([name]) => name));
  const status = [...statuses, ...Object.keys(s.status).filter(k => !known.has(k)).map(k => [k, ''] as [string, string])]
    .filter(([name]) => s.status[name])
    .map(([name, what]) => bar(`status-${escapeHtml(name)}`, `${escapeHtml(name)}${what ? `<span class="muted"> · ${what}</span>` : ''}`, s.status[name], s.recipients, `${num(s.status[name])} · ${rate(s.status[name], s.recipients)}`, 'var(--ink)'));

  const parent = family.filter(f => f.rel === 'parent').map(f => sendLink(f.key));
  const resends = family.filter(f => f.rel === 'resend').map(f => sendLink(f.key));
  const related = [parent.length ? `Resend of ${parent.join(', ')}.` : '', resends.length ? `Resent as ${resends.join(', ')} to those who did not open, click or leave.` : ''].filter(Boolean);

  const now = new Date();
  let overTime = '<p>No mail has gone out yet.</p>';
  if (start) {
    overTime = (pixel
      ? timeline('opens-over-time', 'First opens', 'when each mail was opened the first time', slots.filter(r => r.type === 'open'), start, now, '#6B7280')
      : '<p>This list has no open pixel, so there are no opens to show.</p>')
      + timeline('clicks-over-time', 'First clicks', 'when each mail was clicked the first time', slots.filter(r => r.type === 'click'), start, now, '#E85D1F');
  }

  return shell(env, s.key, `<h1>${escapeHtml(s.key)}</h1>
<p class="meta">${kind(s.kind)} ${escapeHtml(listName(env, s.list))} · created ${when(s.created_at)}${start ? ` · first mail ${when(start)}` : ''}</p>
<p>Subject: ${text(s.subject)}</p>
${related.map(r => `<p>${r}</p>`).join('\n')}
<div class="tiles">${tiles.join('')}</div>
<h2>Clicks per link</h2>
${links.length ? `<p class="small">Mails with a click on the link, in the order the links come in the mail, and the share of mails sent.</p><div class="bars">${links.join('\n')}</div>` : '<p>This mail has no tracked links.</p>'}
<h2>Delivery status</h2>
${status.length ? `<div class="bars">${status.join('\n')}</div>` : '<p>No recipients.</p>'}
<h2>Over time</h2>
${overTime}
${opensNote}`);
}

// One bar for each of the first 72 hours, then one for each day up to day 33 or today.
function timeline(id: string, title: string, what: string, rows: { slot: number; n: number }[], start: string, now: Date, color: string): string {
  const counts = new Map<number, number>();
  let later = 0;
  for (const r of rows) {
    if (r.slot < hourly + daily) counts.set(r.slot, r.n);
    else later += r.n;
  }
  const hours = Math.floor((now.getTime() - Date.parse(start)) / 3600_000);
  const today = hours < hourly ? hourly - 1 : hourly + Math.floor((hours - hourly) / 24);
  const slots = Math.min(hourly + daily, Math.max(hourly, today + 1, ...[...counts.keys()].map(k => k + 1)));
  const caption = `<figcaption><strong>${title}</strong>: ${what}. An hour a bar for 72 hours, then a day a bar.</figcaption>`;
  const after = later ? `<p class="small">${num(later)} more after day ${hourly / 24 + daily}, not drawn.</p>` : '';
  if (!counts.size) return `<figure id="${id}">${caption}<p class="muted">None yet.</p>${after}</figure>`;

  const [w, h, left, right, top, bottom] = [640, 160, 34, 22, 22, 24];
  const plotW = w - left - right, plotH = h - top - bottom;
  const slotW = plotW / slots;
  const barW = Math.max(1, slotW - Math.min(2, slotW * 0.25));
  const max = Math.max(...counts.values());
  const x = (slot: number) => left + slot * slotW;
  const label = (slot: number) => slot < hourly ? `Hour ${slot + 1}` : `Day ${slot - hourly + hourly / 24 + 1}`;
  const peak = [...counts].find(([, n]) => n === max)![0];

  const bars = [...counts].sort((a, b) => a[0] - b[0]).map(([slot, n]) => {
    const bh = Math.max(1, plotH * n / max);
    return `<rect x="${f(x(slot))}" y="${f(top + plotH - bh)}" width="${f(barW)}" height="${f(bh)}" fill="${color}"><title>${label(slot)}: ${num(n)}</title></rect>`;
  });
  // Past 72 hours a bar is narrow, so days get a label only every two weeks, where labels cannot touch.
  const ticks: [number, string][] = [[0, '0 h'], [24, '24 h'], [48, '48 h'], [hourly, '72 h']];
  for (const day of [14, 28]) {
    const slot = hourly + day - (hourly / 24 + 1);
    if (slot < slots) ticks.push([slot, `day ${day}`]);
  }
  const axis = ticks.map(([slot, t]) => `<line x1="${f(x(slot))}" x2="${f(x(slot))}" y1="${top + plotH}" y2="${top + plotH + 4}" stroke="#6B7280"/><text x="${f(x(slot))}" y="${h - 6}" text-anchor="middle">${t}</text>`);
  const split = slots > hourly
    ? `<line x1="${f(x(hourly))}" x2="${f(x(hourly))}" y1="${top}" y2="${top + plotH}" stroke="#E7E5E0"/><text x="${f(x(hourly) + 4)}" y="12">per day</text>`
    : '';

  return `<figure id="${id}">${caption}<div class="scroll"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title} over time. Most in ${label(peak).toLowerCase()}: ${num(max)}.">
<line x1="${left}" x2="${w - right}" y1="${top}" y2="${top}" stroke="#E7E5E0"/>
<line x1="${left}" x2="${w - right}" y1="${top + plotH}" y2="${top + plotH}" stroke="#6B7280"/>
<text x="${left - 6}" y="${top + 4}" text-anchor="end">${num(max)}</text><text x="${left - 6}" y="${top + plotH + 4}" text-anchor="end">0</text><text x="${left}" y="12">per hour</text>
${split}${axis.join('')}
${bars.join('\n')}
</svg></div>${after}</figure>`;
}

// --------------------------------------------------------------------------
// Pieces
// --------------------------------------------------------------------------

const opensNote = `<p class="note">Opens overstate reading. Apple Mail Privacy Protection loads every image in a mail, the open pixel too, as soon as the mail arrives, and Gmail fetches images through its own proxy. Many opens are machines, not people. Clicks, and replies to the list's reply-to address, are the honest signal.</p>`;

// Like audit.ts: anything shaped like an address is blanked, wherever it turns up.
const address = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[^\s@<>()[\]"',;:]{2,}/g;

// Text from the database, such as a subject, a link or an assistant's name.
const text = (s: unknown) => escapeHtml(String(s ?? '').replace(address, '[address]'));
const clip = (s: string, max: number) => s.length > max ? `${s.slice(0, max - 1)}…` : s;
const num = (n: number) => Number(n ?? 0).toLocaleString('en-US');
const sum = (ns: number[]) => ns.reduce((a, b) => a + (b ?? 0), 0);
const rate = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(1)}%` : '–';
const when = (t: string | null) => t ? escapeHtml(t.slice(0, 16).replace('T', ' ')) : '–';
const f = (n: number) => String(Math.round(n * 10) / 10);
const listName = (env: Env, list: string) => env.CONFIG.lists[list]?.name ?? list;
const kind = (k: string) => `<span class="kind kind-${escapeHtml(k)}">${escapeHtml(k)}</span>`;
const sendLink = (key: string) => `<a href="/dashboard/sends/${escapeHtml(key)}">${escapeHtml(key)}</a>`;
const assistant = (name: string | null, clientId: string) => name ? text(clip(name, 80)) : `<span class="mono">${text(clip(clientId, 60))}</span>`;
const someone = (name: string | null, clientId: string | null) => clientId ? assistant(name, clientId) : 'an unrecorded assistant';
// Another assistant than the one asking may have changed the draft last; the approval page says so too.
const draftBy = (a: PendingRow) => `<span class="mono">${escapeHtml(a.draft_id)}</span> made by ${someone(a.draft_created_name, a.draft_created_by)}, `
  + `changed by ${someone(a.draft_changed_name, a.draft_changed_by)}${a.draft_changed_by && a.draft_changed_by !== a.client_id ? ' <strong>(not the one asking)</strong>' : ''}`;

function tile(label: string, value: string, sub = ''): string {
  return `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function bar(id: string, what: string, value: number, of: number, count: string, color = 'var(--accent)'): string {
  const width = of ? Math.round(1000 * value / of) / 10 : 0;
  return `<div class="bar" id="${id}"><div class="what">${what}</div><div class="track"><span style="width:${width}%;background:${color}"></span></div><div class="count">${count}</div></div>`;
}

// The audit summary as key: value pairs. It never held an address or a body; blank both again,
// and anything shaped like a delivery token, in case an assistant passed one as an argument.
function summary(raw: string): string {
  let o: unknown = raw;
  try { o = JSON.parse(raw); } catch { /* shown as it is */ }
  const pairs = o && typeof o === 'object' && !Array.isArray(o)
    ? Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    : [String(o)];
  return text(clip(pairs.join(' · ').replace(/\b[0-9a-f]{32,}\b/gi, '[hidden]'), 240));
}

function shell(env: Env, title: string, body: string): Response {
  const org = escapeHtml(env.CONFIG.organization);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ${org}</title>
<style>
  :root { --paper: #FAFAF7; --ink: #0A0A0A; --muted: #6B7280; --line: #E7E5E0; --accent: #E85D1F; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 1120px; margin: 0 auto; padding: 40px 16px 64px; }
  .kicker, h2, thead th, .label, .kind, .mono, svg text { font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }
  .kicker { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 32px; }
  .kicker a { color: inherit; text-decoration: none; }
  h1 { font-weight: 300; font-size: 34px; line-height: 1.15; margin: 0 0 12px; overflow-wrap: anywhere; }
  h2 { font-size: 12px; font-weight: 400; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 8px; margin: 48px 0 12px; }
  p { margin: 0 0 12px; }
  a { color: var(--ink); }
  a:hover { color: var(--accent); }
  .small, .sub, .pct, .muted, .meta { color: var(--muted); }
  .small { font-size: 13px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; font-weight: 400; padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
  thead th { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  tbody th { font-weight: 600; }
  .num { text-align: right; }
  .wrap { white-space: normal; min-width: 200px; overflow-wrap: anywhere; }
  .sub { display: block; font-size: 12px; font-weight: 400; }
  .mono { font-size: 13px; }
  .kind { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line); padding: 1px 6px; }
  .kind-live { border-color: var(--accent); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); border-top: 1px solid var(--line); border-left: 1px solid var(--line); margin-top: 24px; }
  .tile { padding: 14px 16px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); min-width: 0; }
  .label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .value { font-size: 30px; font-weight: 300; line-height: 1.25; font-variant-numeric: tabular-nums; }
  .tile .sub { font-size: 13px; }
  .bar { display: grid; grid-template-columns: 1fr 120px; gap: 4px 16px; padding: 8px 0; border-bottom: 1px solid var(--line); }
  .bar .what { grid-column: 1 / -1; overflow-wrap: anywhere; font-size: 14px; }
  .bar .track { height: 8px; background: var(--line); align-self: center; }
  .bar .track span { display: block; height: 100%; }
  .bar .count { text-align: right; font-variant-numeric: tabular-nums; }
  figure { margin: 0 0 32px; }
  figcaption { margin-bottom: 8px; }
  svg { display: block; width: 100%; min-width: 520px; max-width: 760px; height: auto; }
  svg text { font-size: 11px; fill: var(--muted); }
  .note { border-left: 2px solid var(--accent); padding: 4px 0 4px 16px; margin-top: 48px; max-width: 720px; }
</style>
</head>
<body><main><div class="kicker"><a href="/dashboard">${org} · Dashboard</a></div>
${body}
<p class="small">Counts only: no address, name or token is shown. Times are UTC.</p>
</main></body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
