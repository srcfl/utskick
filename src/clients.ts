// OAuth clients: the assistants that connect. A client names itself either by an https URL whose
// document lists its name and redirect URIs (a client ID metadata document), or by registering
// here (RFC 7591), which ChatGPT and older clients still do. Ported from srcfl/ftw-cloud internal/oauth.
import type { Env } from './env.ts';
import { HttpError, iso, json, sha256 } from './util.ts';

export interface Client {
  id: string;
  name: string;
  // Where the name comes from: the document's host vouches for it; a registration's does not,
  // so the consent page shows a registered client by the host it sends the browser back to.
  host: string | null;
  redirectUris: string[];
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  secretHash: string | null;
  metadataDocument: boolean;
}

export const isMetadataUrl = (id: string) => id.startsWith('https://');

// The one custom scheme allowed: Cursor's desktop callback, which Cursor and some other desktop assistants use. Byte for byte.
export const cursorRedirect = 'cursor://anysphere.cursor-mcp/oauth/callback';
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

// A redirect URI is https, or http to this computer's loopback for a client running on it.
// No credentials, no fragment.
export function redirectAllowed(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  if (raw === cursorRedirect) return true;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password || raw.includes('#') || !u.hostname) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && loopback.has(u.hostname));
}

// Exactly as registered, or a loopback URI on any port: a local client takes whatever port is free (RFC 8252).
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try { g = new URL(given); } catch { return false; }
  return registered.some(r => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && g.protocol === 'http:' && loopback.has(u.hostname)
        && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    } catch { return false; }
  });
}

// A client's name is shown to an admin deciding whom to let in: one short line of plain text.
export function cleanName(s: unknown): string {
  if (typeof s !== 'string') return '';
  const one = s.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  const chars = [...one];
  return chars.length > 64 ? chars.slice(0, 64).join('') + '…' : one;
}

export async function findClient(env: Env, id: string): Promise<Client | null> {
  if (!id) return null;
  if (isMetadataUrl(id)) {
    const doc = await metadataDocument(env, id);
    return { id, name: doc.name, host: new URL(id).hostname, redirectUris: doc.redirectUris, authMethod: 'none', secretHash: null, metadataDocument: true };
  }
  const row = await env.DB.prepare('SELECT client_id, secret_hash, auth_method, name, uri, redirect_uris FROM oauth_clients WHERE client_id = ?').bind(id)
    .first<{ client_id: string; secret_hash: string | null; auth_method: Client['authMethod']; name: string; uri: string | null; redirect_uris: string }>();
  if (!row) return null;
  return { id: row.client_id, name: row.name, host: null, redirectUris: JSON.parse(row.redirect_uris), authMethod: row.auth_method, secretHash: row.secret_hash, metadataDocument: false };
}

// --------------------------------------------------------------------------
// Client ID metadata documents
// --------------------------------------------------------------------------

// The Worker fetches a URL a stranger chose, so the fetch is fenced: https on the default port
// to a DNS name (Workers cannot reach private addresses, and a literal address is refused here),
// never this Worker's own host, no redirects, 16 KiB, 5 seconds, and the answer cached a while.
const maxDocument = 16 * 1024;
interface CacheEntry { doc?: { name: string; redirectUris: string[] }; error?: string; until: number }
const cache = new Map<string, CacheEntry>();

function remember(id: string, entry: CacheEntry) {
  if (cache.size > 500) cache.clear();
  cache.set(id, entry);
}

// For tests that serve one URL different documents.
export const forgetMetadataDocuments = () => cache.clear();

function checkMetadataUrl(env: Env, raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'client_id is not a URL'); }
  const host = u.hostname;
  // The id must already be in canonical form (no dot segments, no :443, a lowercase host), since the
  // document has to name itself by exactly this string, and the admin is shown this host. A host
  // with an empty label is refused too: localhost. or news.example.com. is the same host, and would
  // slip past the names below.
  if (raw.length > 2048 || u.href !== raw || u.protocol !== 'https:' || u.username || u.password || raw.includes('#') || (u.port && u.port !== '443')
    || !host.includes('.') || host.split('.').some(label => !label)
    || /^[\d.]+$/.test(host) || host.startsWith('[') || host === 'localhost' || /\.(local|localhost|internal|test)$/.test(host)
    || u.pathname === '/' || host === new URL(env.PUBLIC_URL).hostname) {
    throw new HttpError(400, 'client_id is not a URL this server fetches');
  }
  return u;
}

