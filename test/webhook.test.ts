import { test, afterEach } from 'node:test';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { handle } from '../src/app.ts';
import { spki } from '../src/sns.ts';
import { admin, fakeSes, rows, snsCert, snsCertUrl, snsMessage, testEnv } from './helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

async function sentTo(emails: string[]) {
  ses = fakeSes();
  ses.other.set(snsCertUrl, () => new Response(snsCert));
  const env = testEnv();
  const contacts = emails.map(email => ({ email, consentedAt: '2024-01-01T00:00:00Z' }));
  await handle(admin('/admin/import', { list: 'the-source', source: 'mailchimp-import', consent: 'mailchimp-the-source', contacts, suppressions: [] }), env);
  await handle(admin('/admin/sends', { key: 'the-source-22', list: 'the-source', kind: 'live', subject: 'S', html: '<p>x</p>' }), env);
  await handle(admin('/admin/sends/the-source-22/batch', { max: 10 }), env);
  return env;
}

function post(body: unknown) {
  return new Request('https://news.test/hooks/ses', { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, body: JSON.stringify(body) });
}

// SES event publishing, as a configuration set sends it through SNS.
function sesEvent(event: Record<string, unknown>) {
  return snsMessage({ Type: 'Notification', Message: JSON.stringify(event) });
}

test('a permanent bounce suppresses the address on every list', async () => {
  const env = await sentTo(['ok@example.com', 'bounce@example.com']);
  const res = await handle(post(sesEvent({
    eventType: 'Bounce',
    mail: { messageId: 'msg-2', destination: ['bounce@example.com'] },
    bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'bounce@example.com' }] },
  })), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await rows(env, 'SELECT scope, reason FROM suppressions'), [{ scope: '*', reason: 'bounce' }]);
  assert.deepEqual(await rows(env, `SELECT email FROM contacts ORDER BY email`), [{ email: 'ok@example.com' }]);
  assert.deepEqual(await rows(env, `SELECT e.type, d.message_id FROM events e JOIN deliveries d ON d.id = e.delivery_id`), [{ type: 'bounce', message_id: 'msg-2' }]);
  const next = await handle(admin('/admin/sends', { key: 'the-source-23', list: 'the-source', kind: 'live', subject: 'S', html: '<p>x</p>' }), env);
  assert.equal((await next.json() as Record<string, number>).recipients, 1);
});

test('a soft bounce on a second mail suppresses the address', async () => {
  const env = await sentTo(['full@example.com']);
  await handle(admin('/admin/sends', { key: 'the-source-23', list: 'the-source', kind: 'live', subject: 'S2', html: '<p>y</p>' }), env);
  await handle(admin('/admin/sends/the-source-23/batch', { max: 10 }), env);
  const soft = (id: string) => post(sesEvent({
    eventType: 'Bounce',
    mail: { messageId: id },
    bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'full@example.com' }] },
  }));
  await handle(soft('msg-1'), env);
  await handle(soft('msg-1'), env);
  assert.deepEqual(await rows(env, 'SELECT * FROM suppressions'), [], 'two soft bounces of one mail are still one');
  await handle(soft('msg-2'), env);
  assert.deepEqual(await rows(env, 'SELECT scope, reason FROM suppressions'), [{ scope: '*', reason: 'bounce' }]);
});

test('a transient bounce is logged but suppresses nothing', async () => {
  const env = await sentTo(['full@example.com']);
  await handle(post(sesEvent({
    eventType: 'Bounce',
    mail: { messageId: 'msg-1' },
    bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'full@example.com' }] },
  })), env);
  assert.deepEqual(await rows(env, 'SELECT * FROM suppressions'), []);
  assert.deepEqual(await rows(env, 'SELECT type FROM events'), [{ type: 'soft-bounce' }]);
});

test('a spam complaint suppresses the address, also in the older notification format', async () => {
  const env = await sentTo(['angry@example.com']);
  await handle(post(sesEvent({
    notificationType: 'Complaint',
    mail: { messageId: 'msg-1' },
    complaint: { complainedRecipients: [{ emailAddress: 'Angry@Example.com' }] },
  })), env);
  assert.deepEqual(await rows(env, 'SELECT scope, reason FROM suppressions'), [{ scope: '*', reason: 'complaint' }]);
  assert.deepEqual(await rows(env, 'SELECT * FROM contacts'), []);
});

