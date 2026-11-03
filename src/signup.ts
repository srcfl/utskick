// POST /subscribe: sign-up forms on websites (docs/signup.md). A browser form is known by its
// Origin, a server route by its key. The answer is the same for a new, a known and a suppressed
// address, so the form reveals nothing, and a refused request stores nothing.
import { isList, type Config, type FormConfig } from './config.ts';
import { firstName, subscribe, type Signup } from './contacts.ts';
import type { Env } from './env.ts';
import { HttpError, json, normalizeEmail, sameSecret } from './util.ts';

const maxBody = 2048;
// Sign-ups per form and client address a minute. Workers Rate Limiting counts per Cloudflare
// location and may let a few more through; cloudflare.config.ts sets the same numbers.
const limit = 10, period = 60;

interface Form { name: string; config: FormConfig }
type Fields = Record<string, unknown>;

export async function signupRoute(request: Request, env: Env): Promise<Response> {
  const forms = env.CONFIG.forms ?? {};
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') return preflight(forms, origin);
  if (request.method !== 'POST') {
    const res = json({ error: 'method_not_allowed' }, 405);
    res.headers.set('Allow', 'POST, OPTIONS');
    return cors(res, null);
  }

  let form: Form | null = null;
  let thanks: URL | null = null;
  try {
    form = await whichForm(request, env, forms, origin);
    const fields = await readFields(request);
    thanks = thanksPage(fields.redirect, form.config);
    // A server form may name the reader's address in X-Client-IP: its key vouches for it. Without
    // that header the address is the server's, and the limit caps the server as a whole.
    const named = form.config.key ? request.headers.get('X-Client-IP') : null;
    const client = clientKey(named || request.headers.get('CF-Connecting-IP') || 'unknown');
    if (!await signupAllowed(env, `${form.name}:${client}`)) throw new HttpError(429, 'rate_limited');
    // A filled hidden field means a form-filling bot. Answer as if it worked and store nothing.
    if (!present(fields.website)) await subscribe(env, checkFields(fields, form, env.CONFIG));
    return reply(form, origin, thanks, null);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return reply(form, origin, thanks, error);
  }
}

// Only a browser form is posted from a page. A form with a key is posted by its server, which needs no CORS.
function preflight(forms: Record<string, FormConfig>, origin: string | null) {
  if (origin === null || !Object.values(forms).some(f => !f.key && f.origins?.includes(origin))) return cors(json({ error: 'origin_not_allowed' }, 403), null);
  return cors(new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' },
  }), origin);
}

// A key names its form. Without one, the Origin does: an origin belongs to one browser form.
async function whichForm(request: Request, env: Env, forms: Record<string, FormConfig>, origin: string | null): Promise<Form> {
  const auth = request.headers.get('Authorization');
  if (auth !== null) {
    const form = await formByKey(env, forms, auth);
    if (!form) throw new HttpError(401, 'invalid_key');
    // A server sends no Origin. A request that does must come from the form's own page.
    if (origin !== null && !form.config.origins?.includes(origin)) throw new HttpError(403, 'origin_not_allowed');
    return form;
  }
  if (origin === null) throw new HttpError(401, 'key_required');
  const entries = Object.entries(forms);
  const browser = entries.find(([, f]) => !f.key && f.origins?.includes(origin));
  if (browser) return { name: browser[0], config: browser[1] };
  // The page of a form that needs a key: its server has to make the call.
  if (entries.some(([, f]) => f.origins?.includes(origin))) throw new HttpError(401, 'key_required');
  throw new HttpError(403, 'origin_not_allowed');
}

// Compares the key with every form's, so the time taken does not say which one matched.
async function formByKey(env: Env, forms: Record<string, FormConfig>, auth: string): Promise<Form | null> {
  const keys = formKeys(env);
  let found: Form | null = null;
  for (const [name, config] of Object.entries(forms)) {
    const key = config.key && Object.hasOwn(keys, name) ? keys[name] : null;
    if (typeof key !== 'string') continue;
    if (key.length < 32) {
      console.error(JSON.stringify({ event: 'form_key_too_short', form: name }));
      continue;
    }
    if (await sameSecret(auth, `Bearer ${key}`)) found ??= { name, config };
  }
  return found;
}

