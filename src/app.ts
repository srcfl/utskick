// Every HTTP route. Public: unsubscribe, click, open, archive, images, the SES webhook, sign-up forms. /admin is for the CLI.
// Assistants: /mcp with a bearer token, OAuth under /oauth and /.well-known, and /approve/ for an admin (docs/mcp.md).
// /dashboard: read-only numbers for a signed-in admin (docs/dashboard.md).
import { approvalRoute } from './approvals.ts';
import { audit } from './audit.ts';
import { dashboardRoute } from './dashboard.ts';
import type { Env } from './env.ts';
import { forget, forgetStatements, importContacts } from './contacts.ts';
import { mcpRoute } from './mcp.ts';
import { adminOAuth, oauthRoute } from './oauth.ts';
import { archiveUnsubscribePage, confirmPage, donePage, notFound, testDonePage } from './pages.ts';
import { render } from './render.ts';
import { createSend, retryFailed, retryUnknown, runBatch, stats } from './send.ts';
import { isSnsUrl, regionOf, verifySns, type SnsMessage } from './sns.ts';
import { boundedText, signupRoute } from './signup.ts';
import { HttpError, iso, json, sameSecret } from './util.ts';

const token = '([0-9a-f]{32})';
const routes: [string, RegExp, (env: Env, request: Request, m: string[]) => Promise<Response>][] = [
  ['GET', new RegExp(`^/u/${token}$`), unsubscribePage],
  ['POST', new RegExp(`^/u/${token}$`), unsubscribe],
  ['GET', new RegExp(`^/c/${token}/(\\d{1,4})$`), click],
  ['HEAD', new RegExp(`^/c/${token}/(\\d{1,4})$`), click],
  ['GET', new RegExp(`^/o/${token}\\.gif$`), open],
  ['GET', /^\/a\/([a-z0-9-]+)$/, archive],
  ['GET', /^\/unsubscribe$/, async env => archiveUnsubscribePage(env.CONFIG)],
  ['GET', /^\/img\/([0-9a-f]{64}\.(?:jpg|png|gif|webp))$/, image],
  ['POST', /^\/hooks\/ses$/, sesWebhook],
];

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith('/admin/')) return await adminRoute(request, env, url.pathname);
    if (url.pathname === '/mcp') return await mcpRoute(request, env);
    if (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/')) {
      const res = await oauthRoute(request, env, url.pathname);
      if (res) return res;
    }
    if (url.pathname === '/subscribe') return await signupRoute(request, env);
    const approval = url.pathname.match(/^\/approve\/([A-Za-z0-9_-]{43})$/);
    if (approval) return await approvalRoute(request, env, approval[1]);
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) return await dashboardRoute(request, env, url);
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (m && request.method === method) return await handler(env, request, m);
    }
    if (url.pathname === '/') return Response.redirect(env.CONFIG.homepage, 302);
    return notFound(env.CONFIG);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error(JSON.stringify({ event: 'error', path: url.pathname, message: String(error) }));
    return json({ error: 'internal' }, 500);
  }
}

async function delivery(env: Env, t: string) {
  return env.DB.prepare(`SELECT d.id, d.contact_id, s.list, s.kind, s.links FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.token = ?`)
    .bind(t).first<{ id: number; contact_id: number; list: string; kind: string; links: string }>();
}

const listName = (env: Env, list: string) => env.CONFIG.lists[list]?.name ?? list;

// A GET never unsubscribes: mail scanners open links. The button posts what RFC 8058 clients post.
async function unsubscribePage(env: Env, _: Request, [, t]: string[]) {
  const d = await delivery(env, t);
  return d ? confirmPage(env.CONFIG, listName(env, d.list)) : notFound(env.CONFIG);
}

async function unsubscribe(env: Env, request: Request, [, t]: string[]) {
  const d = await delivery(env, t);
  if (!d) return notFound(env.CONFIG);
  await request.body?.cancel();
  // One unsubscribe event per mail, however often the link is posted.
  const logged = env.DB.prepare(`INSERT INTO events (delivery_id, type) SELECT ?1, 'unsubscribe'
    WHERE NOT EXISTS (SELECT 1 FROM events WHERE delivery_id = ?1 AND type = 'unsubscribe')`).bind(d.id);
  // A test mail proves the POST arrives, and takes nobody off a list.
  if (d.kind === 'test') {
    await logged.run();
    return testDonePage(env.CONFIG, listName(env, d.list));
  }
  const contact = await env.DB.prepare('SELECT email_hash FROM contacts WHERE id = ?').bind(d.contact_id).first<{ email_hash: string }>();
  if (contact) await env.DB.batch([...forgetStatements(env.DB, contact.email_hash, d.list, 'unsubscribe'), logged]);
  return donePage(env.CONFIG, listName(env, d.list));
}

