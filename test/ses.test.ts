import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail, sesEndpoint, SesError } from '../src/ses.ts';
import { fakeSes, testEnv } from './helpers.ts';

let ses: ReturnType<typeof fakeSes>;
afterEach(() => ses?.restore());

const mail = { from: 'a@news.test', to: 'b@example.com', subject: 'S', html: '<p>x</p>', text: 'x', headers: {}, tags: {} };

test('SES errors are told apart by their type', async () => {
  const error = (status: number, headers: Record<string, string>, body: unknown) => SesError.from(new Response(JSON.stringify(body), { status, headers }));
  const cases: [SesError, string, string][] = [
    [await error(400, { 'x-amzn-ErrorType': 'MessageRejected:http://internal.amazon.com/coral/com.amazonaws.sesv2/' }, { message: 'Email address is not verified: b@example.com' }), 'MessageRejected 400', 'recipient'],
    [await error(400, {}, { __type: 'com.amazonaws.sesv2#BadRequestException', message: 'Illegal address' }), 'BadRequest 400', 'recipient'],
    [await error(429, {}, { message: 'Maximum sending rate exceeded.' }), 'HTTP 429', 'throttled'],
    [await error(400, {}, { code: 'ThrottlingException' }), 'Throttling 400', 'throttled'],
    [await error(403, { 'x-amzn-ErrorType': 'AccessDeniedException:' }, { Message: 'User arn:aws:iam::1:user/x is not authorized' }), 'AccessDenied 403', 'account'],
    [await error(403, { 'x-amzn-ErrorType': 'UnrecognizedClientException' }, {}), 'UnrecognizedClient 403', 'account'],
    [await error(400, { 'x-amzn-ErrorType': 'SendingPausedException' }, {}), 'SendingPaused 400', 'account'],
    [await error(400, { 'x-amzn-ErrorType': 'AccountSuspendedException' }, {}), 'AccountSuspended 400', 'account'],
    [await error(400, { 'x-amzn-ErrorType': 'MailFromDomainNotVerifiedException' }, {}), 'MailFromDomainNotVerified 400', 'account'],
    [await error(404, { 'x-amzn-ErrorType': 'NotFoundException' }, {}), 'NotFound 404', 'account'],
    [await error(400, {}, 'not json at all'), 'HTTP 400', 'account'],
    [await error(400, { 'x-amzn-ErrorType': 'Weird type with b@example.com' }, {}), 'HTTP 400', 'account'],
    [await error(500, { 'x-amzn-ErrorType': 'InternalFailure' }, {}), 'InternalFailure 500', 'unsure'],
    [await error(503, {}, {}), 'HTTP 503', 'unsure'],
  ];
  for (const [e, message, outcome] of cases) assert.deepEqual([e.message, e.outcome], [message, outcome]);
});

test('SES_ENDPOINT counts only for a local PUBLIC_URL; otherwise it is ignored with one warning', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const env = testEnv();
  for (const url of ['http://localhost:5173', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'https://news.test']) {
    assert.equal(sesEndpoint({ ...env, PUBLIC_URL: url, SES_ENDPOINT: 'http://localhost:4566' }), 'http://localhost:4566', url);
  }
  assert.equal(sesEndpoint({ ...env, PUBLIC_URL: 'http://localhost:5173', SES_ENDPOINT: undefined }), 'https://email.eu-central-1.amazonaws.com');
  assert.equal(warn.mock.callCount(), 0);
  for (const url of ['https://news.example.com', 'https://localhost.example.com', 'https://news.test.example.com', 'not a url']) {
    assert.equal(sesEndpoint({ ...env, PUBLIC_URL: url, SES_ENDPOINT: 'http://localhost:4566' }), 'https://email.eu-central-1.amazonaws.com', url);
  }
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /SES_ENDPOINT/);
});

test('a production Worker with SES_ENDPOINT set sends to SES itself', async () => {
  ses = fakeSes();
  ses.other.set('https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails', () => Response.json({ MessageId: 'real-1' }));
  assert.equal(await sendEmail({ ...testEnv(), PUBLIC_URL: 'https://news.example.com' }, mail), 'real-1');
  assert.equal(ses.outbox.length, 0);
});