test('a delivery event is counted', async () => {
  const env = await sentTo(['ok@example.com']);
  await handle(post(sesEvent({ eventType: 'Delivery', mail: { messageId: 'msg-1' }, delivery: { recipients: ['ok@example.com'] } })), env);
  assert.deepEqual(await rows(env, 'SELECT type FROM events'), [{ type: 'delivery' }]);
});

test('SignatureVersion 1 (SHA1withRSA) is accepted too', async () => {
  const env = await sentTo(['bounce@example.com']);
  const msg = snsMessage({ Type: 'Notification', Message: JSON.stringify({ eventType: 'Complaint', mail: { messageId: 'msg-1' }, complaint: { complainedRecipients: [{ emailAddress: 'bounce@example.com' }] } }) }, '1');
  assert.equal((await handle(post(msg), env)).status, 200);
  assert.equal((await rows(env, 'SELECT COUNT(*) AS n FROM suppressions')).at(0)!.n, 1);
});

test('a forged or altered message is refused and changes nothing', async () => {
  const env = await sentTo(['victim@example.com']);
  const msg = sesEvent({ eventType: 'Complaint', mail: { messageId: 'msg-1' }, complaint: { complainedRecipients: [{ emailAddress: 'someone@example.com' }] } });
  const altered = { ...msg, Message: msg.Message.replace('someone@example.com', 'victim@example.com') };
  assert.equal((await handle(post(altered), env)).status, 403);
  const otherTopic = snsMessage({ Type: 'Notification', TopicArn: 'arn:aws:sns:eu-central-1:999999999999:evil', Message: '{}' });
  assert.equal((await handle(post(otherTopic), env)).status, 403);
  const foreignCert = { ...msg, SigningCertURL: 'https://evil.example/cert.pem' };
  assert.equal((await handle(post(foreignCert), env)).status, 403);
  assert.deepEqual(await rows(env, 'SELECT * FROM suppressions'), []);
});

test('the SNS subscription is confirmed once its signature checks out', async () => {
  const env = await sentTo([]);
  const subscribeUrl = 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=abc';
  let confirmed = false;
  ses.other.set(subscribeUrl, () => { confirmed = true; return new Response('<ok/>'); });
  const msg = snsMessage({ Type: 'SubscriptionConfirmation', Message: 'You have chosen to subscribe', SubscribeURL: subscribeUrl, Token: 'abc' });
  assert.equal((await handle(post(msg), env)).status, 200);
  assert.equal(confirmed, true);
});

test('the certificate parser finds the public key in a real X.509 certificate', () => {
  const pem = readFileSync(new URL('./fixtures/sns/cert.pem', import.meta.url), 'utf8');
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  const expected = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
  assert.deepEqual(Buffer.from(spki(der)), expected);
});

test('only SNS in the topic\'s own region may sign: not S3, not another region, not another path', async () => {
  const env = await sentTo(['victim@example.com']);
  const complaint = JSON.stringify({ eventType: 'Complaint', mail: { messageId: 'msg-1' }, complaint: { complainedRecipients: [{ emailAddress: 'victim@example.com' }] } });
  for (const url of [
    'https://sns.s3.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
    'https://sns.s3-us-west-2.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
    'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
    'https://sns.eu-central-1.amazonaws.com/evil.pem',
    'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem?x=1',
    'https://sns.eu-central-1.amazonaws.com:8443/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
  ]) {
    // Whoever controls that URL serves a certificate for their own key and signs with it.
    ses.other.set(url, () => new Response(snsCert));
    const msg = snsMessage({ Type: 'Notification', Message: complaint, SigningCertURL: url });
    assert.equal((await handle(post(msg), env)).status, 403, url);
  }
  assert.deepEqual(await rows(env, 'SELECT * FROM suppressions'), []);
});

test('a subscription confirmation is followed only to SNS in the topic\'s region', async () => {
  const env = await sentTo([]);
  let fetched = false;
  const evil = 'https://sns.s3.amazonaws.com/?Action=ConfirmSubscription';
  ses.other.set(evil, () => { fetched = true; return new Response('<ok/>'); });
  const msg = snsMessage({ Type: 'SubscriptionConfirmation', Message: 'x', SubscribeURL: evil, Token: 'abc' });
  assert.equal((await handle(post(msg), env)).status, 403);
  assert.equal(fetched, false);
});

test('the webhook refuses a huge body without reading it all, and a null body with 400', async () => {
  const env = await sentTo([]);
  const big = new Request('https://news.test/hooks/ses', { method: 'POST', body: 'x'.repeat(300 * 1024) });
  assert.equal((await handle(big, env)).status, 413);
  assert.equal((await handle(post(null), env)).status, 400);
});
