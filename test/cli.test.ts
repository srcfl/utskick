// The CLI as a person runs it, against the Worker's own code served on 127.0.0.1.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/app.ts';
import { admin, fakeSes, rows, testEnv } from './helpers.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
let ses: ReturnType<typeof fakeSes>;
let close: (() => void) | undefined;
afterEach(() => { ses?.restore(); close?.(); close = undefined; });

function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(process.execPath, ['cli/utskick.ts', ...args], { cwd: root, timeout: 20_000, env: { ...process.env, MAILER_ADMIN_TOKEN: 'admin-secret', ...env } },
    (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })));
}

async function serve(env: ReturnType<typeof testEnv>) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const response = await handle(new Request(`http://127.0.0.1${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined,
    }), env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function sendReady(n: number) {
  ses = fakeSes();
  const env = testEnv();
  const contacts = Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.com` }));
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'c', contacts, suppressions: [] }), env);
  await handle(admin('/admin/sends', { key: 'k1', list: 'the-source', kind: 'live', subject: 'S', html: '<a href="*|UNSUB|*">u</a>' }), env);
  return env;
}

test('the CLI refuses to send the admin token over plain http to another host', async () => {
  for (const url of ['http://news.example.com', 'http://192.0.2.10:5173']) {
    const r = await cli(['stats', 'k1'], { MAILER_URL: url });
    assert.equal(r.code, 1, url);
    assert.match(r.stderr, /https/);
  }
});

test('the CLI stops on an account-level SES error and says what to do', async () => {
  const env = await sendReady(3);
  ses.fail.push(...Array(3).fill({ status: 403, type: 'AccessDeniedException' }));
  const r = await cli(['resume', 'k1'], { MAILER_URL: await serve(env) });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /AccessDenied 403/);
  assert.match(r.stderr, /resume k1/);
  assert.deepEqual(await rows(env, `SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status`), [{ status: 'pending', n: 3 }]);
  assert.equal(ses.outbox.length, 0);
});

test('after the last batch the CLI warns about rows still sending or unknown', async () => {
  const env = await sendReady(5);
  await env.DB.prepare(`UPDATE deliveries SET status = 'sending', claimed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id IN (SELECT id FROM deliveries LIMIT 2)`).run();
  ses.fail.push('network');
  const r = await cli(['resume', 'k1'], { MAILER_URL: await serve(env) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /2 still sending/);
  assert.match(r.stdout, /1 unknown/);
  assert.match(r.stdout, /retry-unknown k1/);
  assert.equal(ses.outbox.length, 2);
});

test('retry-failed puts the failed rows of a send back in line', async () => {
  const env = await sendReady(2);
  ses.fail.push({ status: 400, type: 'MessageRejected' });
  const url = await serve(env);
  const first = await cli(['resume', 'k1'], { MAILER_URL: url });
  assert.match(first.stdout, /retry-failed k1/);
  const r = await cli(['retry-failed', 'k1'], { MAILER_URL: url });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /requeued: 1/);
  assert.deepEqual(await rows(env, `SELECT status FROM deliveries ORDER BY status`), [{ status: 'pending' }, { status: 'sent' }]);
});
