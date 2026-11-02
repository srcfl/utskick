// Sending to a list is never a right an assistant holds. It asks (request_send), and an admin
// signs in, sees the list, the subject, the count and the mail itself, and approves or declines,
// once, within ten minutes. Approval creates the send; the cron trigger sends it, 14 mails a second.
// The CLI's own sends (cli/utskick.ts) do not pass through here and the cron never touches them.
import { audit } from './audit.ts';
import type { Env } from './env.ts';
import { getDraft, hex, inspectMail } from './drafts.ts';
import { signedInAdmin } from './identity.ts';
import { issuer, messagePage, sameOrigin, sweepOAuth, type Grant } from './oauth.ts';
import { page } from './pages.ts';
import { escapeHtml, render, stripComments, toText, trackedLinks } from './render.ts';
import { createSend, runBatch } from './send.ts';
import { HttpError, iso, normalizeEmail, sha256 } from './util.ts';
import { randomToken } from './clients.ts';

const approvalTtl = 10 * 60_000;
const testsPerHour = 20;

interface ApprovalRow {
  id: string;
  draft_id: string;
  send_key: string;
  list: string;
  subject: string;
  html: string;
  recipients: number;
  client_id: string;
  requested_by: string;
  grant_id: string | null;
  draft_created_by: string | null;   // the assistant that made the draft
  draft_changed_by: string | null;   // the one that saved it last, before the request
  status: 'pending' | 'declined' | 'approved' | 'sent' | 'failed';
  decided_by: string | null;
  decided_at: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
}

const keyPattern = /^[a-z0-9][a-z0-9-]{1,79}$/;

export async function requestSend(env: Env, grant: Grant, a: Record<string, unknown>, now = new Date()) {
  const d = await getDraft(env, a.draft);
  // A list mail without a way off the list is not one we send.
  if (!d.html.includes('*|UNSUB|*')) throw new HttpError(400, 'The draft has no *|UNSUB|* link. A send to a list needs one: add it and save the draft again.');
  const key = a.key === undefined ? `${d.list}-${iso(now).slice(0, 10)}` : a.key;
  if (typeof key !== 'string' || !keyPattern.test(key)) throw new HttpError(400, 'key must be lowercase letters, digits and hyphens, 2 to 80 of them, e.g. the-source-23. It becomes the web version\'s address.');
  const taken = await env.DB.prepare(`SELECT 1 FROM sends WHERE key = ?1 UNION ALL SELECT 1 FROM approvals WHERE send_key = ?1
      AND (status IN ('approved', 'sent') OR (status = 'pending' AND expires_at > ?2))`).bind(key, iso(now)).first();
  if (taken) throw new HttpError(409, `A send with key ${key} exists already, or waits for approval. Pass another key.`);
  // The dry run's counts only: its sample mail is a real subscriber's.
  const dry = await createSend(env, { key, list: d.list, kind: 'live', subject: d.subject, html: d.html, dryRun: true }, now) as { recipients: number; excluded: number };
  const token = randomToken(32);
  const id = `a-${hex(6)}`;
  const expires = iso(new Date(now.getTime() + approvalTtl));
  await env.DB.prepare(`INSERT INTO approvals (id, token_hash, draft_id, send_key, list, subject, html, recipients, client_id, requested_by, grant_id,
      draft_created_by, draft_changed_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, await sha256(token), d.id, key, d.list, d.subject, d.html, dry.recipients, grant.clientId, grant.subject, grant.id,
      d.created_by, d.client_id, iso(now), expires).run();
  return {
    approval: id,
    approveUrl: `${issuer(env)}/approve/${token}`,
    expiresAt: expires,
    key, list: d.list, listName: env.CONFIG.lists[d.list].name, subject: d.subject,
    recipients: dry.recipients, excluded: dry.excluded,
    note: 'Nothing is sent yet. Give this link to the person who asked: an admin must open it, sign in and approve within ten minutes. It works once. The mail goes out as it is now, even if the draft changes later.',
  };
}

export async function approvalStatus(env: Env, a: Record<string, unknown>, now = new Date()) {
  const r = typeof a.approval === 'string'
    ? await env.DB.prepare('SELECT id, status, send_key, list, subject, recipients, expires_at, decided_at, error FROM approvals WHERE id = ?').bind(a.approval).first<ApprovalRow>()
    : null;
  if (!r) throw new HttpError(404, 'No such approval.');
  const status = r.status === 'pending' && r.expires_at <= iso(now) ? 'expired' : r.status;
  const progress = ['approved', 'sent'].includes(r.status)
    ? (await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM deliveries WHERE send_id = (SELECT id FROM sends WHERE key = ?) GROUP BY status`).bind(r.send_key).all<{ status: string; n: number }>()).results
      .reduce((o, x) => ({ ...o, [x.status]: x.n }), {} as Record<string, number>)
    : undefined;
  return { approval: r.id, status, key: r.send_key, list: r.list, subject: r.subject, recipients: r.recipients, expiresAt: r.expires_at, decidedAt: r.decided_at, error: r.error, deliveries: progress };
}

