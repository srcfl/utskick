// Reads a Mailchimp audience export (Audience → Export audience, unzipped).
// subscribed_*.csv become subscribers with their opt-in time; unsubscribed_*.csv and cleaned_*.csv
// become suppressions. nonsubscribed_*.csv never gave consent and is left out.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = '', record: string[] = [], quoted = false;
  const s = text.replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      record.push(field); records.push(record); field = ''; record = [];
    } else field += c;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  const [header, ...rows] = records.filter(r => r.some(f => f !== ''));
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// Mailchimp writes UTC as "2021-03-04 10:15:00".
function time(s: string | undefined): string | null {
  return s && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : null;
}

export interface ImportContact { email: string; firstName: string; lastName: string; consentedAt: string | null }
export interface ImportSuppression { email: string; reason: 'mailchimp-unsubscribed' | 'mailchimp-cleaned'; at: string | null }

export function readExport(dir: string) {
  const files = readdirSync(dir).sort();
  const read = (prefix: string) => files.filter(f => f.toLowerCase().startsWith(prefix) && f.endsWith('.csv'))
    .flatMap(f => parseCsv(readFileSync(join(dir, f), 'utf8')));
  const email = (r: Record<string, string>) => (r['Email Address'] ?? r['email'] ?? '').trim().toLowerCase();

  const contacts: ImportContact[] = read('subscribed').map(r => ({
    email: email(r),
    firstName: (r['First Name'] ?? '').trim(),
    lastName: (r['Last Name'] ?? '').trim(),
    // Double opt-in confirmation if there is one, else the opt-in, else the last change.
    consentedAt: time(r.CONFIRM_TIME) ?? time(r.OPTIN_TIME) ?? time(r.LAST_CHANGED),
  }));
  const suppressions: ImportSuppression[] = [
    // Kept with the time Mailchimp recorded, so the suppression list says when someone left.
    ...read('unsubscribed').map(r => ({ email: email(r), reason: 'mailchimp-unsubscribed' as const, at: time(r.UNSUB_TIME) })),
    ...read('cleaned').map(r => ({ email: email(r), reason: 'mailchimp-cleaned' as const, at: time(r.CLEAN_TIME) })),
  ];
  return { contacts, suppressions };
}
