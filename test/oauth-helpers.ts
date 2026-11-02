// What an MCP client does to connect: register, send the admin to /oauth/authorize, swap the code
// for tokens. And what it does after: JSON-RPC calls to /mcp.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { handle } from '../src/app.ts';
import type { testEnv } from './helpers.ts';

type TestEnv = ReturnType<typeof testEnv>;

export const base = 'https://news.test';
export const resource = `${base}/mcp`;
export const redirectUri = 'http://127.0.0.1:33418/callback';

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function register(env: TestEnv, body: Record<string, unknown> = {}) {
  const res = await handle(new Request(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Assistant', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', ...body }),
  }), env);
  return { status: res.status, body: await res.json() as Record<string, any> };
}

export function authorizeUrl(params: Record<string, string | undefined>) {
  const u = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

export async function authorize(env: TestEnv, params: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  const res = await handle(new Request(authorizeUrl(params), { headers }), env);
  return { status: res.status, html: await res.text(), headers: res.headers };
}

// The secret the consent page puts in its form.
export function consentId(html: string): string {
  const m = html.match(/name="request" value="([A-Za-z0-9_-]+)"/);
  assert.ok(m, 'the consent page has a request id');
  return m[1];
}

export async function decide(env: TestEnv, request: string, form: [string, string][], headers: Record<string, string> = { Origin: base }) {
  const res = await handle(new Request(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams([['request', request], ...form]).toString(),
  }), env);
  return res;
}

export async function token(env: TestEnv, form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await handle(new Request(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  }), env);
  return { status: res.status, body: await res.json() as Record<string, any>, headers: res.headers };
}

// The whole flow: an admin signs in, ticks the scopes, and the client gets tokens.
export async function connect(env: TestEnv, opts: { scope?: string; clientId?: string; tick?: string[] } = {}) {
  env.DEV_IDENTITY ??= 'admin@example.com';
  const clientId = opts.clientId ?? (await register(env)).body.client_id;
  const { verifier, challenge } = pkce();
  const page = await authorize(env, {
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 'st-1',
    code_challenge: challenge, code_challenge_method: 'S256', resource, scope: opts.scope ?? 'stats.read subscribers.read drafts.write test.send',
  });
  assert.equal(page.status, 200, page.html);
  const ticked = opts.tick ?? (opts.scope ?? 'stats.read subscribers.read drafts.write test.send').split(' ');
  const res = await decide(env, consentId(page.html), [['decision', 'approve'], ...ticked.map(s => ['scope', s] as [string, string])]);
  assert.equal(res.status, 303);
  const back = new URL(res.headers.get('Location')!);
  const code = back.searchParams.get('code')!;
  const t = await token(env, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, resource });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return { clientId, access: t.body.access_token as string, refresh: t.body.refresh_token as string, scope: t.body.scope as string, back };
}

let rpcId = 0;

// A JSON-RPC request to /mcp, as a client of the initialize-based revisions sends it.
export async function rpc(env: TestEnv, accessToken: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await handle(new Request(resource, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) }),
  }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

// tools/call; the tool's data from structuredContent.
export async function callTool(env: TestEnv, accessToken: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(env, accessToken, 'tools/call', { name, arguments: args });
  const result = r.body?.result ?? {};
  return { status: r.status, headers: r.headers, result, data: result.structuredContent?.data, error: result.isError ? result.content?.[0]?.text as string : null };
}