// --------------------------------------------------------------------------
// The approval page: /approve/<token>, behind Cloudflare Access like /oauth/authorize
// --------------------------------------------------------------------------

// The page shows a mail an assistant wrote, and so someone else may have written. Opening it must
// tell that someone nothing: nothing loads from elsewhere, and the preview, a sandboxed srcdoc
// frame, inherits this policy. Images from Utskick's own /img/ and data: URIs show; the rest is
// listed as text. The page may not be framed, and its link, which holds the secret, is no referrer.
const approvalPolicy = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function guarded(res: Response): Response {
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Content-Security-Policy', approvalPolicy);
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('X-DNS-Prefetch-Control', 'off');
  return res;
}

export async function approvalRoute(request: Request, env: Env, token: string): Promise<Response> {
  const who = await signedInAdmin(request, env);
  if (!who.ok) return guarded(messagePage(env, who.status, 'Sign-in needed', who.reason));
  const a = await env.DB.prepare('SELECT * FROM approvals WHERE token_hash = ?').bind(await sha256(token)).first<ApprovalRow>();
  if (!a) return guarded(messagePage(env, 404, 'No such request', 'This link leads to no send request. It may be cut short.'));
  const now = new Date();
  const closed = () => guarded(messagePage(env, a.status === 'pending' ? 410 : 409, 'This request is closed',
    a.status === 'pending' ? 'It ran out ten minutes after the assistant asked. Ask it to request the send again.' : `It was ${a.status === 'declined' ? 'declined' : 'approved'} already.`));
  if (request.method === 'GET') {
    if (a.status !== 'pending' || a.expires_at <= iso(now)) return closed();
    return guarded(await approvalPage(env, a, who.email, token));
  }
  if (request.method !== 'POST') return new Response('GET or POST', { status: 405, headers: { Allow: 'GET, POST' } });
  if (!sameOrigin(request, env)) return guarded(messagePage(env, 403, 'This form came from elsewhere', 'Open the approval link again.'));
  const decision = new URLSearchParams((await request.text()).slice(0, 1024)).get('decision');
  if (decision !== 'approve' && decision !== 'decline') return guarded(messagePage(env, 400, 'No decision', 'Choose Send or Decline.'));

  // Single use: only a pending request inside its ten minutes changes, and only once.
  const taken = await env.DB.prepare(`UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id`)
    .bind(decision === 'approve' ? 'approved' : 'declined', who.email, iso(now), a.id, iso(now)).first();
  if (!taken) {
    const fresh = await env.DB.prepare('SELECT status FROM approvals WHERE id = ?').bind(a.id).first<ApprovalRow>();
    return guarded(messagePage(env, 409, 'This request is closed', fresh?.status === 'pending' ? 'It ran out ten minutes after the assistant asked. Ask it to request the send again.' : `It was ${fresh?.status} already.`));
  }
  const entry = { clientId: a.client_id, subject: a.requested_by, scope: 'drafts.write', tool: 'request_send', summary: { approval: a.id, key: a.send_key, list: a.list, recipients: a.recipients }, approvedBy: who.email };
  if (decision === 'decline') {
    await audit(env, { ...entry, outcome: 'declined' });
    return guarded(messagePage(env, 200, 'Declined', 'Nothing was sent. The assistant sees the request as declined.'));
  }
  try {
    const created = await createSend(env, { key: a.send_key, list: a.list, kind: 'live', subject: a.subject, html: a.html }, now);
    await audit(env, { ...entry, summary: { ...entry.summary, recipients: created.recipients }, outcome: 'approved' });
    return guarded(messagePage(env, 200, 'Approved', `${created.recipients} mails go out from the next minute, 14 a second. Follow it with: node cli/utskick.ts stats ${a.send_key}`));
  } catch (error) {
    const message = error instanceof HttpError ? error.message : 'internal';
    await env.DB.prepare(`UPDATE approvals SET status = 'failed', error = ? WHERE id = ?`).bind(message, a.id).run();
    await audit(env, { ...entry, outcome: 'approved', summary: { ...entry.summary, error: message } });
    return guarded(messagePage(env, 500, 'The send could not be created', `Nothing was sent (${message}).`));
  }
}

