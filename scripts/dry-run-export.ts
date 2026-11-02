// Dry run of a real issue over a real Mailchimp export, entirely in memory: the export is imported
// into a throwaway SQLite database, the send is planned and one mail rendered, and nothing is written
// to disk or sent. It prints counts only, never an address or a name.
//   node scripts/dry-run-export.ts <config.json> <export-dir> <issue.html> <list> <subject>
import { readFileSync } from 'node:fs';
import { readExport } from '../cli/mailchimp.ts';
import { handle } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { admin, testEnv } from '../test/helpers.ts';

const [configFile, dir, issue, list, subject] = process.argv.slice(2);
if (!subject) throw new Error('usage: dry-run-export.ts <config.json> <export-dir> <issue.html> <list> <subject>');
const env = { ...testEnv(), CONFIG: JSON.parse(readFileSync(configFile, 'utf8')) as Config };
const call = async (path: string, body: unknown) => {
  const res = await handle(admin(path, body), env);
  const data = await res.json() as Record<string, any>;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error}`);
  return data;
};

const { contacts, suppressions } = readExport(dir);
const subscribed = new Set(contacts.map(c => c.email));
const blocked = new Set(suppressions.map(s => s.email));
console.log(`export: ${contacts.length} subscribed rows (${subscribed.size} distinct), ${suppressions.length} unsubscribed or cleaned rows`);
console.log(`  subscribed rows that are also unsubscribed or cleaned: ${[...subscribed].filter(e => blocked.has(e)).length}`);
console.log(`  with a first name: ${contacts.filter(c => c.firstName).length}; with an opt-in time: ${contacts.filter(c => c.consentedAt).length}`);
console.log(`  suppressions with Mailchimp's time: ${suppressions.filter(s => s.at).length}`);

const base = { list, source: 'mailchimp-import', consent: `mailchimp-${list}` };
const imported = await call('/admin/import', { ...base, contacts: [], suppressions });
const added = { subscribed: 0, already: 0, skipped: 0 };
for (let i = 0; i < contacts.length; i += 500) {
  const r = await call('/admin/import', { ...base, contacts: contacts.slice(i, i + 500), suppressions: [] });
  added.subscribed += r.subscribed; added.already += r.already; added.skipped += r.skipped;
}
console.log(`import: ${added.subscribed} subscribed, ${added.already} duplicates, ${added.skipped} left out (suppressed or not an address), ${imported.suppressed} suppressions`);

const html = readFileSync(issue, 'utf8');
const dry = await call('/admin/sends', { key: 'dry-run', list, kind: 'live', subject, html, dryRun: true });
const sample: string = dry.sample.html;
console.log(`dry run: ${dry.recipients} recipients, ${dry.excluded} subscribers left out`);
console.log(`  subject: ${dry.sample.subject}`);
console.log(`  from: ${dry.sample.from}; reply-to: ${dry.sample.replyTo}`);
console.log(`  tracked links: ${dry.links.length}`);
console.log(`  merge tags left in the rendered mail: ${(sample.match(/\*\|[A-Z_:]+\|\*/g) ?? []).length}`);
console.log(`  one-click unsubscribe header: ${/^<https:\/\/.+\/u\/[0-9a-f]{32}>$/.test(dry.sample.headers['List-Unsubscribe'])}, post header: ${dry.sample.headers['List-Unsubscribe-Post']}`);
console.log(`  open pixel: ${/\/o\/[0-9a-f]{32}\.gif/.test(sample)}; text part: ${dry.sample.text.length} characters`);
