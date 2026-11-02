// Who is at the browser when an admin connects an assistant or approves a send.
// Utskick keeps no accounts or passwords. An identity provider says whose browser it is;
// config.admins says whether that person may act. docs/mcp.md has passkeys as an alternative.
import type { Env } from './env.ts';
import { normalizeEmail } from './util.ts';

export interface IdentityProvider {
  name: string;
  // The signed-in person's address, or null when the request proves nobody.
  email(request: Request, env: Env): Promise<string | null>;
}

export type SignIn =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403 | 503; reason: string };

export function provider(env: Env): IdentityProvider | null {
  if (env.DEV_IDENTITY) return devStub;
  if (env.CONFIG.access) return cloudflareAccess;
  return null;
}

// The admin at the browser, or why not.
export async function signedInAdmin(request: Request, env: Env): Promise<SignIn> {
  const p = provider(env);
  if (!p) return { ok: false, status: 503, reason: 'Sign-in is not set up for this installation.' };
  const email = await p.email(request, env);
  if (!email) return { ok: false, status: 401, reason: 'Utskick could not tell who you are. Sign in again.' };
  const admins = (env.CONFIG.admins ?? []).map(normalizeEmail);
  if (!admins.includes(email)) return { ok: false, status: 403, reason: `${email} is not an admin of this installation.` };
  return { ok: true, email };
}

// For `cf dev` and the tests: everyone is DEV_IDENTITY. cloudflare.config.ts sets it only in
// development mode. Both PUBLIC_URL and the host the request reached must be local or .test:
// a Worker deployed in development mode by mistake has a local PUBLIC_URL, but a stranger
// reaches it on its public host, and is nobody there.
const localHost = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.test');

export const devStub: IdentityProvider = {
  name: 'dev',
  async email(request, env) {
    const local = localHost(new URL(env.PUBLIC_URL).hostname) && localHost(new URL(request.url).hostname);
    return local ? normalizeEmail(env.DEV_IDENTITY) : null;
  },
};

// Cloudflare Access sits in front of /oauth/authorize and /approve/ and signs in the person with
// whatever the team uses (Google, a one-time PIN, ...). Every request it lets through carries a
// JWT in Cf-Access-Jwt-Assertion, signed with the team's keys. Checking it here means a route
// that slips out of the Access application still lets nobody in.
export const cloudflareAccess: IdentityProvider = {
  name: 'cloudflare-access',
  async email(request, env) {
    const access = env.CONFIG.access;
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!access || !jwt) return null;
    const claims = await verifyJwt(jwt, access.teamDomain);
    if (!claims) return null;
    const now = Date.now() / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== `https://${access.teamDomain}` || !aud.includes(access.audience)) return null;
    // A minute's leeway for clocks.
    if (typeof claims.exp !== 'number' || claims.exp < now - 60 || (typeof claims.nbf === 'number' && claims.nbf > now + 60)) return null;
    // A service token has no email, and is no person.
    return normalizeEmail(claims.email);
  },
};

interface Jwk extends JsonWebKey { kid?: string }

// The team's signing keys, per isolate. Access rotates them every few weeks and serves the
// old and new together for a while, so a key we do not know is fetched again, at most once a minute.
const certs = new Map<string, { keys: Jwk[]; at: number }>();

async function teamKeys(teamDomain: string, kid: string): Promise<Jwk | null> {
  let entry = certs.get(teamDomain);
  const known = entry?.keys.find(k => k.kid === kid);
  if (known && Date.now() - entry!.at < 3600_000) return known;
  if (!entry || Date.now() - entry.at > 60_000) {
    try {
      const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const body = await res.json() as { keys?: Jwk[] };
        entry = { keys: (body.keys ?? []).filter(k => k.kty === 'RSA'), at: Date.now() };
        certs.set(teamDomain, entry);
      }
    } catch {
      // A failed fetch signs nobody in; the next request tries again.
    }
  }
  return entry?.keys.find(k => k.kid === kid) ?? null;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function verifyJwt(jwt: string, teamDomain: string): Promise<Record<string, any> | null> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const jwk = await teamKeys(teamDomain, header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), signed)) return null;
    return JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    return null;
  }
}