async function approvalPage(env: Env, a: ApprovalRow, email: string, token: string): Promise<Response> {
  const list = env.CONFIG.lists[a.list];
  let now: number | string = '?';
  try {
    const dry = await createSend(env, { key: a.send_key, list: a.list, kind: 'live', subject: a.subject, html: a.html, dryRun: true }) as { recipients: number };
    now = dry.recipients;
  } catch {
    // The key was taken meanwhile; approving will say so.
  }
  // As send.ts makes each mail: comments for ourselves gone, Outlook's kept.
  const sent = stripComments(a.html);
  const urls = { firstName: null, fallback: list?.fname ?? 'there', unsubscribeUrl: `${env.PUBLIC_URL}/unsubscribe`, archiveUrl: `${env.PUBLIC_URL}/a/${a.send_key}` };
  const mail = render(sent, urls);
  const text = toText(mail);
  const found = inspectMail(a.html);
  const names = await clientNames(env, [a.client_id, a.draft_created_by, a.draft_changed_by]);
  const who = (id: string | null) => id ? escapeHtml(names.get(id) ? `${names.get(id)} (${clip(id, 80)})` : clip(id, 80)) : 'an assistant Utskick did not record';
  const changedByOther = a.draft_changed_by !== null && a.draft_changed_by !== a.client_id;

  const row = (k: string, v: string, id = '') => `<tr${id ? ` id="${id}"` : ''}><td style="color:var(--muted);padding:4px 16px 4px 0;vertical-align:top">${k}</td><td style="padding:4px 0;overflow-wrap:anywhere">${v}</td></tr>`;
  const items = (xs: string[], note = (_: string) => '') => xs.map(x => `<li><code style="overflow-wrap:anywhere">${escapeHtml(clip(x, 300))}</code>${note(x)}</li>`).join('');
  const tracked = new Set(trackedLinks(sent));
  const linkNote = (l: string) => l === '*|UNSUB|*' ? ': each reader’s own unsubscribe link' : l === '*|ARCHIVE|*' ? ': the web version' : tracked.has(l) ? '' : ' (clicks not counted)';
  // A data: URI is in the mail itself and fetches nothing.
  const loads = found.images.filter(x => !/^data:/i.test(x));
  const warn = (id: string, title: string, body: string) => `<div id="${id}" style="border-left:3px solid var(--accent);padding:4px 0 4px 16px;margin:0 0 16px"><p><strong>${title}</strong></p>${body}</div>`;
  const quote = (t: string) => `<p class="note" style="font-size:15px;overflow-wrap:anywhere">${escapeHtml(clip(t, 600))}</p>`;

  const warnings = [
    found.outlook.length ? warn('outlook-only', 'Parts only Outlook shows',
      `<p>The preview below does not show these. Readers on Outlook for Windows get them.</p>${found.outlook.map(b => quote(`[if ${b.condition}] ${b.text}`)).join('')}`) : '',
    found.hidden.length ? warn('hidden-content', 'Hidden text',
      `<p>These do not show in the preview or in most inboxes, but they go out, and their words are in the text part.</p>${found.hidden.map(h => quote(`(${h.why}) ${h.text}`)).join('')}`) : '',
    found.styleSheetHides ? warn('style-hides', 'The style sheet hides something',
      '<p>A rule in the mail’s style sheet hides elements, often a mobile or desktop version. The text part below has every word the mail carries.</p>') : '',
  ].join('');
  const notes = [
    found.preheader !== null ? `<p class="small" style="margin-top:0">Preheader, shown beside the subject in some inboxes: ${escapeHtml(clip(found.preheader, 200))}</p>` : '',
    found.outlookBlocks && !found.outlook.length ? `<p class="small" style="margin-top:0">${found.outlookBlocks} Outlook-only layout blocks, with no text or links.</p>` : '',
  ].join('');
  // The preview loads nothing from elsewhere; with links, meta tags and a base gone, not even a DNS lookup.
  const preview = mail.replace(/<(?:link|meta|base)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '');

  return page(env.CONFIG, `Send ${a.subject}`, `<h1>Send this to ${escapeHtml(list?.name ?? a.list)}?</h1>
<table>
${row('List', `${escapeHtml(list?.name ?? a.list)} (${escapeHtml(a.list)})`)}
${row('Subject', escapeHtml(a.subject))}
${row('From', escapeHtml(list?.from ?? ''))}
${row('Recipients', `<strong>${now}</strong> now, ${a.recipients} when the assistant asked`)}
${row('Key', escapeHtml(a.send_key))}
${row('Asked by', `${who(a.client_id)}, connected by ${escapeHtml(a.requested_by)}`)}
${row('Draft', `${escapeHtml(a.draft_id)}, made by ${who(a.draft_created_by)}, last changed by ${who(a.draft_changed_by)}.${changedByOther ? ' <strong>Another assistant than the one asking changed it last.</strong>' : ''}`, 'draft-by')}
${row('Ends', `${escapeHtml(a.expires_at)} (UTC)`)}
</table>
${warnings}
<form method="post" action="/approve/${token}">
<button type="submit" name="decision" value="approve">Send to ${now} people</button>
<button type="submit" name="decision" value="decline" style="background:transparent;color:var(--ink);border:1px solid var(--line)">Decline</button>
</form>
<p class="small">You are signed in as ${escapeHtml(email)}. This is the mail as it goes out; each reader sees their own name and links. Images from elsewhere do not load here; they are listed below.</p>
${notes}
<iframe sandbox title="The mail" srcdoc="${escapeHtml(preview)}" style="width:100%;height:640px;border:1px solid var(--line);background:#fff"></iframe>
<h2 style="font-size:20px;font-weight:400;margin:32px 0 8px">The text part</h2>
<p class="small" style="margin-top:0">Sent with the HTML. Most inboxes do not show it, but every word in it goes out.</p>
<pre id="text-part" style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;border:1px solid var(--line);padding:12px;background:#fff">${escapeHtml(text)}</pre>
<h2 style="font-size:20px;font-weight:400;margin:32px 0 8px">Where the links lead</h2>
${found.links.length ? `<ul id="links">${items(found.links, linkNote)}</ul>` : '<p id="links">No links.</p>'}
<h2 style="font-size:20px;font-weight:400;margin:32px 0 8px">What it loads</h2>
${loads.length ? `<ul id="loads">${items(loads)}</ul>` : '<p id="loads">Nothing from elsewhere.</p>'}`);
}