async function metadataDocument(env: Env, id: string) {
  const u = checkMetadataUrl(env, id);
  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) {
    if (hit.doc) return hit.doc;
    throw new HttpError(400, hit.error!);
  }
  try {
    const doc = await fetchDocument(u, id);
    remember(id, { doc: doc.doc, until: Date.now() + doc.ttl });
    return doc.doc;
  } catch (error) {
    const message = error instanceof HttpError ? error.message : 'client metadata could not be fetched';
    remember(id, { error: message, until: Date.now() + 60_000 });
    throw new HttpError(400, message);
  }
}

async function fetchDocument(u: URL, id: string) {
  const res = await fetch(u, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (res.status !== 200) throw new HttpError(400, `client metadata answered ${res.status}`);
  const body = await readLimited(res, maxDocument);
  let doc: Record<string, any>;
  try { doc = JSON.parse(body); } catch { throw new HttpError(400, 'client metadata is not JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'client metadata is not a JSON object');
  // A public document holds no secret, so a client that puts one there has none.
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) throw new HttpError(400, 'client metadata holds a secret');
  if (doc.client_id !== id) throw new HttpError(400, 'client_id does not match its URL');
  const name = cleanName(doc.client_name);
  if (!name) throw new HttpError(400, 'client metadata has no client_name');
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 16 || !uris.every(redirectAllowed)) throw new HttpError(400, 'client metadata has redirect_uris this server does not take');
  // The plural field lists what the client can do; the singular one is a preference. Only "none" works here.
  const methods = doc.token_endpoint_auth_methods_supported;
  if (Array.isArray(methods) ? !methods.includes('none') : (doc.token_endpoint_auth_method ?? 'none') !== 'none') {
    throw new HttpError(400, 'client metadata needs token_endpoint_auth_method none');
  }
  // A client may list grants this server lacks (Claude lists the JWT bearer grant); it must have the code grant.
  if ((Array.isArray(doc.grant_types) && !doc.grant_types.includes('authorization_code')) || (Array.isArray(doc.response_types) && !doc.response_types.includes('code'))) {
    throw new HttpError(400, 'client metadata lacks the authorization_code grant');
  }
  return { doc: { name, redirectUris: uris as string[] }, ttl: cacheFor(res.headers.get('Cache-Control')) };
}

async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('Content-Length') ?? 0);
  if (declared > max) throw new HttpError(400, 'client metadata is too large');
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(400, 'client metadata is too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

// At least a minute, so a page that loads again and again cannot make us fetch each time; at most a day.
function cacheFor(header: string | null): number {
  const m = header?.match(/max-age=(\d+)/i);
  const seconds = m ? Number(m[1]) : /no-store|no-cache/i.test(header ?? '') ? 60 : 600;
  return Math.min(Math.max(seconds, 60), 86_400) * 1000;
}

// --------------------------------------------------------------------------
// Dynamic registration (RFC 7591)
// --------------------------------------------------------------------------

const maxClients = 10_000;
// Far below maxClients, so no one address can fill the table, and above what a team's own
// assistants need: ChatGPT registers once for each connector someone adds.
const perAddressPerDay = 20;
const day = 86_400_000;

// Cloudflare sets CF-Connecting-IP on every request from the internet; without it (cf dev, tests)
// there is no limit. An IPv6 client usually holds a whole /64, so the /64 counts as one address.
function sourceOf(request: Request): string | null {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !ip.includes(':')) return ip;
  const [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${full.slice(0, 4).map(x => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// A burst limit: Workers Rate Limiting when the binding is there (cloudflare.config.ts, shared with
// /subscribe under its own keys), else a bucket per isolate.
const buckets = new Map<string, { tokens: number; at: number }>();

async function allowBurst(env: Env, source: string, now: number): Promise<boolean> {
  if (env.SIGNUP_LIMITER) return (await env.SIGNUP_LIMITER.limit({ key: `register:${source}` })).success;
  if (buckets.size > 10_000) buckets.clear();
  const b = buckets.get(source) ?? { tokens: 10, at: now };
  b.tokens = Math.min(10, b.tokens + (now - b.at) / 6000);
  b.at = now;
  buckets.set(source, b);
  if (b.tokens < 1) return false;
  b.tokens--;
  return true;
}

export async function register(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const source = sourceOf(request);
  if (source && !await allowBurst(env, source, now)) return registerError(429, 'invalid_client_metadata', 'too many registrations; try again shortly');

  const text = await request.text();
  let reg: Record<string, any>;
  try { reg = text.length <= 16_384 ? JSON.parse(text) : null; } catch { reg = null as any; }
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return registerError(400, 'invalid_client_metadata', 'the body is not a JSON object');
  const uris = reg.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 16) return registerError(400, 'invalid_redirect_uri', 'redirect_uris must list between 1 and 16 URIs');
  const bad = uris.find(u => !redirectAllowed(u));
  if (bad !== undefined) return registerError(400, 'invalid_redirect_uri', `redirect URI ${JSON.stringify(bad).slice(0, 200)} is neither https nor loopback http`);
  const method = reg.token_endpoint_auth_method ?? 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return registerError(400, 'invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic');
  // Grants this server lacks are left out of what it registers, as RFC 7591 allows.
  const grants = Array.isArray(reg.grant_types) ? reg.grant_types.filter((g: unknown) => g === 'authorization_code' || g === 'refresh_token') : ['authorization_code', 'refresh_token'];
  if (!grants.includes('authorization_code') || (Array.isArray(reg.response_types) && !reg.response_types.includes('code'))) {
    return registerError(400, 'invalid_client_metadata', 'the authorization_code grant, with response type code, is required');
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_clients').first<number>('n');
  if ((count ?? 0) >= maxClients) return registerError(503, 'invalid_client_metadata', 'registration is full');
  // The daily cap, kept in D1 so it holds across isolates. One statement takes the slot, so calls
  // that come at once cannot all pass. The address is kept only as a hash, and only for a day.
  if (source) {
    const taken = await env.DB.prepare(`INSERT INTO oauth_registrations (source, at) SELECT ?1, ?2
        WHERE (SELECT COUNT(*) FROM oauth_registrations WHERE source = ?1 AND at > ?3) < ?4`)
      .bind(await sha256(source), iso(new Date(now)), iso(new Date(now - day)), perAddressPerDay).run();
    if (!taken.meta.changes) return registerError(429, 'invalid_client_metadata', `at most ${perAddressPerDay} registrations a day from one address`);
  }

  const name = cleanName(reg.client_name) || 'An unnamed assistant';
  const uri = typeof reg.client_uri === 'string' && /^https:\/\/[^\s]+$/.test(reg.client_uri) && reg.client_uri.length < 512 ? reg.client_uri : null;
  const id = `utk_c_${randomToken(16)}`;
  const secret = method === 'none' ? null : `utk_cs_${randomToken(32)}`;
  await env.DB.prepare('INSERT INTO oauth_clients (client_id, secret_hash, auth_method, name, uri, redirect_uris) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, secret && await sha256(secret), method, name, uri, JSON.stringify(uris)).run();
  return json({
    client_id: id,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: method,
    grant_types: grants.length ? grants : ['authorization_code'],
    response_types: ['code'],
    ...(uri ? { client_uri: uri } : {}),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  }, 201);
}

function registerError(status: number, error: string, description: string) {
  return json({ error, error_description: description }, status);
}

// Registered clients without a grant are dropped after an hour: a client registers just before
// an admin signs it in, and one that never gets in cannot keep a row. The cap per address forgets after a day.
export function sweepClients(env: Env, now: Date) {
  return [
    env.DB.prepare(`DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_grants)`)
      .bind(iso(new Date(now.getTime() - 3600_000))),
    env.DB.prepare('DELETE FROM oauth_registrations WHERE at <= ?').bind(iso(new Date(now.getTime() - day))),
  ];
}

export function randomToken(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
