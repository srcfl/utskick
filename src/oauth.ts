// The authorization server for assistants, and the token check /mcp runs on every request.
// It follows the MCP authorization spec, revision 2026-07-28, as srcfl/ftw-cloud does: OAuth 2.1
// with PKCE S256 only, server metadata (RFC 8414) with iss in every authorization response
// (RFC 9207), protected resource metadata for /mcp (RFC 9728), tokens bound to /mcp by the
// resource parameter (RFC 8707), client ID metadata documents, and dynamic registration (RFC 7591).
//
// An admin signs in (identity.ts) and ticks what the assistant may do. Sending to a list is never
// one of those things: the assistant can only ask, and an admin approves each send (approvals.ts).
import { findClient, randomToken, redirectAllowed, redirectMatches, register, sweepClients, cursorRedirect, type Client } from './clients.ts';
import type { Env } from './env.ts';
import { signedInAdmin } from './identity.ts';
import { page } from './pages.ts';
import { escapeHtml } from './render.ts';
import { iso, json, sha256 } from './util.ts';

// What each scope lets an assistant do, as the consent page says it.
export const scopes = {
  'stats.read': 'See each send’s numbers and clicks per link. Never who got it.',
  'subscribers.read': 'See how many people are on each list. Never who.',
  'drafts.write': 'Write and preview drafts, and ask you to approve sending one to a list.',
  'test.send': 'Send a draft or an issue as a test, only to the test addresses in the config.',
} as const;
export type Scope = keyof typeof scopes;
export const allScopes = Object.keys(scopes) as Scope[];
const isScope = (s: string): s is Scope => Object.hasOwn(scopes, s);
// In the order of allScopes, so a scope string reads the same wherever it is written.
export const scopeList = (want: Iterable<string>) => { const w = new Set(want); return allScopes.filter(s => w.has(s)); };

const minute = 60_000;
const accessTtl = 10 * minute;            // short: a leaked token is worth little
const refreshTtl = 30 * 24 * 60 * minute; // an idle assistant signs in again after a month
const grantTtl = 90 * 24 * 60 * minute;   // and every assistant after three
const codeTtl = minute;
const consentTtl = 10 * minute;
const refreshGrace = 5000;                // a client whose answer got lost may retry once

export const issuer = (env: Env) => new URL(env.PUBLIC_URL).origin;
export const resourceOf = (env: Env) => `${issuer(env)}/mcp`;
const resourceMetadataUrl = (env: Env) => `${issuer(env)}/.well-known/oauth-protected-resource/mcp`;
const docs = 'https://github.com/srcfl/utskick/blob/main/docs/mcp.md';

export async function oauthRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = request.method;
  if (m === 'OPTIONS' && (path.startsWith('/.well-known/') || ['/oauth/token', '/oauth/register', '/oauth/revoke'].includes(path))) return cors(new Response(null, { status: 204 }));
  if (m === 'GET' && path === '/.well-known/oauth-authorization-server') return cors(json(serverMetadata(env)));
  if (m === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) return cors(json(resourceMetadata(env)));
  if (path === '/oauth/authorize' && m === 'GET') return framed(await authorize(request, env));
  if (path === '/oauth/authorize' && m === 'POST') return framed(await decide(request, env));
  if (path === '/oauth/token' && m === 'POST') return cors(await tokenEndpoint(request, env));
  if (path === '/oauth/register' && m === 'POST') return cors(await register(request, env));
  if (path === '/oauth/revoke' && m === 'POST') return cors(await revokeEndpoint(request, env));
  return null;
}

function serverMetadata(env: Env) {
  const base = issuer(env);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: allScopes,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: docs,
  };
}

function resourceMetadata(env: Env) {
  return {
    resource: resourceOf(env),
    authorization_servers: [issuer(env)],
    scopes_supported: allScopes,
    bearer_methods_supported: ['header'],
    resource_name: `Utskick for ${env.CONFIG.organization}`,
    resource_documentation: docs,
  };
}