const clip = (s: string, max: number) => s.length > max ? `${s.slice(0, max - 1)}…` : s;

// Each assistant by the name the admin saw on the consent page, while one of its grants lasts.
async function clientNames(env: Env, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = (await env.DB.prepare(`SELECT client_id, client_name FROM oauth_grants WHERE client_id IN (${wanted.map(() => '?').join(', ')}) ORDER BY created_at`)
    .bind(...wanted).all<{ client_id: string; client_name: string }>()).results;
  return new Map(rows.map(r => [r.client_id, r.client_name]));
}

// --------------------------------------------------------------------------
// The cron trigger: every minute, send what admins approved
// --------------------------------------------------------------------------

interface RunOptions {
  budgetMs?: number;                    // stop starting batches after this long; the cron runs every minute
  perSecond?: number;                   // SES allows Sourceful 14 a second
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runApproved(env: Env, o: RunOptions = {}) {
  const budget = o.budgetMs ?? 50_000;
  const rate = o.perSecond ?? 14;
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const start = clock();
  let sent = 0;
  while (clock() - start + 1000 <= budget) {
    // The approval page marks a request approved and then creates its send. A request approved in
    // the last two minutes whose send is not there yet is left for the next run, not failed.
    const next = await env.DB.prepare(`SELECT a.id, a.send_key FROM approvals a WHERE a.status = 'approved'
        AND (EXISTS (SELECT 1 FROM sends s WHERE s.key = a.send_key) OR a.decided_at < ?)
      ORDER BY a.decided_at, a.id LIMIT 1`).bind(iso(new Date(Date.now() - 2 * 60_000))).first<{ id: string; send_key: string }>();
    if (!next) break;
    const began = clock();
    try {
      // runBatch sends its batch at once, so `rate` a batch and a batch a second is `rate` a second.
      sent += (await runBatch(env, next.send_key, rate)).sent;
    } catch (error) {
      // An approval whose send was never created (the Worker died in between, minutes ago) cannot be sent.
      if (error instanceof HttpError && error.status === 404) {
        await env.DB.prepare(`UPDATE approvals SET status = 'failed', error = 'no_such_send' WHERE id = ?`).bind(next.id).run();
        continue;
      }
      // The SES key, the account or a setting is wrong (send.ts put the rows back in pending). Every
      // other mail would fail the same way, so this run stops, says why once, and the approval stays
      // approved: the next run tries again once a person has fixed the cause. The message holds
      // SES's error type and status, never an address.
      if (error instanceof HttpError && error.status === 502 && error.message.startsWith('ses_account_error')) {
        console.error(JSON.stringify({ event: 'cron_stopped', error: error.message, approval: next.id, key: next.send_key }));
        return { sent, stopped: error.message };
      }
      throw error;
    }
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('pending', 'sending') AND send_id = (SELECT id FROM sends WHERE key = ?)`)
      .bind(next.send_key).first<number>('n');
    // Rows left in unknown wait for a person (utskick retry-unknown), as for any send.
    if (!left) await env.DB.prepare(`UPDATE approvals SET status = 'sent' WHERE id = ? AND status = 'approved'`).bind(next.id).run();
    await sleep(Math.max(0, 1000 - (clock() - began)));
  }
  return { sent, stopped: null as string | null };
}

export async function cron(env: Env) {
  const result = await runApproved(env);
  await sweepOAuth(env, new Date());
  if (result.sent) console.log(JSON.stringify({ event: 'cron', sent: result.sent }));
  return result;
}

// --------------------------------------------------------------------------
// test_send: a draft or an issue, as a test, to the allowlist only
// --------------------------------------------------------------------------

export async function testSend(env: Env, clientId: string, a: Record<string, unknown>) {
  const allow = (env.CONFIG.testAllowlist ?? []).map(normalizeEmail).filter((e): e is string => !!e);
  if (!allow.length) throw new HttpError(400, 'No test addresses are set up: testAllowlist in the config is empty.');
  let to = allow;
  if (a.to !== undefined) {
    if (!Array.isArray(a.to) || !a.to.length || a.to.length > 20) throw new HttpError(400, 'to must list 1 to 20 addresses, or be left out for the whole test allowlist.');
    const asked = a.to.map(normalizeEmail);
    if (asked.some(e => !e || !allow.includes(e))) throw new HttpError(403, 'Test mail goes only to the addresses on the test allowlist in the config. Leave "to" out to send to all of them.');
    to = [...new Set(asked as string[])];
  }
  if ((a.draft === undefined) === (a.send === undefined)) throw new HttpError(400, 'Give draft or send, one of them.');
  let source: { name: string; list: string; subject: string; html: string };
  if (a.draft !== undefined) {
    const d = await getDraft(env, a.draft);
    source = { name: d.id, list: d.list, subject: d.subject, html: d.html };
  } else {
    const s = typeof a.send === 'string' ? await env.DB.prepare('SELECT key, list, subject, html FROM sends WHERE key = ?').bind(a.send).first<{ key: string; list: string; subject: string; html: string }>() : null;
    if (!s) throw new HttpError(404, 'No send with that key. sends_list shows the keys.');
    source = { name: s.key, list: s.list, subject: s.subject, html: s.html };
  }
  // An assistant in a loop must not fill the team's inboxes. The slot is taken before the mail goes
  // out, by one statement that adds a row only while the last hour has fewer than the cap, so calls
  // that come at once cannot all pass. A call refused before this point takes none.
  const now = new Date();
  const slot = await env.DB.prepare(`INSERT INTO test_send_slots (client_id, at) SELECT ?1, ?2
      WHERE (SELECT COUNT(*) FROM test_send_slots WHERE at > ?3) < ?4`)
    .bind(clientId, iso(now), iso(new Date(now.getTime() - 3600_000)), testsPerHour).run();
  if (!slot.meta.changes) throw new HttpError(429, `At most ${testsPerHour} test sends an hour. Try again later.`);
  const key = `${source.name.slice(0, 60)}-test-${hex(4)}`;
  const created = await createSend(env, { key, list: source.list, kind: 'test', subject: source.subject, html: source.html, testTo: to.map(email => ({ email })) });
  const result = await runBatch(env, key, Math.max(1, created.recipients ?? 1));
  return { key, recipients: created.recipients, sent: result.sent, skipped: result.skipped, failed: result.failed };
}
