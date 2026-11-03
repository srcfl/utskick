import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { handle } from '../src/app.ts';
import { cron } from '../src/approvals.ts';
import { forgetMetadataDocuments } from '../src/clients.ts';
import { sweepOAuth } from '../src/oauth.ts';
import { admin, fakeSes, rows, testEnv } from './helpers.ts';
import { authorize, base, callTool, connect, consentId, decide, pkce, redirectUri, register, resource, rpc, token } from './oauth-helpers.ts';

let fake: ReturnType<typeof fakeSes> | undefined;
afterEach(() => { fake?.restore(); fake = undefined; });

const get = (env: ReturnType<typeof testEnv>, path: string) => handle(new Request(`${base}${path}`), env);

test('discovery: authorization server and protected resource metadata', async () => {
  const env = testEnv();
  const as = await (await get(env, '/.well-known/oauth-authorization-server')).json() as Record<string, any>;
  assert.equal(as.issuer, base);
  assert.equal(as.authorization_endpoint, `${base}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${base}/oauth/token`);
  assert.equal(as.registration_endpoint, `${base}/oauth/register`);
  assert.equal(as.revocation_endpoint, `${base}/oauth/revoke`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.response_types_supported, ['code']);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(as.scopes_supported, ['stats.read', 'subscribers.read', 'drafts.write', 'test.send', 'lists.write']);

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const res = await get(env, path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    const pr = await res.json() as Record<string, any>;
    assert.equal(pr.resource, resource);
    assert.deepEqual(pr.authorization_servers, [base]);
    assert.deepEqual(pr.bearer_methods_supported, ['header']);
  }
});

test('/mcp without a token is a 401 that points at the resource metadata', async () => {
  const env = testEnv();
  const r = await rpc(env, null, 'tools/list');
  assert.equal(r.status, 401);
  const challenge = r.headers.get('WWW-Authenticate')!;
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /resource_metadata="https:\/\/news\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  const bad = await rpc(env, 'utk_at_nonsense', 'tools/list');
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('WWW-Authenticate')!, /error="invalid_token"/);
});

test('dynamic registration takes https, loopback and the Cursor callback, and nothing else', async () => {
  const env = testEnv();
  const ok = await register(env, { redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] });
  assert.equal(ok.status, 201);
  assert.match(ok.body.client_id, /^utk_c_/);
  assert.equal(ok.body.token_endpoint_auth_method, 'none');
  assert.equal(ok.body.client_secret, undefined);
  assert.equal((await register(env, { redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] })).status, 201);
  assert.equal((await register(env, { redirect_uris: ['http://localhost:6274/oauth/callback'] })).status, 201);
  for (const bad of ['http://evil.example/cb', 'myapp://callback', 'https://x.example/cb#frag', 'https://user:pw@x.example/cb', 'javascript:alert(1)']) {
    const r = await register(env, { redirect_uris: [bad] });
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error, 'invalid_redirect_uri');
  }
  assert.equal((await register(env, { redirect_uris: [] })).status, 400);
  assert.equal((await register(env, { grant_types: ['client_credentials'] })).status, 400);

  const confidential = await register(env, { token_endpoint_auth_method: 'client_secret_post' });
  assert.equal(confidential.status, 201);
  assert.match(confidential.body.client_secret, /^utk_cs_/);
  const [row] = await rows(env, 'SELECT secret_hash FROM oauth_clients WHERE client_id = ?', confidential.body.client_id);
  assert.notEqual(row.secret_hash, confidential.body.client_secret, 'only the hash is kept');
});