// Browser-based clients (the MCP inspector) read the metadata and call these endpoints.
// None of them uses cookies, so any origin may.
function cors(res: Response): Response {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
  return res;
}

// The pages an admin acts on may not sit in another site's frame, where a click could be borrowed.
export function framed(res: Response): Response {
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  return res;
}

// A resource parameter names /mcp, give or take the case of the host and a trailing slash.
function sameResource(env: Env, raw: string): boolean {
  try {
    const u = new URL(raw);
    return !u.search && !u.hash && `${u.origin}${u.pathname.replace(/\/$/, '')}` === resourceOf(env);
  } catch {
    return false;
  }
}

// The client's redirect URI with the response, and iss, as RFC 9207 asks of every response.
function authorizationResponse(env: Env, redirect: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  u.searchParams.set('iss', issuer(env));
  return u.toString();
}

// The same origin as this Worker: a form an admin submits here, not one posted from elsewhere.
export function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (origin) return origin === issuer(env);
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

export function messagePage(env: Env, status: number, title: string, text: string, back?: string): Response {
  let link = '';
  if (back) {
    const u = new URL(back);
    const where = u.protocol === 'http:' || u.protocol === 'https:' ? u.host : `${u.protocol}//${u.host}`;
    link = `<p><a href="${escapeHtml(back)}">Back to ${escapeHtml(where)}</a></p>`;
  }
  return page(env.CONFIG, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${link}`, status);
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const text = await request.text();
  if (text.length > 16_384) return null;
  return new URLSearchParams(text);
}

// --------------------------------------------------------------------------
// Authorize: an admin approves a client
// --------------------------------------------------------------------------

async function authorize(request: Request, env: Env): Promise<Response> {
  // Who comes first: nothing is fetched or stored for a stranger.
  const who = await signedInAdmin(request, env);
  if (!who.ok) return messagePage(env, who.status, 'Sign-in needed', who.reason);
  const q = new URL(request.url).searchParams;
  for (const k of new Set(q.keys())) {
    if (q.getAll(k).length > 1) return messagePage(env, 400, 'This link is not valid', `The parameter ${k} appears more than once.`);
  }
  let client: Client | null = null;
  let why = '';
  try {
    client = await findClient(env, q.get('client_id') ?? '');
  } catch (error) {
    why = ` (${error instanceof Error ? error.message : 'unknown error'})`;
  }
  if (!client) return messagePage(env, 400, 'This assistant is not known here', `The link names a client Utskick cannot check${why}. Ask the assistant to connect again.`);
  // Until client and redirect URI check out, nothing goes back to the client: a bad request
  // could otherwise send the browser anywhere.
  const given = q.get('redirect_uri');
  const redirect = given ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
  if (!redirect || !redirectAllowed(redirect) || !redirectMatches(client.redirectUris, redirect)) {
    return messagePage(env, 400, 'This link is not valid', 'The assistant asked to return somewhere it did not register.');
  }
  // From here an error goes back to the client, as a link the admin follows rather than a redirect,
  // so no registered client can bounce a browser through here unseen (RFC 9700, 4.11.2).
  const state = q.get('state');
  const fail = (code: string, description: string) => messagePage(env, 400, 'This request cannot go on',
    `Utskick cannot connect ${client.name}: ${description}.`, authorizationResponse(env, redirect, { error: code, error_description: description, state }));
  if (state && state.length > 1024) return fail('invalid_request', 'state is too long');
  if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'only response_type=code');
  const challenge = q.get('code_challenge') ?? '';
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  const resource = q.get('resource');
  if (resource !== null && !sameResource(env, resource)) return fail('invalid_target', `this server issues tokens only for ${resourceOf(env)}`);
  const asked: string[] = [];
  for (const s of (q.get('scope') ?? '').split(' ').filter(Boolean)) {
    if (s === 'offline_access') continue; // refresh tokens come anyway
    if (!isScope(s)) return fail('invalid_scope', `unknown scope ${s}`);
    asked.push(s);
  }
  // A client that names no scope is offered all of them; the admin unticks what it should not have.
  const offered = asked.length ? scopeList(asked) : allScopes;
  const id = randomToken(32);
  await env.DB.prepare(`INSERT INTO oauth_consents (id_hash, subject, client_id, client_name, redirect_uri, redirect_given, state, challenge, scope, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(id), who.email, client.id, client.name, redirect, given === null ? 0 : 1, state, challenge, offered.join(' '), iso(new Date(Date.now() + consentTtl)))
    .run();
  return consentPage(env, id, who.email, client, redirect, offered);
}

function consentPage(env: Env, id: string, email: string, client: Client, redirect: string, offered: Scope[]): Response {
  const back = new URL(redirect);
  const local = redirect === cursorRedirect || back.protocol === 'http:';
  const from = client.metadataDocument
    ? `It names itself through a document on <strong>${escapeHtml(client.host!)}</strong>.`
    : 'It registered itself here, so its name proves nothing.';
  const goes = local
    ? 'After you answer, your browser goes back to a program on this computer. Approve only if you just started this connection yourself.'
    : `After you answer, your browser goes back to <strong>${escapeHtml(back.host)}</strong>.`;
  const boxes = offered.map(s => `<p><label><input type="checkbox" name="scope" value="${s}" checked> <strong>${s}</strong>: ${escapeHtml(scopes[s])}</label></p>`).join('');
  return page(env.CONFIG, `Connect ${client.name}`, `<h1>Connect ${escapeHtml(client.name)}?</h1>
<p>${escapeHtml(client.name)} wants to use Utskick for ${escapeHtml(env.CONFIG.organization)} as you, ${escapeHtml(email)}. ${from}</p>
<p>${goes}</p>
<form method="post">
<input type="hidden" name="request" value="${id}">
${boxes}
<p class="small">Sending to a list is not one of these. The assistant can only ask, and you approve each send on a page of its own.</p>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" style="background:transparent;color:var(--ink);border:1px solid var(--line)">Deny</button>
</form>
<p class="small">This request ends in ten minutes. You can revoke the assistant at any time.</p>`);
}

interface ConsentRow {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  redirect_given: number;
  state: string | null;
  challenge: string;
  scope: string;
  expires_at: string;
}

async function decide(request: Request, env: Env): Promise<Response> {
  const who = await signedInAdmin(request, env);
  if (!who.ok) return messagePage(env, who.status, 'Sign-in needed', who.reason);
  if (!sameOrigin(request, env)) return messagePage(env, 403, 'This form came from elsewhere', 'Open the link the assistant gave you again.');
  const form = await readForm(request);
  const now = new Date();
  // Taken once, by the admin who saw it: a second answer, or another admin's, finds nothing.
  const row = form && await env.DB.prepare(`DELETE FROM oauth_consents WHERE id_hash = ? AND subject = ? RETURNING *`)
    .bind(await sha256(form.get('request') ?? ''), who.email).first<ConsentRow>();
  if (!form || !row || row.expires_at <= iso(now)) {
    return messagePage(env, 400, 'This request is over', 'It was answered already, or it ran out. Ask the assistant to connect again.');
  }
  const back = (params: Record<string, string | null>) =>
    new Response(null, { status: 303, headers: { Location: authorizationResponse(env, row.redirect_uri, params), 'Cache-Control': 'no-store' } });
  if (form.get('decision') !== 'approve') return back({ error: 'access_denied', error_description: 'the admin did not approve', state: row.state });
  const ticked = new Set(form.getAll('scope'));
  const granted = row.scope.split(' ').filter(s => ticked.has(s));
  if (!granted.length) return back({ error: 'access_denied', error_description: 'the admin approved no rights', state: row.state });

  const grant = randomToken(16);
  const code = `utk_ac_${randomToken(32)}`;
  const scope = scopeList(granted).join(' ');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO oauth_grants (id, client_id, client_name, subject, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(grant, row.client_id, row.client_name, who.email, scope, resourceOf(env), iso(new Date(now.getTime() + grantTtl))),
    env.DB.prepare(`INSERT INTO oauth_tokens (hash, kind, grant_id, client_id, scope, resource, expires_at, challenge, redirect_uri, redirect_given)
        VALUES (?, 'code', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(await sha256(code), grant, row.client_id, scope, resourceOf(env), iso(new Date(now.getTime() + codeTtl)), row.challenge, row.redirect_uri, row.redirect_given),
  ]);
  return back({ code, state: row.state });
}

// --------------------------------------------------------------------------
// Token and revocation endpoints
// --------------------------------------------------------------------------

function tokenError(status: number, error: string, description: string, headers: Record<string, string> = {}) {
  const res = json({ error, error_description: description }, status);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

const invalidGrant = (description: string) => tokenError(400, 'invalid_grant', description);

// The client of a token or revocation request: its id in Basic or in the form, and its secret if it has one.
async function authenticateClient(request: Request, env: Env, form: URLSearchParams): Promise<{ id: string } | null> {
  let id = form.get('client_id') ?? '';
  let secret = form.get('client_secret') ?? '';
  const basic = request.headers.get('Authorization')?.match(/^Basic\s+(\S+)$/i);
  if (basic) {
    try {
      const [user, ...pass] = atob(basic[1]).split(':');
      id = decodeURIComponent(user);
      secret = decodeURIComponent(pass.join(':'));
    } catch {
      return null;
    }
  }
  if (!id) return null;
  // A metadata document's client is public; it was checked when the admin approved it,
  // and its id is bound to the code and the tokens.
  if (id.startsWith('https://')) return secret ? null : { id };
  const client = await findClient(env, id);
  if (!client) return null;
  if (client.authMethod === 'none') return secret ? null : { id };
  if (!secret || !client.secretHash) return null;
  return equal(await sha256(secret), client.secretHash) ? { id } : null;
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function tokenEndpoint(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (!form) return tokenError(400, 'invalid_request', 'the body is not a form');
  for (const k of new Set(form.keys())) if (form.getAll(k).length > 1) return tokenError(400, 'invalid_request', `${k} appears more than once`);
  const client = await authenticateClient(request, env, form);
  if (!client) {
    const basic = /^Basic /i.test(request.headers.get('Authorization') ?? '');
    return tokenError(401, 'invalid_client', 'client authentication failed', basic ? { 'WWW-Authenticate': 'Basic realm="Utskick"' } : {});
  }
  const resource = form.get('resource');
  if (resource !== null && !sameResource(env, resource)) return tokenError(400, 'invalid_target', `this server issues tokens only for ${resourceOf(env)}`);
  const grantType = form.get('grant_type');
  if (grantType === 'authorization_code') return exchangeCode(env, form, client.id);
  if (grantType === 'refresh_token') return refresh(env, form, client.id);
  return tokenError(400, 'unsupported_grant_type', 'authorization_code or refresh_token');
}

interface TokenRow {
  kind: 'code' | 'access' | 'refresh';
  grant_id: string;
  client_id: string;
  scope: string;
  resource: string;
  expires_at: string;
  challenge: string | null;
  redirect_uri: string | null;
  redirect_given: number | null;
}

interface GrantRow {
  id: string;
  client_id: string;
  client_name: string;
  subject: string;
  scope: string;
  resource: string;
  expires_at: string;
}

async function pkceS256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function exchangeCode(env: Env, form: URLSearchParams, clientId: string): Promise<Response> {
  const verifier = form.get('code_verifier') ?? '';
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return tokenError(400, 'invalid_request', 'code_verifier is required');
  const now = new Date();
  const hash = await sha256(form.get('code') ?? '');
  const row = await env.DB.prepare(`SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'code'`).bind(hash).first<TokenRow>();
  if (!row) return invalidGrant('the code is not valid');
  // Spent before anything else, so two requests with one code cannot both win. A code used
  // twice means whoever holds the first tokens may not be the client: they go.
  const spent = await env.DB.prepare(`UPDATE oauth_tokens SET uses = 1, used_at = ? WHERE hash = ? AND uses = 0`).bind(iso(now), hash).run();
  if (!spent.meta.changes) {
    await revokeGrant(env, row.grant_id);
    return invalidGrant('the code was used before');
  }
  const redirect = form.get('redirect_uri');
  if (row.expires_at <= iso(now) || row.client_id !== clientId || await pkceS256(verifier) !== row.challenge
    // A redirect_uri the authorize request named must be named again, the same.
    || ((row.redirect_given || redirect !== null) && redirect !== row.redirect_uri)) {
    return invalidGrant('the code is not valid');
  }
  const grant = await liveGrant(env, row.grant_id, now);
  if (!grant) return invalidGrant('the grant was revoked');
  if (grant.resource !== resourceOf(env) || row.resource !== resourceOf(env)) return invalidGrant('the code is for another resource');
  return issue(env, grant, row.scope, now, hash);
}

async function refresh(env: Env, form: URLSearchParams, clientId: string): Promise<Response> {
  const now = new Date();
  const hash = await sha256(form.get('refresh_token') ?? '');
  const row = await env.DB.prepare(`SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'`).bind(hash).first<TokenRow>();
  if (!row || row.client_id !== clientId || row.expires_at <= iso(now)) return invalidGrant('the refresh token is not valid');
  // Made while this Worker answered at another address (a deploy in development mode, a new
  // PUBLIC_URL): such a token is not turned into one for this address.
  if (row.resource !== resourceOf(env)) return invalidGrant('the refresh token is for another resource');
  let scope = row.scope;
  const asked = (form.get('scope') ?? '').split(' ').filter(Boolean);
  if (asked.length) {
    const have = row.scope.split(' ');
    if (asked.some(s => !have.includes(s))) return tokenError(400, 'invalid_scope', 'a refresh cannot widen the scope');
    scope = scopeList(asked).join(' ');
  }
  const first = await env.DB.prepare(`UPDATE oauth_tokens SET uses = 1, used_at = ? WHERE hash = ? AND uses = 0`).bind(iso(now), hash).run();
  if (!first.meta.changes) {
    const retry = await env.DB.prepare(`UPDATE oauth_tokens SET uses = 2 WHERE hash = ? AND uses = 1 AND used_at >= ?`)
      .bind(hash, iso(new Date(now.getTime() - refreshGrace))).run();
    // A retry within the grace: the client lost the first answer. What that answer issued must
    // die, or two chains of tokens live on. Its refresh token is marked spent rather than deleted,
    // so whoever holds it ends the grant by using it. If it was used already, the first chain has
    // moved on, and this is a second holder.
    const superseded = retry.meta.changes
      ? await env.DB.prepare(`UPDATE oauth_tokens SET uses = 2, used_at = ? WHERE parent = ? AND kind = 'refresh' AND uses = 0`).bind(iso(now), hash).run()
      : null;
    if (!superseded?.meta.changes) {
      // One refresh token used twice: one of its two holders stole it.
      await revokeGrant(env, row.grant_id);
      return invalidGrant('the refresh token was used before');
    }
    await env.DB.prepare(`DELETE FROM oauth_tokens WHERE parent = ? AND kind = 'access'`).bind(hash).run();
  }
  const grant = await liveGrant(env, row.grant_id, now);
  if (!grant) return invalidGrant('the grant was revoked');
  if (grant.resource !== resourceOf(env)) return invalidGrant('the grant is for another resource');
  return issue(env, grant, scope, now, hash);
}

function liveGrant(env: Env, id: string, now: Date) {
  return env.DB.prepare(`SELECT * FROM oauth_grants WHERE id = ? AND expires_at > ?`).bind(id, iso(now)).first<GrantRow>();
}

// A new access token and refresh token for one grant. Neither outlives the grant. `parent` is the
// hash of the code or refresh token they are issued for.
async function issue(env: Env, grant: GrantRow, scope: string, now: Date, parent: string): Promise<Response> {
  const end = Date.parse(grant.expires_at);
  const accessEnd = Math.min(now.getTime() + accessTtl, end);
  const refreshEnd = Math.min(now.getTime() + refreshTtl, end);
  const access = `utk_at_${randomToken(32)}`;
  const refreshToken = `utk_rt_${randomToken(32)}`;
  const insert = `INSERT INTO oauth_tokens (hash, kind, grant_id, client_id, scope, resource, expires_at, parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  await env.DB.batch([
    env.DB.prepare(insert).bind(await sha256(access), 'access', grant.id, grant.client_id, scope, resourceOf(env), iso(new Date(accessEnd)), parent),
    env.DB.prepare(insert).bind(await sha256(refreshToken), 'refresh', grant.id, grant.client_id, scope, resourceOf(env), iso(new Date(refreshEnd)), parent),
    env.DB.prepare(`UPDATE oauth_grants SET used_at = ? WHERE id = ?`).bind(iso(now), grant.id),
  ]);
  const res = json({ access_token: access, token_type: 'Bearer', expires_in: Math.floor((accessEnd - now.getTime()) / 1000), refresh_token: refreshToken, scope });
  res.headers.set('Pragma', 'no-cache');
  return res;
}

// Ends a grant: revoked by its client, or a code or refresh token used twice. A send its assistant
// asked for and nobody approved must not go out on a later click, as when an admin revokes the
// client. A request made before grant_id was recorded is matched by client and admin.
export async function revokeGrant(env: Env, id: string) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE approvals SET status = 'declined', decided_by = 'grant revoked', decided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE status = 'pending' AND (grant_id = ?1 OR (grant_id IS NULL
        AND EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = ?1 AND g.client_id = approvals.client_id AND g.subject = approvals.requested_by)))`).bind(id),
    env.DB.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').bind(id),
    env.DB.prepare('DELETE FROM oauth_grants WHERE id = ?').bind(id),
  ]);
}

