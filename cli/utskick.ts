#!/usr/bin/env node
// Utskick's command line. Talks to the Worker's /admin API; SES is only ever called by the Worker.
//
//   node cli/utskick.ts import <mailchimp-export-dir> --list newsletter
//   node cli/utskick.ts send <issue.html> --list newsletter --key newsletter-22 --subject "…" --dry-run
//   node cli/utskick.ts send <issue.html> --list newsletter --key newsletter-22 --subject "…" --test you@example.com [--fname You]
//   node cli/utskick.ts send <issue.html> --list newsletter --key newsletter-22 --subject "…" --confirm <count>
//   node cli/utskick.ts resend <issue.html> --list newsletter --parent newsletter-22 --subject "…" [--after-days 3] [--dry-run | --confirm N]
//   node cli/utskick.ts resume <key>          carry on with a send that stopped, e.g. a test send
//   node cli/utskick.ts stats <key>
//   node cli/utskick.ts retry-unknown <key>   send the rows SES may or may not have taken, after you checked
//   node cli/utskick.ts retry-failed <key>    send the rows SES refused again, once the cause is fixed
//
// MAILER_URL and MAILER_ADMIN_TOKEN come from the environment or from .env in the repo root.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readExport } from './mailchimp.ts';

const root = new URL('../', import.meta.url);
if (existsSync(new URL('.env', root))) process.loadEnvFile(new URL('.env', root));
const base = (process.env.MAILER_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const adminToken = process.env.MAILER_ADMIN_TOKEN ?? '';
// The admin token goes in every request, so plain http only to this machine.
if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(base)) fail(`MAILER_URL must start with https:// (plain http only for localhost): ${base}`);

const { positionals, values: o } = parseArgs({
  allowPositionals: true,
  options: {
    list: { type: 'string' },
    key: { type: 'string' },
    subject: { type: 'string' },
    test: { type: 'string' },
    fname: { type: 'string' },
    'fname-fallback': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    confirm: { type: 'string' },
    rate: { type: 'string', default: '10' },
    parent: { type: 'string' },
    'after-days': { type: 'string', default: '3' },
  },
});
const [command, arg] = positionals;
const list = (): string => o.list ?? fail('--list is required, e.g. --list newsletter');

async function api(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${data.error ?? ''}`), { status: res.status, code: String(data.error ?? '') });
  return data;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Images next to the HTML (src="issue-22-hero.jpg") are uploaded and served from the Worker.
async function withHostedImages(file: string, html: string): Promise<string> {
  const types: Record<string, string> = { '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png', '.gif': 'gif', '.webp': 'webp' };
  for (const [, src] of [...html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)]) {
    if (/^(https?:|data:|cid:|\*\|)/i.test(src)) continue;
    const ext = types[extname(src).toLowerCase()];
    if (!ext) fail(`unsupported image: ${src}`);
    const bytes = readFileSync(resolve(dirname(file), src));
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const { url } = await api('PUT', `/admin/images/${name}`, undefined, bytes);
    html = html.replaceAll(`src="${src}"`, `src="${url}"`);
    console.log(`image ${src} -> ${url}`);
  }
  return html;
}

async function deliver(key: string) {
  const rate = Math.max(1, Math.min(14, Number(o.rate)));
  let total = { sent: 0, skipped: 0, failed: 0 };
  for (;;) {
    const started = Date.now();
    let r;
    try {
      r = await api('POST', `/admin/sends/${key}/batch`, { max: rate });
    } catch (error) {
      const { message, status, code } = error as Error & { status?: number; code?: string };
      console.log();
      // SES refused the account, the key or a setting: every other mail would fail the same way.
      if (code?.startsWith('ses_account_error')) {
        fail(`SES refused the send as a whole: ${code.replace(/^ses_account_error: /, '')}. Nothing more goes out.
The rows of that batch are pending again. Check the AWS keys, whether sending is paused, the configuration
set and the sender's domain in SES, then run \`resume ${key}\`.`);
      }
      // Any other answer from the Worker that says no is a mistake to fix, not a blip to wait out.
      if (status && status < 500) fail(message);
      // Each call claims its rows first, so trying again cannot send twice.
      console.error(`${message}; trying again in 5 s`);
      await sleep(5000);
      continue;
    }
    total = { sent: total.sent + r.sent, skipped: total.skipped + r.skipped, failed: total.failed + r.failed };
    process.stdout.write(`\rsent ${total.sent} · skipped ${total.skipped} · failed ${total.failed} · pending ${r.pending}   `);
    if (r.pending === 0) {
      console.log();
      if (r.sending) console.log(`${r.sending} still sending: another run has them now, or a run stopped half way. If nothing else runs, wait 10 minutes and run \`resume ${key}\`; what is still not settled then turns unknown.`);
      if (r.unknown) console.log(`${r.unknown} unknown: SES may or may not have them (no answer, an SES server error, or a run that stopped). Check, then \`retry-unknown ${key}\` to send them again, or leave them.`);
      if (total.failed) console.log(`${total.failed} failed: SES refused those mails. If the cause was ours (an unverified sender, say), fix it and run \`retry-failed ${key}\`.`);
      return;
    }
    await sleep(Math.max(0, 1000 - (Date.now() - started)) + (r.retry ? 2000 : 0));
  }
}

// What the dry run found wrong with the mail. Older Workers send no warnings. One line each, whatever the text holds.
function printWarnings(r: any) {
  if (!Array.isArray(r.warnings)) return;
  for (const w of r.warnings) console.log(`warning: ${String(w).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()}`);
}