test('authorize needs a signed-in member before it looks at the request', async () => {
  const env = testEnv();
  const client = (await register(env)).body.client_id;
  const { challenge } = pkce();
  const params = { response_type: 'code', client_id: client, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256' };
  const nobody = await authorize(env, params);
  assert.equal(nobody.status, 401);
  env.DEV_IDENTITY = 'stranger@example.com';
  const stranger = await authorize(env, params);
  assert.equal(stranger.status, 403);
  assert.match(stranger.html, /not a member/);
  env.DEV_IDENTITY = 'Admin@Example.com';
  assert.equal((await authorize(env, params)).status, 200);
});

test('PKCE: plain and a missing challenge are refused; S256 is required', async () => {
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  const client = (await register(env)).body.client_id;
  const { challenge } = pkce();
  const common = { response_type: 'code', client_id: client, redirect_uri: redirectUri, state: 'abc' };
  for (const params of [
    { ...common },
    { ...common, code_challenge: challenge },
    { ...common, code_challenge: challenge, code_challenge_method: 'plain' },
    { ...common, code_challenge: 'short', code_challenge_method: 'S256' },
  ]) {
    const r = await authorize(env, params);
    assert.equal(r.status, 400, JSON.stringify(params));
    assert.match(r.html, /S256/);
    assert.match(r.html, /error=invalid_request/, 'the page links back to the client with the error');
    assert.match(r.html, /iss=https%3A%2F%2Fnews\.test/);
  }
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM oauth_consents'))[0].n, 0);
  assert.equal((await authorize(env, { ...common, code_challenge: challenge, code_challenge_method: 'S256' })).status, 200);
});

test('an unknown client or an unregistered redirect gets a page, never a redirect', async () => {
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  const client = (await register(env)).body.client_id;
  const { challenge } = pkce();
  const unknown = await authorize(env, { response_type: 'code', client_id: 'utk_c_nobody', redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get('Location'), null);
  const elsewhere = await authorize(env, { response_type: 'code', client_id: client, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal(elsewhere.status, 400);
  assert.doesNotMatch(elsewhere.html, /evil\.example/);
});

test('the full flow: consent, code with iss and state, tokens, and a working /mcp', async () => {
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read drafts.write', tick: ['stats.read'] });
  assert.equal(c.back.origin + c.back.pathname, redirectUri);
  assert.equal(c.back.searchParams.get('iss'), base);
  assert.equal(c.back.searchParams.get('state'), 'st-1');
  assert.equal(c.scope, 'stats.read', 'the admin unticked drafts.write');
  assert.match(c.access, /^utk_at_/);
  assert.match(c.refresh, /^utk_rt_/);
  const list = await rpc(env, c.access, 'tools/list');
  assert.equal(list.status, 200);
  assert.ok(list.body.result.tools.length > 0);
  const stored = JSON.stringify(await rows(env, 'SELECT * FROM oauth_tokens'));
  assert.ok(!stored.includes(c.access) && !stored.includes(c.refresh), 'tokens are kept as hashes');
  const [grant] = await rows(env, 'SELECT subject, scope, resource FROM oauth_grants');
  assert.deepEqual(grant, { subject: 'admin@example.com', scope: 'stats.read', resource });
});

test('the consent form refuses another origin, and a second answer', async () => {
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  const client = (await register(env)).body.client_id;
  const { challenge } = pkce();
  const page = await authorize(env, { response_type: 'code', client_id: client, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256' });
  const id = consentId(page.html);
  assert.equal((await decide(env, id, [['decision', 'approve'], ['scope', 'stats.read']], { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await decide(env, id, [['decision', 'approve'], ['scope', 'stats.read']], {})).status, 403, 'no Origin and no Sec-Fetch-Site');
  env.DEV_IDENTITY = 'other-admin@example.com';
  env.CONFIG = { ...env.CONFIG, admins: ['admin@example.com', 'other-admin@example.com'] };
  assert.equal((await decide(env, id, [['decision', 'approve'], ['scope', 'stats.read']])).status, 400, 'bound to the admin who saw it');
  env.DEV_IDENTITY = 'admin@example.com';
  assert.equal((await decide(env, id, [['decision', 'approve'], ['scope', 'stats.read']])).status, 303);
  assert.equal((await decide(env, id, [['decision', 'approve'], ['scope', 'stats.read']])).status, 400);
});

test('deny sends the browser back with access_denied and iss', async () => {
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  const client = (await register(env)).body.client_id;
  const { challenge } = pkce();
  const page = await authorize(env, { response_type: 'code', client_id: client, redirect_uri: redirectUri, state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
  const res = await decide(env, consentId(page.html), [['decision', 'deny']]);
  const back = new URL(res.headers.get('Location')!);
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('iss'), base);
  assert.equal(back.searchParams.get('state'), 's');
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM oauth_grants'))[0].n, 0);
});

async function codeFor(env: ReturnType<typeof testEnv>, extra: Record<string, string> = {}) {
  env.DEV_IDENTITY = 'admin@example.com';
  const client = (await register(env)).body.client_id;
  const { verifier, challenge } = pkce();
  const page = await authorize(env, { response_type: 'code', client_id: client, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', scope: 'stats.read', ...extra });
  const res = await decide(env, consentId(page.html), [['decision', 'approve'], ['scope', 'stats.read']]);
  return { client, verifier, code: new URL(res.headers.get('Location')!).searchParams.get('code')! };
}

test('a code works once, with its verifier; a second use ends the grant', async () => {
  const env = testEnv();
  const { client, verifier, code } = await codeFor(env);
  const wrong = await token(env, { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: client, redirect_uri: redirectUri });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'invalid_grant');

  const env2 = testEnv();
  const c2 = await codeFor(env2);
  const first = await token(env2, { grant_type: 'authorization_code', code: c2.code, code_verifier: c2.verifier, client_id: c2.client, redirect_uri: redirectUri });
  assert.equal(first.status, 200);
  assert.equal(first.body.token_type, 'Bearer');
  assert.equal(first.body.expires_in, 600);
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  const again = await token(env2, { grant_type: 'authorization_code', code: c2.code, code_verifier: c2.verifier, client_id: c2.client, redirect_uri: redirectUri });
  assert.equal(again.body.error, 'invalid_grant');
  assert.equal((await rpc(env2, first.body.access_token, 'tools/list')).status, 401, 'the first tokens went with the grant');
  const noVerifier = await token(env2, { grant_type: 'authorization_code', code: 'utk_ac_x', client_id: c2.client, redirect_uri: redirectUri });
  assert.equal(noVerifier.body.error, 'invalid_request');
});

test('refresh tokens rotate; a reuse after the grace ends the grant', async () => {
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read' });
  const r1 = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refresh_token, c.refresh);
  assert.equal((await rpc(env, r1.body.access_token, 'tools/list')).status, 200);
  // A client whose answer got lost may retry within seconds, once.
  const retry = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  assert.equal(retry.status, 200);
  await env.DB.prepare(`UPDATE oauth_tokens SET used_at = '2026-01-01T00:00:00Z' WHERE kind = 'refresh' AND used_at IS NOT NULL`).run();
  const stolen = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  assert.equal(stolen.body.error, 'invalid_grant');
  assert.equal((await rpc(env, r1.body.access_token, 'tools/list')).status, 401);
  assert.equal((await token(env, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: c.clientId })).body.error, 'invalid_grant');
});

test('a refresh may narrow the scope, never widen it; another client cannot use it', async () => {
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read subscribers.read' });
  const wider = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId, scope: 'stats.read drafts.write' });
  assert.equal(wider.body.error, 'invalid_scope');
  const other = (await register(env)).body.client_id;
  const theirs = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: other });
  assert.equal(theirs.body.error, 'invalid_grant');
  const narrow = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId, scope: 'stats.read' });
  assert.equal(narrow.body.scope, 'stats.read');
});

test('tokens are bound to the MCP resource', async () => {
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  const client = (await register(env)).body.client_id;
  const { challenge } = pkce();
  const other = await authorize(env, { response_type: 'code', client_id: client, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://elsewhere.example/mcp' });
  assert.equal(other.status, 400);
  assert.match(other.html, /invalid_target/);

  const { verifier, code, client: c2 } = await codeFor(env);
  const wrong = await token(env, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: c2, redirect_uri: redirectUri, resource: 'https://elsewhere.example/mcp' });
  assert.equal(wrong.body.error, 'invalid_target');

  const c = await connect(env, { scope: 'stats.read' });
  await env.DB.prepare(`UPDATE oauth_tokens SET resource = 'https://elsewhere.example/mcp' WHERE kind = 'access'`).run();
  const r = await rpc(env, c.access, 'tools/list');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('WWW-Authenticate')!, /error="invalid_token"/);
});

test('an access token stops at its end', async () => {
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read' });
  await env.DB.prepare(`UPDATE oauth_tokens SET expires_at = '2026-01-01T00:00:00Z' WHERE kind = 'access'`).run();
  assert.equal((await rpc(env, c.access, 'tools/list')).status, 401);
});

test('revocation (RFC 7009): a refresh token takes its grant with it; unknown tokens answer 200', async () => {
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read' });
  const revoke = (form: Record<string, string>) => handle(new Request(`${base}/oauth/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
  }), env);
  assert.equal((await revoke({ token: 'utk_rt_unknown', client_id: c.clientId })).status, 200);
  assert.equal((await rpc(env, c.access, 'tools/list')).status, 200);
  assert.equal((await revoke({ token: c.refresh, client_id: c.clientId })).status, 200);
  assert.equal((await rpc(env, c.access, 'tools/list')).status, 401);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM oauth_grants'))[0].n, 0);
});

test('an admin can list grants and revoke one client from /admin', async () => {
  const env = testEnv();
  const a = await connect(env, { scope: 'stats.read' });
  const b = await connect(env, { scope: 'stats.read' });
  const list = await (await handle(admin('/admin/oauth/grants'), env)).json() as { grants: Record<string, any>[] };
  assert.equal(list.grants.length, 2);
  assert.deepEqual(Object.keys(list.grants[0]).sort(), ['client_id', 'client_name', 'created_at', 'expires_at', 'id', 'scope', 'subject', 'used_at']);
  const res = await handle(admin('/admin/oauth/revoke', { clientId: a.clientId }), env);
  assert.equal(res.status, 200);
  assert.equal((await rpc(env, a.access, 'tools/list')).status, 401);
  assert.equal((await rpc(env, b.access, 'tools/list')).status, 200);
  assert.equal((await token(env, { grant_type: 'refresh_token', refresh_token: a.refresh, client_id: a.clientId })).status, 401, 'the registration went too');
  const unauthorized = await handle(new Request(`${base}/admin/oauth/grants`), env);
  assert.equal(unauthorized.status, 401);
});

test('a confidential client must authenticate at the token endpoint', async () => {
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  const reg = (await register(env, { token_endpoint_auth_method: 'client_secret_basic' })).body;
  const { verifier, challenge } = pkce();
  const page = await authorize(env, { response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', scope: 'stats.read' });
  const res = await decide(env, consentId(page.html), [['decision', 'approve'], ['scope', 'stats.read']]);
  const code = new URL(res.headers.get('Location')!).searchParams.get('code')!;
  const form = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri };
  const none = await token(env, { ...form, client_id: reg.client_id });
  assert.equal(none.status, 401);
  assert.equal(none.body.error, 'invalid_client');
  const basic = `Basic ${btoa(`${encodeURIComponent(reg.client_id)}:${encodeURIComponent(reg.client_secret)}`)}`;
  const ok = await token(env, form, { Authorization: basic });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// --- Client ID metadata documents ---

const cimdUrl = 'https://assistant.example/oauth/client.json';
const cimdDoc = { client_id: cimdUrl, client_name: 'Example Assistant', redirect_uris: ['https://assistant.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };

function serveDocument(doc: unknown, init: ResponseInit = {}) {
  forgetMetadataDocuments();
  fake = fakeSes();
  let fetched = 0;
  fake.other.set(cimdUrl, () => { fetched++; return new Response(typeof doc === 'string' ? doc : JSON.stringify(doc), { headers: { 'Content-Type': 'application/json' }, ...init }); });
  return { get fetched() { return fetched; } };
}

test('a client ID metadata document is fetched, checked and used for the whole flow', async () => {
  const served = serveDocument(cimdDoc);
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  const { verifier, challenge } = pkce();
  const page = await authorize(env, { response_type: 'code', client_id: cimdUrl, redirect_uri: 'https://assistant.example/callback', code_challenge: challenge, code_challenge_method: 'S256', scope: 'stats.read' });
  assert.equal(page.status, 200, page.html);
  assert.match(page.html, /Example Assistant/);
  assert.match(page.html, /assistant\.example/);
  const res = await decide(env, consentId(page.html), [['decision', 'approve'], ['scope', 'stats.read']]);
  const code = new URL(res.headers.get('Location')!).searchParams.get('code')!;
  const t = await token(env, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: cimdUrl, redirect_uri: 'https://assistant.example/callback' });
  assert.equal(t.status, 200);
  assert.equal(served.fetched, 1, 'the token endpoint does not fetch again');
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM oauth_clients'))[0].n, 0, 'a metadata client is not stored');
});

test('a metadata document that does not check out is refused', async () => {
  const cases: [string, unknown, ResponseInit?][] = [
    ['client_id does not match its URL', { ...cimdDoc, client_id: 'https://assistant.example/other.json' }],
    ['a redirect URI that is not https', { ...cimdDoc, redirect_uris: ['http://evil.example/cb'] }],
    ['a client secret in a public document', { ...cimdDoc, client_secret: 'x' }],
    ['no client name', { ...cimdDoc, client_name: '' }],
    ['a document over the size limit', JSON.stringify({ ...cimdDoc, padding: 'x'.repeat(20_000) })],
    ['not JSON', 'hello'],
    ['a redirect instead of the document', '', { status: 302, headers: { Location: 'http://169.254.169.254/' } }],
  ];
  for (const [why, doc, init] of cases) {
    serveDocument(doc, init);
    const env = testEnv();
    env.DEV_IDENTITY = 'admin@example.com';
    const { challenge } = pkce();
    const r = await authorize(env, { response_type: 'code', client_id: cimdUrl, redirect_uri: 'https://assistant.example/callback', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal(r.status, 400, why);
    fake!.restore();
  }
  fake = undefined;
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  for (const id of ['http://assistant.example/client.json', 'https://127.0.0.1/client.json', 'https://localhost/client.json', 'https://assistant.example/', 'https://assistant.example:8443/c.json', 'https://news.test/client.json',
    'https://assistant.example/a/../client.json', 'https://Assistant.example/client.json', 'https://assistant.example:443/client.json']) {
    const r = await authorize(env, { response_type: 'code', client_id: id, redirect_uri: 'https://assistant.example/callback', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    assert.equal(r.status, 400, id);
  }
});

// --- Cloudflare Access ---

const certsUrl = 'https://test-team.cloudflareaccess.com/cdn-cgi/access/certs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };

function accessJwt(claims: Record<string, unknown>, kid = 'test-kid') {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64({ aud: ['test-aud'], iss: 'https://test-team.cloudflareaccess.com', email: 'admin@example.com', iat: now, nbf: now, exp: now + 600, type: 'app', ...claims })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey, 'base64url')}`;
}

test('Cloudflare Access: the JWT is checked against the team certs, the audience and the admin list', async () => {
  fake = fakeSes();
  fake.other.set(certsUrl, () => Response.json({ keys: [jwk] }));
  const env = testEnv();
  const client = (await register(env)).body.client_id;
  const params = { response_type: 'code', client_id: client, redirect_uri: redirectUri, code_challenge: pkce().challenge, code_challenge_method: 'S256' };
  const as = (jwt: string) => authorize(env, params, { 'Cf-Access-Jwt-Assertion': jwt });
  assert.equal((await as(accessJwt({}))).status, 200);
  assert.equal((await as(accessJwt({ aud: ['another-app'] }))).status, 401);
  assert.equal((await as(accessJwt({ iss: 'https://evil.cloudflareaccess.com' }))).status, 401);
  assert.equal((await as(accessJwt({ exp: Math.floor(Date.now() / 1000) - 120 }))).status, 401);
  assert.equal((await as(accessJwt({ email: 'someone@example.com' }))).status, 403);
  assert.equal((await as(accessJwt({}, 'unknown-kid'))).status, 401);
  const forged = accessJwt({}).split('.');
  forged[1] = Buffer.from(JSON.stringify({ aud: ['test-aud'], iss: 'https://test-team.cloudflareaccess.com', email: 'admin@example.com', exp: 9999999999 })).toString('base64url');
  assert.equal((await as(forged.join('.'))).status, 401);
  assert.equal((await authorize(env, params)).status, 401, 'no header, no sign-in');
});

test('the dev identity works only on a local or .test address', async () => {
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  env.PUBLIC_URL = 'https://news.example.com';
  const client = (await register(env)).body.client_id;
  const r = await handle(new Request(`https://news.example.com/oauth/authorize?response_type=code&client_id=${client}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${pkce().challenge}&code_challenge_method=S256`), env);
  assert.equal(r.status, 401);
});

test('tools/call with a token is refused once the grant is revoked, mid-session', async () => {
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read' });
  assert.equal((await callTool(env, c.access, 'sends_list')).status, 200);
  await handle(admin('/admin/oauth/revoke', { clientId: c.clientId }), env);
  assert.equal((await callTool(env, c.access, 'sends_list')).status, 401);
});

test('the sweep drops what ran out and keeps what still lives', async () => {
  const env = testEnv();
  const live = await connect(env, { scope: 'stats.read' });
  const idle = (await register(env)).body.client_id;
  await authorize(env, { response_type: 'code', client_id: idle, redirect_uri: redirectUri, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  assert.equal((await cron(env)).sent, 0, 'the cron runs with nothing to send');
  await sweepOAuth(env, new Date(Date.now() + 2 * 86_400_000));
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM oauth_consents'))[0].n, 0);
  assert.deepEqual((await rows(env, 'SELECT kind FROM oauth_tokens ORDER BY kind')).map(r => r.kind), ['code', 'refresh'], 'a spent code stays while its grant lives');
  assert.deepEqual((await rows(env, 'SELECT client_id FROM oauth_clients')).map(r => r.client_id), [live.clientId]);
  assert.equal((await token(env, { grant_type: 'refresh_token', refresh_token: live.refresh, client_id: live.clientId })).status, 200);
  await sweepOAuth(env, new Date(Date.now() + 100 * 86_400_000));
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM oauth_grants'))[0].n, 0, 'no grant outlives 90 days');
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM oauth_tokens'))[0].n, 0);
});

// --- Security review, 2026-11-02 ---

test('a development-mode deploy signs nobody in: the dev identity needs the request on a local or .test host too', async () => {
  // What cloudflare.config.ts sets in development mode, reached on the public host.
  const env = testEnv();
  env.PUBLIC_URL = 'http://localhost:5173';
  env.DEV_IDENTITY = 'admin@example.com';
  const prod = 'https://news.example.com';
  const reg = await (await handle(new Request(`${prod}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['https://attacker.example/cb'] }),
  }), env)).json() as Record<string, string>;
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://attacker.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  for (const host of [prod, 'https://localhost.example.com', 'https://news.test.example.com', 'http://localhost.:5173']) {
    assert.equal((await handle(new Request(`${host}/oauth/authorize?${q}`), env)).status, 401, host);
    assert.equal((await handle(new Request(`${host}/dashboard`), env)).status, 401, host);
    assert.equal((await handle(new Request(`${host}/approve/${'x'.repeat(43)}`), env)).status, 401, host);
    const post = await handle(new Request(`${host}/oauth/authorize`, { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'request=x&decision=approve' }), env);
    assert.equal(post.status, 401, host);
  }
  for (const host of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173', 'https://news.test']) {
    assert.equal((await handle(new Request(`${host}/oauth/authorize?${q}`), env)).status, 200, host);
  }
});

test('a refresh refuses a grant or a refresh token made for another resource', async () => {
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read' });
  // A grant made while the Worker ran under another address, such as a development-mode deploy.
  await env.DB.prepare(`UPDATE oauth_grants SET resource = 'http://localhost:5173/mcp'`).run();
  const r = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_grant');

  const env2 = testEnv();
  const c2 = await connect(env2, { scope: 'stats.read' });
  await env2.DB.prepare(`UPDATE oauth_tokens SET resource = 'http://localhost:5173/mcp' WHERE kind = 'refresh'`).run();
  const r2 = await token(env2, { grant_type: 'refresh_token', refresh_token: c2.refresh, client_id: c2.clientId });
  assert.equal(r2.body.error, 'invalid_grant');
});

test('a refresh retried inside the grace leaves one live chain: the first answer\'s tokens die', async () => {
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read subscribers.read' });
  const first = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  const retry = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200, 'a lost answer may be asked for again');
  assert.equal((await rpc(env, first.body.access_token, 'tools/list')).status, 401, 'the first answer\'s access token is gone');
  assert.equal((await rpc(env, retry.body.access_token, 'tools/list')).status, 200);
  // Whoever holds the first answer's refresh token holds a dead one, and using it ends the grant.
  const late = await token(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: c.clientId });
  assert.equal(late.body.error, 'invalid_grant');
  assert.equal((await rpc(env, retry.body.access_token, 'tools/list')).status, 401);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM oauth_grants'))[0].n, 0);
});

test('a refresh retried after the first answer was itself refreshed is a reuse, and ends the grant', async () => {
  const env = testEnv();
  const c = await connect(env, { scope: 'stats.read' });
  const first = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  const next = await token(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: c.clientId });
  assert.equal(next.status, 200);
  const retry = await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  assert.equal(retry.body.error, 'invalid_grant');
  assert.equal((await rpc(env, next.body.access_token, 'tools/list')).status, 401);
});

const registerFrom = (env: ReturnType<typeof testEnv>, ip: string) => handle(new Request(`${base}/oauth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  body: JSON.stringify({ client_name: 'x', redirect_uris: ['https://a.example/cb'] }),
}), env);

test('dynamic registration: one address registers at most 20 clients a day', async () => {
  const env = testEnv();
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    let ok = 0;
    // One every 6 seconds, as fast as the per-isolate limit lets through.
    for (let i = 0; i < 200; i++) { if ((await registerFrom(env, '203.0.113.7')).status === 201) ok++; t += 6000; }
    assert.equal(ok, 20);
    const refused = await registerFrom(env, '203.0.113.7');
    assert.equal(refused.status, 429);
    assert.equal((await registerFrom(env, '203.0.113.8')).status, 201, 'another address is not held up');
    t += 86_400_000;
    assert.equal((await registerFrom(env, '203.0.113.7')).status, 201, 'a day later the address may register again');
    assert.doesNotMatch(JSON.stringify(await rows(env, 'SELECT * FROM oauth_registrations')), /203\.0\.113/, 'the address is kept only as a hash');
  } finally {
    Date.now = realNow;
  }
});

test('dynamic registration uses the rate-limit binding, under register:, when there is one', async () => {
  const env = testEnv();
  const keys: string[] = [];
  env.SIGNUP_LIMITER = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: keys.length <= 2 }; } } as unknown as RateLimit;
  assert.equal((await registerFrom(env, '198.51.100.1')).status, 201);
  assert.equal((await registerFrom(env, '198.51.100.1')).status, 201);
  assert.equal((await registerFrom(env, '198.51.100.1')).status, 429);
  assert.deepEqual(keys, ['register:198.51.100.1', 'register:198.51.100.1', 'register:198.51.100.1']);
});

test('a registration that never gets a grant is swept after an hour', async () => {
  const env = testEnv();
  const live = await connect(env, { scope: 'stats.read' });
  const idle = (await register(env)).body.client_id;
  await sweepOAuth(env, new Date(Date.now() + 30 * 60_000));
  assert.deepEqual((await rows(env, 'SELECT client_id FROM oauth_clients ORDER BY client_id')).map(r => r.client_id), [idle, live.clientId].sort());
  await sweepOAuth(env, new Date(Date.now() + 61 * 60_000));
  assert.deepEqual((await rows(env, 'SELECT client_id FROM oauth_clients')).map(r => r.client_id), [live.clientId]);
});

test('a client ID metadata URL whose host ends in a dot is refused before any fetch', async () => {
  fake = fakeSes();
  const seen: string[] = [];
  for (const id of ['https://localhost./c.json', 'https://news.test./client.json', 'https://metadata.google.internal./c.json', 'https://assistant.example./client.json', 'https://assistant..example/client.json']) {
    fake.other.set(id, () => { seen.push(id); return Response.json({}); });
  }
  forgetMetadataDocuments();
  const env = testEnv();
  env.DEV_IDENTITY = 'admin@example.com';
  for (const id of ['https://localhost./c.json', 'https://news.test./client.json', 'https://metadata.google.internal./c.json', 'https://assistant.example./client.json', 'https://assistant..example/client.json']) {
    const r = await authorize(env, { response_type: 'code', client_id: id, redirect_uri: 'https://assistant.example/callback', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    assert.equal(r.status, 400, id);
    assert.match(r.html, /not a URL this server fetches/, id);
  }
  assert.deepEqual(seen, []);
});

test('revoking a grant withdraws the sends its assistant asked for, and only those', async () => {
  fake = fakeSes();
  const env = testEnv();
  await handle(admin('/admin/import', { list: 'the-source', source: 't', consent: 't', contacts: [{ email: 'reader0@example.com' }], suppressions: [] }), env);
  const html = '<p>Hi</p><a href="*|UNSUB|*">u</a>';
  const a = await connect(env, { scope: 'drafts.write' });
  // The same client, connected a second time: a grant of its own.
  const b = await connect(env, { scope: 'drafts.write', clientId: a.clientId });
  const ask = async (c: typeof a, key: string) => {
    const draft = (await callTool(env, c.access, 'draft_save', { list: 'the-source', subject: 'S', html })).data.id;
    return (await callTool(env, c.access, 'request_send', { draft, key })).data as { approval: string; approveUrl: string };
  };
  const fromA = await ask(a, 'issue-a');
  const fromB = await ask(b, 'issue-b');
  const revoke = await handle(new Request(`${base}/oauth/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: a.refresh, client_id: a.clientId }).toString(),
  }), env);
  assert.equal(revoke.status, 200);
  const status = Object.fromEntries((await rows(env, 'SELECT id, status, decided_by FROM approvals')).map(r => [r.id, [r.status, r.decided_by]]));
  assert.deepEqual(status[fromA.approval], ['declined', 'grant revoked']);
  assert.deepEqual(status[fromB.approval], ['pending', null]);
  const approve = await handle(new Request(fromA.approveUrl, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'decision=approve' }), env);
  assert.equal(approve.status, 409);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM sends'))[0].n, 0);

  // A refresh token used twice ends its grant the same way.
  const c = await connect(env, { scope: 'drafts.write' });
  const fromC = await ask(c, 'issue-c');
  await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  await env.DB.prepare(`UPDATE oauth_tokens SET used_at = '2026-01-01T00:00:00Z' WHERE kind = 'refresh' AND used_at IS NOT NULL`).run();
  assert.equal((await token(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId })).body.error, 'invalid_grant');
  assert.equal((await rows(env, 'SELECT status FROM approvals WHERE id = ?', fromC.approval))[0].status, 'declined');
});

const adminRaw = (path: string, body: string, method = 'POST') => new Request(`${base}${path}`, {
  method, headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' }, body,
});

test('/admin answers a body that is not a JSON object with 400', async () => {
  const env = testEnv();
  for (const body of ['{not json', '', 'null', '[1, 2]', '"text"', '42']) {
    const res = await handle(adminRaw('/admin/import', body), env);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json() as Record<string, string>).error, 'invalid_json');
  }
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM contacts'))[0].n, 0);
});

test('/admin: every call that changes something is audited as admin-token, with counts and no addresses', async () => {
  fake = fakeSes();
  const env = testEnv();
  const html = '<p>Hi</p><a href="*|UNSUB|*">u</a>';
  const contacts = [{ email: 'reader0@example.com' }, { email: 'reader1@example.com' }];
  assert.equal((await handle(admin('/admin/import', { list: 'the-source', source: 't', consent: 't', contacts, suppressions: [{ email: 'gone@example.com', reason: 'manual' }] }), env)).status, 200);
  assert.equal((await handle(admin('/admin/sends', { key: 'k-1', list: 'the-source', kind: 'live', subject: 'S', html, dryRun: true }), env)).status, 200);
  assert.equal((await handle(admin('/admin/sends', { key: 'k-1', list: 'the-source', kind: 'live', subject: 'S', html }), env)).status, 200);
  assert.equal((await handle(admin('/admin/sends', { key: 'k-2', list: 'the-source', kind: 'test', subject: 'S', html, testTo: [{ email: 'tester@example.com' }] }), env)).status, 200);
  assert.equal((await handle(admin('/admin/sends/k-1/batch', { max: 10 }), env)).status, 200);
  assert.equal((await handle(admin('/admin/sends/k-1/retry-unknown', {}), env)).status, 200);
  assert.equal((await handle(admin('/admin/sends', { key: 'BAD KEY', list: 'the-source', kind: 'live', subject: 'S', html }), env)).status, 400);
  assert.equal((await handle(admin('/admin/oauth/revoke', { clientId: 'utk_c_nobody' }), env)).status, 200);
  assert.equal((await handle(admin('/admin/oauth/grants'), env)).status, 200);
  assert.equal((await handle(admin('/admin/sends/k-1'), env)).status, 200);
  assert.equal((await handle(admin('/admin/audit'), env)).status, 200);

  const audit = await rows(env, 'SELECT client_id, subject, scope, tool, summary, outcome FROM audit_log ORDER BY id');
  assert.deepEqual(audit.map(a => [a.client_id, a.tool, a.outcome]), [
    ['admin-token', 'POST /admin/import', 'ok'],
    ['admin-token', 'POST /admin/sends', 'ok'],
    ['admin-token', 'POST /admin/sends', 'ok'],
    ['admin-token', 'POST /admin/sends/k-1/retry-unknown', 'ok'],
    ['admin-token', 'POST /admin/sends', 'error'],
    ['admin-token', 'POST /admin/oauth/revoke', 'ok'],
  ], 'reads and dry runs change nothing and are not audited');
  for (const a of audit) {
    assert.equal(a.subject, null);
    assert.doesNotMatch(String(a.summary), /@|reader|tester|gone/);
  }
  const summaries = audit.map(a => JSON.parse(String(a.summary)));
  assert.equal(summaries[0].contacts, 2);
  assert.equal(summaries[0].suppressions, 1);
  assert.equal(summaries[0].list, 'the-source');
  assert.equal(summaries[0].status, 200);
  assert.equal(summaries[1].key, 'k-1');
  assert.equal(summaries[1].recipients, 2);
  assert.equal(summaries[2].testTo, 1);
  assert.equal(summaries[4].status, 400);
});
