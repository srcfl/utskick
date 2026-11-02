// Amazon SES v2 SendEmail, signed with SigV4.
import { AwsClient } from 'aws4fetch';
import type { Env } from './env.ts';

export interface Mail {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  tags: Record<string, string>;
}

// What a refused SendEmail means for its row:
//   recipient  SES refused this one mail (a bad address, content it rejects): the row fails.
//   throttled  too fast; nothing went out, so the row waits for the next batch.
//   account    the key, the account or a setting is wrong, and every other mail would fail the same way.
//   unsure     a 5xx after the request left: SES may have taken the mail.
export type Outcome = 'recipient' | 'throttled' | 'account' | 'unsure';

const recipientErrors = ['MessageRejected', 'BadRequest'];
const throttleErrors = ['TooManyRequests', 'Throttling'];

export class SesError extends Error {
  status: number;
  type: string;  // SES's error type without "Exception", e.g. SendingPaused; '' when it gave none we can read
  // The message is the type and status only: SES's own text can name the recipient, and it ends up in the database.
  constructor(status: number, type: string) {
    super(`${type || 'HTTP'} ${status}`);
    this.status = status;
    this.type = type;
  }

  // The type comes in the x-amzn-ErrorType header or as __type or code in the body,
  // e.g. "MessageRejected:http://internal.amazon.com/..." or "com.amazonaws.sesv2#BadRequestException".
  static async from(res: Response): Promise<SesError> {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await res.text()) ?? {}; } catch {}
    const raw = res.headers.get('x-amzn-ErrorType') ?? body.__type ?? body.code;
    const type = typeof raw === 'string' ? raw.split(':')[0].split('#').pop()!.replace(/Exception$/, '') : '';
    return new SesError(res.status, /^[A-Za-z]{1,64}$/.test(type) ? type : '');
  }

  get outcome(): Outcome {
    if (this.status === 429 || throttleErrors.includes(this.type)) return 'throttled';
    if (this.status >= 500) return 'unsure';
    if (recipientErrors.includes(this.type)) return 'recipient';
    return 'account';
  }
}

// SES_ENDPOINT points at scripts/ses-mock.ts during local development. A Worker that serves real
// readers must not send their addresses anywhere else, so there it is ignored.
const localHost = /^(localhost|127\.0\.0\.1|\[::1\])$|\.test$/;
let warned = false;

export function sesEndpoint(env: Env): string {
  const ses = `https://email.${env.AWS_REGION}.amazonaws.com`;
  if (!env.SES_ENDPOINT) return ses;
  let host = '';
  try { host = new URL(env.PUBLIC_URL).hostname; } catch {}
  if (localHost.test(host)) return env.SES_ENDPOINT;
  if (!warned) console.warn(JSON.stringify({ event: 'ses_endpoint_ignored', message: 'SES_ENDPOINT is set but PUBLIC_URL is not local; sending to SES' }));
  warned = true;
  return ses;
}

export async function sendEmail(env: Env, mail: Mail): Promise<string> {
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
    service: 'ses',
    retries: 0, // the batch loop retries, so a slow SES never holds a Worker request open
  });
  const res = await aws.fetch(`${sesEndpoint(env)}/v2/email/outbound-emails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      FromEmailAddress: mail.from,
      Destination: { ToAddresses: [mail.to] },
      ...(mail.replyTo ? { ReplyToAddresses: [mail.replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: mail.subject, Charset: 'UTF-8' },
          Body: { Html: { Data: mail.html, Charset: 'UTF-8' }, Text: { Data: mail.text, Charset: 'UTF-8' } },
          Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })),
        },
      },
      ConfigurationSetName: env.SES_CONFIGURATION_SET,
      EmailTags: Object.entries(mail.tags).map(([Name, Value]) => ({ Name, Value })),
    }),
  });
  if (!res.ok) throw await SesError.from(res);
  const { MessageId } = await res.json() as { MessageId: string };
  return MessageId;
}