async function click(env: Env, request: Request, [, t, n]: string[]) {
  const d = await delivery(env, t);
  const url = d && (JSON.parse(d.links) as string[])[Number(n)];
  if (!d || !url) return notFound(env.CONFIG);
  // Some link scanners send HEAD first; only a GET is someone clicking.
  let target: string;
  try { target = new URL(url).href; } catch { return notFound(env.CONFIG); }
  if (request.method === 'GET') await env.DB.prepare(`INSERT INTO events (delivery_id, type, link) SELECT ?1, 'click', ?2
    WHERE NOT EXISTS (SELECT 1 FROM events WHERE delivery_id = ?1 AND type = 'click' AND link = ?2 AND at > ?3)`)
    .bind(d.id, Number(n), iso(new Date(Date.now() - eventWindowMs))).run();
  return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

// At most one open per mail, and one click per mail and link, an hour: a loop on one token cannot
// fill the database, and the counts that matter (unique opens and clicks) stay the same.
const eventWindowMs = 60 * 60 * 1000;

// A 1×1 transparent GIF.
const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));

async function open(env: Env, _: Request, [, t]: string[]) {
  const d = await env.DB.prepare('SELECT id FROM deliveries WHERE token = ?').bind(t).first<{ id: number }>();
  if (d) await env.DB.prepare(`INSERT INTO events (delivery_id, type) SELECT ?1, 'open'
    WHERE NOT EXISTS (SELECT 1 FROM events WHERE delivery_id = ?1 AND type = 'open' AND at > ?2)`)
    .bind(d.id, iso(new Date(Date.now() - eventWindowMs))).run();
  return new Response(gif, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' } });
}

// The issue as a web page, for sharing: no name, no tracking, no personal unsubscribe link.
async function archive(env: Env, _: Request, [, key]: string[]) {
  const send = await env.DB.prepare(`SELECT html, fname_fallback FROM sends s WHERE key = ? AND kind = 'live'
      AND EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = s.id AND d.status = 'sent')`)
    .bind(key).first<{ html: string; fname_fallback: string }>();
  if (!send) return notFound(env.CONFIG);
  const html = render(send.html, { firstName: null, fallback: send.fname_fallback, unsubscribeUrl: `${env.PUBLIC_URL}/unsubscribe`, archiveUrl: `${env.PUBLIC_URL}/a/${key}` });
  // The issue is shown as it was sent, on the same origin as the admin pages, so it runs in a sandbox:
  // no scripts, no forms, no same-origin access, whatever the HTML holds.
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'Content-Security-Policy': "sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation; default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  } });
}

async function image(env: Env, _: Request, [, name]: string[]) {
  const object = await env.IMAGES?.get(name);
  if (!object) return notFound(env.CONFIG);
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' } });
}

// SES publishes bounces, complaints and deliveries to an SNS topic, and SNS posts them here.
// Nothing in the message is used, not even SubscribeURL, before its signature and topic check out.
async function sesWebhook(env: Env, request: Request) {
  // SNS messages are a few kilobytes; stop reading long before a big body can fill the isolate.
  const raw = await boundedText(request, 256 * 1024).catch(() => null);
  if (raw === null) return json({ error: 'too_large' }, 413);
  let m: SnsMessage;
  try { m = JSON.parse(raw); } catch { return json({ error: 'invalid_body' }, 400); }
  if (!m || typeof m !== 'object') return json({ error: 'invalid_body' }, 400);
  const region = regionOf(env.SNS_TOPIC_ARN ?? '');
  if (!region || m.TopicArn !== env.SNS_TOPIC_ARN || !await verifySns(m, region)) return json({ error: 'forbidden' }, 403);

  if (m.Type === 'SubscriptionConfirmation') {
    if (!m.SubscribeURL || !isSnsUrl(m.SubscribeURL, region)) return json({ error: 'forbidden' }, 403);
    const res = await fetch(m.SubscribeURL);
    return json({ confirmed: res.ok }, res.ok ? 200 : 502);
  }
  if (m.Type !== 'Notification') return json({ ok: true });

  const event = JSON.parse(m.Message);
  const type = event.eventType ?? event.notificationType;
  const messageId: string | undefined = event.mail?.messageId;
  const log = (t: string) => env.DB.prepare(`INSERT INTO events (delivery_id, type) SELECT id, ? FROM deliveries WHERE message_id = ?`).bind(t, messageId ?? '').run();
  if (type === 'Bounce') {
    const permanent = event.bounce?.bounceType === 'Permanent';
    await log(permanent ? 'bounce' : 'soft-bounce');
    // A hard bounce stops mail at once. A soft one (a full mailbox) only when it is the second mail to bounce.
    const softBounced = permanent ? 0 : await env.DB.prepare(`SELECT COUNT(DISTINCT e.delivery_id) AS n FROM events e JOIN deliveries d ON d.id = e.delivery_id
      WHERE e.type = 'soft-bounce' AND d.contact_id = (SELECT contact_id FROM deliveries WHERE message_id = ?)`).bind(messageId ?? '').first<number>('n');
    if (permanent || (softBounced ?? 0) >= 2) for (const r of event.bounce?.bouncedRecipients ?? []) await forget(env, r.emailAddress, '*', 'bounce');
  } else if (type === 'Complaint') {
    await log('complaint');
    for (const r of event.complaint?.complainedRecipients ?? []) await forget(env, r.emailAddress, '*', 'complaint');
  } else if (type === 'Delivery') {
    await log('delivery');
  }
  return json({ ok: true });
}

// The CLI's API, with the admin token. Every call that changes something is a row in the audit
// log, as client admin-token: the route, its outcome and counts, never an address or a body.
// Reads, dry runs and unknown routes change nothing and leave no row.
async function adminRoute(request: Request, env: Env, path: string) {
  if (!env.ADMIN_TOKEN || !await sameSecret(request.headers.get('Authorization') ?? '', `Bearer ${env.ADMIN_TOKEN}`)) return json({ error: 'unauthorized' }, 401);
  let body: Record<string, any> = {};
  if (request.method === 'POST') {
    let parsed: unknown = null;
    try { parsed = await request.json(); } catch { /* answered below */ }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: 'invalid_json' }, 400);
    body = parsed as Record<string, any>;
  }
  if ((request.method !== 'POST' && request.method !== 'PUT') || body.dryRun === true) return adminAction(request, env, path, body);
  const logged = async (status: number, result: Record<string, unknown>) => audit(env, {
    clientId: 'admin-token', subject: null, scope: null, tool: `${request.method} ${path.slice(0, 200)}`,
    summary: adminSummary(body, status, result), outcome: status < 400 ? 'ok' : 'error',
  });
  let res: Response;
  try {
    res = await adminAction(request, env, path, body);
  } catch (error) {
    await logged(error instanceof HttpError ? error.status : 500, {});
    throw error;
  }
  // A send runs as a batch a second; one row for creating it is enough, plus any batch that failed.
  const quiet = path.endsWith('/batch') && res.status < 400;
  if (res.status !== 404 && !quiet) await logged(res.status, await res.clone().json().catch(() => ({})) as Record<string, unknown>);
  return res;
}