// RFC 7009. A refresh token takes its grant with it. The answer is 200 whether or not the token was known.
async function revokeEndpoint(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (!form) return tokenError(400, 'invalid_request', 'the body is not a form');
  const client = await authenticateClient(request, env, form);
  if (!client) return tokenError(401, 'invalid_client', 'client authentication failed');
  const hash = await sha256(form.get('token') ?? '');
  const row = await env.DB.prepare(`SELECT kind, grant_id, client_id FROM oauth_tokens WHERE hash = ?`).bind(hash).first<TokenRow>();
  if (row && row.client_id === client.id) {
    if (row.kind === 'refresh') await revokeGrant(env, row.grant_id);
    else if (row.kind === 'access') await env.DB.prepare('DELETE FROM oauth_tokens WHERE hash = ?').bind(hash).run();
  }
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}

// --------------------------------------------------------------------------
// The resource server's side: a bearer token at /mcp
// --------------------------------------------------------------------------

export interface Grant {
  id: string;
  clientId: string;
  clientName: string;
  subject: string;  // the admin who approved the client
  scopes: Scope[];
}

export interface AuthFailure {
  status: 401 | 403;
  error?: 'invalid_token' | 'insufficient_scope';
  description?: string;
  scope?: string;
}

// An access token this server issued, not expired, for /mcp, whose grant nobody revoked.
// Tokens in the query string are not read.
export async function authenticate(request: Request, env: Env): Promise<Grant | AuthFailure> {
  const m = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(\S+)\s*$/i);
  if (!m) return { status: 401, scope: allScopes.join(' ') };
  const invalid: AuthFailure = { status: 401, error: 'invalid_token', description: 'the access token is not valid' };
  if (!m[1].startsWith('utk_at_')) return invalid;
  const now = iso(new Date());
  const row = await env.DB.prepare(`SELECT t.scope, t.resource, t.expires_at, g.id, g.client_id, g.client_name, g.subject, g.expires_at AS grant_expires
      FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ? AND t.kind = 'access'`).bind(await sha256(m[1]))
    .first<{ scope: string; resource: string; expires_at: string; id: string; client_id: string; client_name: string; subject: string; grant_expires: string }>();
  if (!row || row.expires_at <= now || row.grant_expires <= now) return invalid;
  if (row.resource !== resourceOf(env)) return { ...invalid, description: 'the access token is for another resource' };
  return { id: row.id, clientId: row.client_id, clientName: row.client_name, subject: row.subject, scopes: scopeList(row.scope.split(' ')) };
}