function printDryRun(r: any) {
  console.log(`${r.recipients} recipients${r.excluded ? `, ${r.excluded} subscribers left out (unsubscribed, bounced or complained)` : ''}`);
  // Older Workers do not send the size either.
  if (Number.isFinite(r.bytes)) console.log(`size: ${(r.bytes / 1024).toFixed(1)} KB (the sample's HTML)`);
  printWarnings(r);
  console.log(`subject: ${r.sample.subject}\nfrom: ${r.sample.from}\nreply-to: ${r.sample.replyTo}`);
  console.log(`tracked links (${r.links.length}):`);
  r.links.forEach((l: string, n: number) => console.log(`  ${n}  ${l}`));
  mkdirSync(new URL('.dev/', root), { recursive: true });
  const out = new URL(`.dev/dry-run-${r.key}.html`, root);
  writeFileSync(out, r.sample.html);
  // The address stays out of the terminal; the sample file is in .dev/, which git ignores.
  console.log(`sample (first recipient): ${out.pathname}`);
}

async function send(kind: 'live' | 'resend') {
  if (!arg) fail('which HTML file?');
  list();
  const key = kind === 'resend' ? o.key ?? `${o.parent}-resend` : o.key;
  if (!key) fail('--key is required, e.g. --key the-source-22');
  if (!o.subject) fail('--subject is required');
  const html = await withHostedImages(arg, readFileSync(arg, 'utf8'));
  const body: Record<string, unknown> = { key, list: list(), kind, subject: o.subject, html, fnameFallback: o['fname-fallback'] };
  if (kind === 'resend') Object.assign(body, { parent: o.parent, afterDays: Number(o['after-days']) });

  if (o.test) {
    const testTo = o.test.split(',').map(email => ({ email: email.trim(), firstName: o.fname }));
    const testKey = `${key}-test-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const r = await api('POST', '/admin/sends', { ...body, key: testKey, kind: 'test', testTo });
    console.log(`test ${testKey} to ${r.recipients} address(es)`);
    return deliver(testKey);
  }
  const dry = await api('POST', '/admin/sends', { ...body, dryRun: true });
  if (dry.existing) {
    // Created and confirmed earlier with this exact content: carry on with whoever is left.
    if (o['dry-run']) return console.log(`${key} exists with ${dry.recipients} recipients; \`stats ${key}\` shows where it stands`);
    console.log(`resuming ${key}: ${dry.recipients} recipients`);
    return deliver(key);
  }
  if (o['dry-run']) return printDryRun(dry);
  if (o.confirm !== String(dry.recipients)) {
    printDryRun(dry);
    fail(`\nNothing sent. This goes to ${dry.recipients} people on ${list()}. To send, run again with --confirm ${dry.recipients}`);
  }
  // The count matches, so this goes out. Show once more what the dry run warned about.
  printWarnings(dry);
  const r = await api('POST', '/admin/sends', body);
  console.log(`created ${key}: ${r.recipients} recipients`);
  await deliver(key);
}

async function stats(key: string) {
  const s = await api('GET', `/admin/sends/${key}`);
  const sent = s.status.sent ?? 0;
  const pct = (n: number) => (sent ? `${((100 * n) / sent).toFixed(1)} %` : '–');
  console.log(`${s.key} (${s.kind}, ${s.list}): ${s.subject}`);
  console.log(`recipients ${s.recipients} · ${Object.entries(s.status).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`delivered ${s.delivered} · bounced ${s.bounced} · soft bounces ${s.softBounced} · complaints ${s.complaints} · unsubscribed ${s.unsubscribed}`);
  console.log(`opens ${s.opens.unique} unique (${pct(s.opens.unique)}), ${s.opens.total} total · clicks ${s.clicks.unique} unique (${pct(s.clicks.unique)}), ${s.clicks.total} total`);
  for (const l of s.links) console.log(`  ${String(l.unique).padStart(5)} unique ${String(l.total).padStart(5)} total  ${l.url}`);
}

switch (command) {
  case 'import': {
    if (!arg) fail('which export directory?');
    const { contacts, suppressions } = readExport(arg);
    const total = { subscribed: 0, already: 0, suppressed: 0, skipped: 0 };
    const add = (r: typeof total) => { for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k]; };
    add(await api('POST', '/admin/import', { list: list(), source: 'mailchimp-import', consent: `mailchimp-${list()}`, contacts: [], suppressions }));
    for (let i = 0; i < contacts.length; i += 500) {
      add(await api('POST', '/admin/import', { list: list(), source: 'mailchimp-import', consent: `mailchimp-${list()}`, contacts: contacts.slice(i, i + 500), suppressions: [] }));
    }
    console.log(`${contacts.length} subscribed rows and ${suppressions.length} unsubscribed or cleaned rows read`);
    console.log(`new subscribers ${total.subscribed} · already there ${total.already} · new suppressions ${total.suppressed} · left out (suppressed or bad address) ${total.skipped}`);
    break;
  }
  case 'send': await send('live'); break;
  case 'resend': await send('resend'); break;
  case 'stats': await stats(arg ?? fail('which key?')); break;
  case 'resume': await deliver(arg ?? fail('which key?')); break;
  case 'retry-unknown': console.log(await api('POST', `/admin/sends/${arg ?? fail('which key?')}/retry-unknown`, {})); break;
  case 'retry-failed': console.log(await api('POST', `/admin/sends/${arg ?? fail('which key?')}/retry-failed`, {})); break;
  default: fail('commands: import, send, resend, resume, stats, retry-unknown, retry-failed (see the top of cli/utskick.ts)');
}
