// Checks that a message really comes from Amazon SNS, as AWS describes in
// "Verifying the signatures of Amazon SNS messages".

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

// SNS in the topic's own region, and nothing else: a looser pattern such as sns.*.amazonaws.com
// also matches S3 hosts (sns.s3.amazonaws.com), where anyone can own a bucket called "sns".
export function regionOf(topicArn: string): string | null {
  const region = topicArn.split(':')[3];
  return region && /^[a-z]{2}(-[a-z]+)+-\d$/.test(region) ? region : null;
}

export function isSnsUrl(url: string, region: string, path?: RegExp): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === `sns.${region}.amazonaws.com` && !u.port && !u.username && !u.password
      && (!path || (path.test(u.pathname) && !u.search && !u.hash));
  } catch {
    return false;
  }
}

const certPath = /^\/SimpleNotificationService-[0-9a-f]+\.pem$/;

const certs = new Map<string, Promise<CryptoKey>>();

export async function verifySns(m: SnsMessage, region: string): Promise<boolean> {
  if (typeof m.SigningCertURL !== 'string' || !isSnsUrl(m.SigningCertURL, region, certPath)) return false;
  const hash = { '1': 'SHA-1', '2': 'SHA-256' }[m.SignatureVersion];
  if (!hash || typeof m.Signature !== 'string') return false;
  const keys = m.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const text = keys.filter(k => typeof (m as unknown as Record<string, unknown>)[k] === 'string')
    .map(k => `${k}\n${(m as unknown as Record<string, string>)[k]}\n`).join('');
  const cacheKey = `${hash} ${m.SigningCertURL}`;
  if (!certs.has(cacheKey)) certs.set(cacheKey, publicKey(m.SigningCertURL, hash).catch(e => { certs.delete(cacheKey); throw e; }));
  try {
    const key = await certs.get(cacheKey)!;
    const signature = Uint8Array.from(atob(m.Signature), c => c.charCodeAt(0));
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

async function publicKey(url: string, hash: string): Promise<CryptoKey> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`certificate ${res.status}`);
  const pem = await res.text();
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  return crypto.subtle.importKey('spki', spki(der), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
}

// WebCrypto takes a public key but not a certificate, so walk the DER to the subjectPublicKeyInfo:
// Certificate { tbsCertificate { [0] version, serial, signature, issuer, validity, subject, subjectPublicKeyInfo, ... } }
export function spki(der: Uint8Array): Uint8Array {
  const tlv = (at: number) => {
    let length = der[at + 1];
    let header = 2;
    if (length & 0x80) {
      const n = length & 0x7f;
      length = 0;
      for (let i = 0; i < n; i++) length = length * 256 + der[at + 2 + i];
      header += n;
    }
    return { tag: der[at], start: at, body: at + header, end: at + header + length };
  };
  const tbs = tlv(tlv(0).body);
  let at = tbs.body;
  if (tlv(at).tag === 0xa0) at = tlv(at).end;
  for (let i = 0; i < 5; i++) at = tlv(at).end;
  const key = tlv(at);
  return der.slice(key.start, key.end);
}