export function challengeHeader(env: Env, f: AuthFailure): string {
  const parts = [`resource_metadata="${resourceMetadataUrl(env)}"`];
  if (f.error) parts.push(`error="${f.error}"`);
  if (f.description) parts.push(`error_description="${f.description}"`);
  if (f.scope) parts.push(`scope="${f.scope}"`);
  return `Bearer ${parts.join(', ')}`;
}

export function challenge(env: Env, f: AuthFailure): Response {
  const res = json({ error: f.error ?? 'unauthorized', error_description: f.description ?? `a bearer token from ${issuer(env)} is required` }, f.status);
  res.headers.set('WWW-Authenticate', challengeHeader(env, f));
  return res;
}

// --------------------------------------------------------------------------
// /admin: grants, revocation per client, the audit log
// --------------------------------------------------------------------------

export async function adminOAuth(request: Request, env: Env, path: string, body: Record<string, any>): Promise<Response | null> {
  if (request.method === 'GET' && path === '/admin/oauth/grants') {
    const grants = (await env.DB.prepare(`SELECT id, client_id, client_name, subject, scope, created_at, expires_at, used_at FROM oauth_grants ORDER BY created_at DESC`).all()).results;
    return json({ grants });
  }
  if (request.method === 'POST' && path === '/admin/oauth/revoke') {
    const id = body.clientId;
    if (typeof id !== 'string' || !id) return json({ error: 'invalid_client_id' }, 400);
    const results = await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_tokens WHERE client_id = ?').bind(id),
      env.DB.prepare('DELETE FROM oauth_grants WHERE client_id = ?').bind(id),
      env.DB.prepare('DELETE FROM oauth_consents WHERE client_id = ?').bind(id),
      env.DB.prepare('DELETE FROM oauth_clients WHERE client_id = ?').bind(id),
      // A send the revoked assistant asked for must not go out on a later click.
      env.DB.prepare(`UPDATE approvals SET status = 'declined', decided_by = 'client revoked', decided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE client_id = ? AND status = 'pending'`).bind(id),
    ]);
    return json({ tokens: results[0].meta.changes, grants: results[1].meta.changes, registration: results[3].meta.changes > 0, approvalsWithdrawn: results[4].meta.changes });
  }
  if (request.method === 'GET' && path === '/admin/audit') {
    const limit = Math.max(1, Math.min(1000, Number(new URL(request.url).searchParams.get('limit')) || 200));
    const entries = (await env.DB.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).bind(limit).all()).results;
    return json({ entries });
  }
  return null;
}

// What has run out. A spent code stays while its grant lives, so a late second use still ends it.
export async function sweepOAuth(env: Env, now: Date) {
  const t = iso(now);
  await env.DB.batch([
    // test_send counts the last hour (approvals.ts).
    env.DB.prepare('DELETE FROM test_send_slots WHERE at <= ?').bind(iso(new Date(now.getTime() - 60 * minute))),
    env.DB.prepare('DELETE FROM oauth_consents WHERE expires_at <= ?').bind(t),
    env.DB.prepare(`DELETE FROM oauth_tokens WHERE expires_at <= ? AND NOT (kind = 'code' AND uses > 0)`).bind(t),
    env.DB.prepare(`DELETE FROM oauth_grants WHERE expires_at <= ? OR NOT EXISTS
      (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id AND (t.kind != 'code' OR t.uses = 0))`).bind(t),
    env.DB.prepare('DELETE FROM oauth_tokens WHERE grant_id NOT IN (SELECT id FROM oauth_grants)'),
    ...sweepClients(env, now),
  ]);
}
