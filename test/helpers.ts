// A D1 stand-in on node:sqlite, a fake SES, and an env, so the Worker's code runs under `node --test`.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createSign, generateKeyPairSync } from 'node:crypto';
import type { Config } from '../src/config.ts';
import type { Env } from '../src/env.ts';

// Every migration, in order, as D1 would apply them.
const migrations = new URL('../migrations/', import.meta.url);
const schema = readdirSync(migrations).filter(f => f.endsWith('.sql')).sort().map(f => readFileSync(new URL(f, migrations), 'utf8')).join('\n');

type Value = string | number | null;

function plain<T>(row: T): T {
  return row == null ? row : { ...row };
}

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const statement = (sql: string, params: Value[] = []) => ({
    bind: (...p: Value[]) => statement(sql, p),
    async first(column?: string) {
      const row = db.prepare(sql).get(...params) as Record<string, Value> | undefined;
      if (!row) return null;
      return column ? row[column] : plain(row);
    },
    async all() {
      return { results: db.prepare(sql).all(...params).map(plain), success: true, meta: {} };
    },
    async run() {
      const r = db.prepare(sql).run(...params);
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    // D1 runs a batch as one transaction.
    async batch(statements: ReturnType<typeof statement>[]) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    sqlite: db,
  };
}

export interface SentMail {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  ReplyToAddresses?: string[];
  Content: { Simple: { Subject: { Data: string }; Body: { Html: { Data: string }; Text: { Data: string } }; Headers: { Name: string; Value: string }[] } };
  EmailTags?: { Name: string; Value: string }[];
}

// An SES failure: an HTTP status, a status with SES's error type, or a network error after the request left.
type Failure = number | { status: number; type: string } | 'network';

// Replaces fetch: SES calls land in `outbox`; `fail` lets a test answer the next calls with an error.
// An error names the recipient in its text, as SES's sometimes do, so a test can check it is not kept.
export function fakeSes() {
  const outbox: SentMail[] = [];
  const fail: Failure[] = [];
  const other = new Map<string, () => Response>();
  let n = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const handler = other.get(request.url);
    if (handler) return handler();
    if (!request.url.startsWith('https://ses.test/')) throw new Error(`unexpected fetch ${request.url}`);
    const f = fail.shift();
    if (f === 'network') throw new TypeError('fetch failed');
    if (f) {
      const { status, type } = typeof f === 'number' ? { status: f, type: '' } : f;
      const to = ((await request.json()) as SentMail).Destination.ToAddresses[0];
      const headers: Record<string, string> = type ? { 'x-amzn-ErrorType': `${type}:http://internal.amazon.com/coral/com.amazonaws.sesv2/` } : {};
      return Response.json({ message: `fake failure for ${to}` }, { status, headers });
    }
    outbox.push(await request.json() as SentMail);
    return Response.json({ MessageId: `msg-${++n}` });
  }) as typeof fetch;
  return { outbox, fail, other, restore: () => { globalThis.fetch = original; } };
}

// The tests' own installation: three lists, like the one Utskick was first built for.
export const testConfig: Config = {
  organization: 'Test Org',
  homepage: 'https://example.com',
  support: 'support@example.com',
  lists: {
    'the-source': { name: 'The Source', from: 'Test Org <the-source@news.test>', replyTo: 'info@example.com', opens: true, fname: '👋' },
    'ftw-news': { name: 'FTW news', from: 'FTW <ftw@news.test>', replyTo: 'support@example.com', opens: false, fname: 'there' },
    'ftw-box': { name: 'the FTW box waitlist', from: 'FTW <ftw@news.test>', replyTo: 'support@example.com', opens: false, fname: 'there' },
  },
  admins: ['admin@example.com'],
  testAllowlist: ['tester@example.com', 'Second.Tester@example.com'],
  access: { teamDomain: 'test-team.cloudflareaccess.com', audience: 'test-aud' },
};

export function testEnv(): Env & { DB: ReturnType<typeof fakeD1> } {
  return {
    DB: fakeD1(),
    CONFIG: testConfig,
    PUBLIC_URL: 'https://news.test',
    ADMIN_TOKEN: 'admin-secret',
    AWS_REGION: 'eu-central-1',
    AWS_ACCESS_KEY_ID: 'AKIATEST',
    AWS_SECRET_ACCESS_KEY: 'secret',
    SES_ENDPOINT: 'https://ses.test',
    SES_CONFIGURATION_SET: 'utskick',
    SNS_TOPIC_ARN: 'arn:aws:sns:eu-central-1:123456789012:utskick-events',
  } as unknown as Env & { DB: ReturnType<typeof fakeD1> };
}

export function admin(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`https://news.test${path}`, {
    method,
    headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// A key made for this test run, wrapped in the smallest certificate src/sns.ts can read, so no
// private key lives in the repository. test/fixtures/sns/cert.pem checks the parser on a real one.
const { publicKey, privateKey: snsKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Uint8Array.of(tag, ...length), body]);
}
const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
const tbs = der(0x30, der(0xa0, der(0x02, Uint8Array.of(2))), der(0x02, Uint8Array.of(1)), der(0x30), der(0x30), der(0x30), der(0x30), spkiDer);
export const snsCert = `-----BEGIN CERTIFICATE-----\n${Buffer.from(der(0x30, tbs, der(0x30), der(0x03, Uint8Array.of(0)))).toString('base64')}\n-----END CERTIFICATE-----\n`;
export const snsCertUrl = 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem';

// An SNS message signed the way AWS signs one (SignatureVersion 2: SHA256withRSA).
export function snsMessage(fields: Record<string, string>, version: '1' | '2' = '2') {
  const msg: Record<string, string> = {
    MessageId: crypto.randomUUID(),
    TopicArn: 'arn:aws:sns:eu-central-1:123456789012:utskick-events',
    Timestamp: new Date().toISOString(),
    SignatureVersion: version,
    SigningCertURL: snsCertUrl,
    ...fields,
  };
  const keys = msg.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const text = keys.filter(k => k in msg).map(k => `${k}\n${msg[k]}\n`).join('');
  msg.Signature = createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1').update(text).sign(snsKey, 'base64');
  return msg;
}

export async function rows<T = Record<string, Value>>(env: { DB: ReturnType<typeof fakeD1> }, sql: string, ...params: Value[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...params).all()).results as T[];
}