// What the audit keeps of an admin call: the list, key or client it named, how many items each
// array held (contacts, suppressions, test addresses), and the numbers in the answer.
function adminSummary(body: Record<string, any>, status: number, result: Record<string, unknown>) {
  const s: Record<string, unknown> = {};
  for (const k of ['list', 'key', 'kind', 'parent', 'source', 'clientId']) if (typeof body[k] === 'string') s[k] = body[k].slice(0, 120);
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) s[k] = v.length;
    else if (typeof v === 'number' || typeof v === 'boolean') s[k] = v;
  }
  for (const [k, v] of Object.entries(result ?? {})) if (typeof v === 'number' || typeof v === 'boolean') s[k] = v;
  s.status = status;
  return s;
}

async function adminAction(request: Request, env: Env, path: string, body: Record<string, any>) {
  const now = typeof body.now === 'string' ? new Date(body.now) : new Date();
  let m: RegExpMatchArray | null;
  const oauth = await adminOAuth(request, env, path, body);
  if (oauth) return oauth;
  if (request.method === 'POST' && path === '/admin/import') return json(await importContacts(env, body as Parameters<typeof importContacts>[1], now));
  if (request.method === 'POST' && path === '/admin/sends') return json(await createSend(env, body as Parameters<typeof createSend>[1], now));
  if (request.method === 'POST' && (m = path.match(/^\/admin\/sends\/([a-z0-9-]+)\/batch$/))) return json(await runBatch(env, m[1], body.max ?? 10, now));
  if (request.method === 'POST' && (m = path.match(/^\/admin\/sends\/([a-z0-9-]+)\/retry-unknown$/))) return json(await retryUnknown(env, m[1]));
  if (request.method === 'POST' && (m = path.match(/^\/admin\/sends\/([a-z0-9-]+)\/retry-failed$/))) return json(await retryFailed(env, m[1]));
  if (request.method === 'GET' && (m = path.match(/^\/admin\/sends\/([a-z0-9-]+)$/))) return json(await stats(env, m[1]));
  if (request.method === 'PUT' && (m = path.match(/^\/admin\/images\/([0-9a-f]{64}\.(jpg|png|gif|webp))$/))) {
    if (!env.IMAGES) throw new HttpError(503, 'no_image_bucket');
    const type = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[m[2]]!;
    await env.IMAGES.put(m[1], request.body, { httpMetadata: { contentType: type } });
    return json({ url: `${env.PUBLIC_URL}/img/${m[1]}` });
  }
  return json({ error: 'not_found' }, 404);
}