function formKeys(env: Env): Record<string, unknown> {
  if (!env.FORM_KEYS) return {};
  try {
    const keys = JSON.parse(env.FORM_KEYS);
    if (keys && typeof keys === 'object' && !Array.isArray(keys)) return keys;
  } catch {}
  // Not the parser's message: it quotes the text it stopped at, which is the secret.
  console.error(JSON.stringify({ event: 'error', message: 'FORM_KEYS is not a JSON object' }));
  throw new HttpError(503, 'signup_unavailable');
}

async function readFields(request: Request): Promise<Fields> {
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'unsupported_media_type');
  const text = await boundedText(request, maxBody);
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(text));
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body');
  return body as Fields;
}

// An IPv6 client usually has a whole /64 to itself, so the limit counts per /64, not per address.
export function clientKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// Stops reading past `max` bytes, so a large body costs nothing to refuse.
export async function boundedText(request: Request, max: number): Promise<string> {
  if (Number(request.headers.get('Content-Length')) > max) throw new HttpError(413, 'too_large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, 'too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

// A plain HTML form names the page to show next. It must be on the form's own origins: no open redirect.
function thanksPage(redirect: unknown, form: FormConfig): URL | null {
  if (!present(redirect)) return null;
  let url: URL | null = null;
  try { url = new URL(String(redirect)); } catch {}
  if (!url || !form.origins?.includes(url.origin)) throw new HttpError(400, 'invalid_redirect');
  return url;
}

const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim());

// The sign-up as Utskick stores it, or the first field that is wrong.
function checkFields(f: Fields, form: Form, config: Config): Signup {
  const email = normalizeEmail(f.email);
  if (!email) throw new HttpError(400, 'invalid_email');
  const list = f.list;
  if (typeof list !== 'string' || !form.config.lists.includes(list) || !isList(config, list)) throw new HttpError(400, 'invalid_list');
  // Only the text the list shows now, so a form cannot record a consent we never asked for.
  const consent = config.lists[list].consent;
  if (!consent || f.consent !== consent) throw new HttpError(400, 'invalid_consent');
  // A name that is not plainly a name ("J.R.", a phone number, a link) is dropped, not refused:
  // the sign-up still counts, and nothing a stranger types ends up in a greeting.
  const name = present(f.first_name) ? firstName(f.first_name) : null;
  const country = present(f.country) ? String(f.country).trim().toUpperCase() : null;
  if (country !== null && !/^[A-Z]{2}$/.test(country)) throw new HttpError(400, 'invalid_country');
  return { email, list, consent, firstName: name, country, source: form.name };
}

// After a plain HTML form, the browser goes on to the thank-you page, with ?error= when refused.
function reply(form: Form | null, origin: string | null, thanks: URL | null, error: HttpError | null) {
  let res: Response;
  if (thanks) {
    const to = new URL(thanks);
    if (error) to.searchParams.set('error', error.message);
    res = new Response(null, { status: 303, headers: { Location: to.href, 'Cache-Control': 'no-store' } });
  } else {
    res = json(error ? { error: error.message } : { ok: true }, error?.status ?? 200);
  }
  if (error?.status === 429) res.headers.set('Retry-After', String(period));
  return cors(res, form && origin !== null && form.config.origins?.includes(origin) ? origin : null);
}

function cors(res: Response, origin: string | null) {
  res.headers.append('Vary', 'Origin');
  if (origin) res.headers.set('Access-Control-Allow-Origin', origin);
  return res;
}

interface Limiter { limit(options: { key: string }): Promise<{ success: boolean }> }

// Without the Workers binding, as in the tests: a fixed window per key, in this isolate only.
function memoryLimiter(max: number, seconds: number): Limiter {
  const windows = new Map<string, { count: number; ends: number }>();
  return {
    async limit({ key }) {
      const now = Date.now();
      let w = windows.get(key);
      if (!w || w.ends <= now) {
        if (windows.size > 10_000) for (const [k, v] of windows) if (v.ends <= now) windows.delete(k);
        w = { count: 0, ends: now + seconds * 1000 };
        windows.set(key, w);
      }
      return { success: ++w.count <= max };
    },
  };
}

// 10 sign-ups a minute under one key: a form and a client address, or a site over its service binding.
export async function signupAllowed(env: Env, key: string): Promise<boolean> {
  return (await limiter(env).limit({ key })).success;
}

const memory = new WeakMap<Env, Limiter>();
function limiter(env: Env): Limiter {
  if (env.SIGNUP_LIMITER) return env.SIGNUP_LIMITER;
  let l = memory.get(env);
  if (!l) memory.set(env, l = memoryLimiter(limit, period));
  return l;
}
