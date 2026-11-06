// POST /subscribe/status: a server (the web-app) asks whether one address is on one list.
// Authenticated with STATUS_KEY, never a form key. Form keys are held by sites and apps and
// must not reveal who subscribes (docs/signup.md).
import { isList } from './config.ts';
import { subscribed } from './contacts.ts';
import type { Env } from './env.ts';
import { boundedText, clientKey, isFormKey } from './signup.ts';
import { HttpError, json, normalizeEmail, sameSecret } from './util.ts';

const maxBody = 2048;
// Status checks per calling server a minute. Higher than /subscribe: one web-app server asks for
// many signed-in people. Workers Rate Limiting counts per Cloudflare location; cloudflare.config.ts
// sets the same numbers. X-Client-IP is ignored, so a stolen STATUS_KEY cannot mint a new budget
// per guessed address.
const limit = 120, period = 60;

export async function statusRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    const res = json({ error: 'method_not_allowed' }, 405);
    res.headers.set('Allow', 'POST');
    return res;
  }
  try {
    await authorize(request, env);
    const client = clientKey(request.headers.get('CF-Connecting-IP') || 'unknown');
    if (!await statusAllowed(env, `status:${client}`)) throw new HttpError(429, 'rate_limited');
    const allowed = env.CONFIG.status?.lists ?? [];
    if (!allowed.length) throw new HttpError(503, 'status_unavailable');
    const fields = await readJson(request);
    const email = normalizeEmail(fields.email);
    if (!email) throw new HttpError(400, 'invalid_email');
    const list = fields.list;
    if (typeof list !== 'string' || !allowed.includes(list) || !isList(env.CONFIG, list) || env.CONFIG.lists[list]?.adhoc) {
      throw new HttpError(400, 'invalid_list');
    }
    const yes = await subscribed(env, email, list);
    console.log(JSON.stringify({ event: 'subscription_status', list, subscribed: yes }));
    return json({ subscribed: yes });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const res = json({ error: error.message }, error.status);
    if (error.status === 429) res.headers.set('Retry-After', String(period));
    return res;
  }
}

async function authorize(request: Request, env: Env) {
  const auth = request.headers.get('Authorization');
  if (auth === null) throw new HttpError(401, 'key_required');
  // Always compare both secrets so the time taken does not say which kind it was.
  const form = await isFormKey(env, auth);
  const key = env.STATUS_KEY ?? '';
  const usable = key.length >= 32 || (key.length > 0 && localHost(env.PUBLIC_URL));
  const ok = usable && await sameSecret(auth, `Bearer ${key}`);
  if (form) {
    console.error(JSON.stringify({ event: 'form_key_rejected', path: '/subscribe/status' }));
    throw new HttpError(401, 'form_key_not_allowed');
  }
  if (!usable) {
    if (key) console.error(JSON.stringify({ event: 'status_key_too_short' }));
    throw new HttpError(503, 'status_unavailable');
  }
  if (!ok) throw new HttpError(401, 'invalid_key');
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
  const text = await boundedText(request, maxBody);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body');
  return body as Record<string, unknown>;
}

function localHost(url: string) {
  try { return /^(localhost|127\.0\.0\.1|\[::1\])$|\.test$/.test(new URL(url).hostname); } catch { return false; }
}

interface Limiter { limit(options: { key: string }): Promise<{ success: boolean }> }

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

async function statusAllowed(env: Env, key: string): Promise<boolean> {
  return (await limiter(env).limit({ key })).success;
}

const memory = new WeakMap<Env, Limiter>();
function limiter(env: Env): Limiter {
  if (env.STATUS_LIMITER) return env.STATUS_LIMITER;
  let l = memory.get(env);
  if (!l) memory.set(env, l = memoryLimiter(limit, period));
  return l;
}
