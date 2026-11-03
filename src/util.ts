export const emailPattern = /^[^\s@<>()\[\],;:"]+@[^\s@<>()\[\],;:"]+\.[^\s@<>()\[\],;:"]{2,}$/;

// NFC, so "é" typed as e plus a combining accent (U+0301) and as one character is one contact and one hash.
// No control or invisible characters and no trailing dot: each would give one mailbox a second hash,
// and with it a way past a suppression.
export function normalizeEmail(email: unknown): string | null {
  const e = typeof email === 'string' ? email.trim().toLowerCase().normalize('NFC') : '';
  return e.length <= 254 && emailPattern.test(e) && !/\p{C}/u.test(e) && !e.endsWith('.') ? e : null;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 2026-11-02T15:00:00Z: sorts as text, and matches what SQLite's strftime writes.
export function iso(date: Date): string {
  return date.toISOString().slice(0, 19) + 'Z';
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

// Compares two strings in time that does not depend on where they differ.
export async function sameSecret(a: string, b: string) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}
