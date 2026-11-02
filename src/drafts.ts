// Drafts an assistant writes, in HTML or Markdown, and their previews. A draft reaches nobody:
// a test goes through test_send, a send to a list through an admin's approval (approvals.ts).
import { isList } from './config.ts';
import type { Env } from './env.ts';
import { markdownToEmail } from './markdown.ts';
import { decodeEntities, render, stripComments, toText, trackedLinks } from './render.ts';
import { HttpError, iso } from './util.ts';

export interface DraftRow {
  id: string;
  list: string;
  subject: string;
  html: string;
  markdown: string | null;
  client_id: string;          // the assistant that saved it last
  created_by: string | null;  // the assistant that made it; null before migration 0004
  created_at: string;
  updated_at: string;
}

const maxBytes = 512 * 1024;
// A preview shows the greeting as a reader with a first name sees it, without being anyone.
const sampleName = 'Alex';

export const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

export async function saveDraft(env: Env, clientId: string, a: Record<string, unknown>, now = new Date()) {
  if (!isList(env.CONFIG, a.list)) throw new HttpError(400, `Unknown list. The lists are: ${Object.keys(env.CONFIG.lists).join(', ')}.`);
  const subject = typeof a.subject === 'string' ? a.subject.trim() : '';
  if (!subject || subject.length > 200) throw new HttpError(400, 'subject must be 1 to 200 characters.');
  const hasHtml = typeof a.html === 'string' && a.html.trim() !== '';
  const hasMarkdown = typeof a.markdown === 'string' && a.markdown.trim() !== '';
  if (hasHtml === hasMarkdown) throw new HttpError(400, 'Give html or markdown, not both and not neither.');
  const source = (hasHtml ? a.html : a.markdown) as string;
  if (source.length > maxBytes) throw new HttpError(400, `The draft is larger than ${maxBytes / 1024} KiB.`);
  const html = hasMarkdown ? markdownToEmail(source, subject) : source;
  const markdown = hasMarkdown ? source : null;

  let id = a.id;
  if (id !== undefined) {
    if (typeof id !== 'string') throw new HttpError(400, 'id must be a draft id.');
    const r = await env.DB.prepare(`UPDATE drafts SET list = ?, subject = ?, html = ?, markdown = ?, client_id = ?, updated_at = ? WHERE id = ?`)
      .bind(a.list, subject, html, markdown, clientId, iso(now), id).run();
    if (!r.meta.changes) throw new HttpError(404, `No draft ${id}.`);
  } else {
    id = `d-${hex(5)}`;
    await env.DB.prepare(`INSERT INTO drafts (id, list, subject, html, markdown, client_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, a.list, subject, html, markdown, clientId, clientId, iso(now), iso(now)).run();
  }
  return { id, list: a.list, subject, format: hasMarkdown ? 'markdown' : 'html', bytes: html.length, links: trackedLinks(stripComments(html)).length, unsubscribeLink: html.includes('*|UNSUB|*') };
}

export async function getDraft(env: Env, id: unknown): Promise<DraftRow> {
  const d = typeof id === 'string' ? await env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<DraftRow>() : null;
  if (!d) throw new HttpError(404, `No draft ${typeof id === 'string' ? id.slice(0, 40) : ''}. drafts_list shows the drafts there are.`);
  return d;
}

export async function listDrafts(env: Env) {
  // Every assistant sees and may change every draft; these say which one made it and which changed it last.
  const drafts = (await env.DB.prepare(`SELECT id, list, subject, CASE WHEN markdown IS NULL THEN 'html' ELSE 'markdown' END AS format, created_at, updated_at,
      created_by, client_id AS changed_by
    FROM drafts ORDER BY updated_at DESC, rowid DESC LIMIT 50`).all()).results;
  return { drafts };
}

// The draft as a reader would get it, with a sample name, no tracking and no real recipient.
export async function previewDraft(env: Env, id: unknown) {
  const d = await getDraft(env, id);
  const list = env.CONFIG.lists[d.list];
  const html = render(stripComments(d.html), {
    firstName: sampleName,
    fallback: list?.fname ?? 'there',
    unsubscribeUrl: `${env.PUBLIC_URL}/unsubscribe`,
    archiveUrl: `${env.PUBLIC_URL}/a/preview`,
  });
  return {
    id: d.id, list: d.list, from: list?.from, replyTo: list?.replyTo ?? null, subject: d.subject,
    html, text: toText(html), links: trackedLinks(stripComments(d.html)), unsubscribeLink: d.html.includes('*|UNSUB|*'),
  };
}

// --------------------------------------------------------------------------
// What a preview does not show
// --------------------------------------------------------------------------

// The approval page shows the mail as a browser draws it. Some of what goes out never shows
// there: blocks only Outlook reads, text hidden with CSS (which still lands in the text/plain
// part), and where the links lead. inspectMail finds them in the HTML as it is sent.
export interface Inspection {
  links: string[];                                   // every href and form action, in order, merge tags as written
  images: string[];                                  // every src, background, url() and <link>: what a reader's client loads
  outlook: { condition: string; text: string }[];    // <!--[if mso]> blocks with text or links in them
  outlookBlocks: number;                             // all of them, layout-only ones too
  hidden: { why: string; text: string }[];           // elements with text that CSS hides
  preheader: string | null;                          // the one hidden line inboxes show beside the subject
  styleSheetHides: boolean;                          // a <style> rule hides something, by class or tag
}

const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const zero = String.raw`0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:!important)?\s*(?:;|$)`;
// Each with what a child would need to show again; null when nothing can.
const hiders: [string, RegExp, RegExp | null][] = [
  ['display:none', /display\s*:\s*none/i, null],
  ['visibility:hidden', /visibility\s*:\s*hidden/i, /visibility\s*:\s*visible/i],
  ['opacity:0', new RegExp(String.raw`(?:^|[;\s])opacity\s*:\s*${zero}`, 'i'), null],
  ['font-size:0', new RegExp(String.raw`(?:^|[;\s])font-size\s*:\s*${zero}`, 'i'), /font-size\s*:\s*(?!0(?:\.0+)?(?:px|pt|em|rem|%)?\b)[\d.]/i],
  ['far off screen', /(?:^|[;\s])(?:left|top|text-indent|margin-left|margin-top)\s*:\s*-\d{3,}/i, null],
];
const zeroBox = new RegExp(String.raw`(?:^|[;\s])(?:max-)?(?:height|width)\s*:\s*${zero}`, 'i');
const tagPattern = /<([a-z][a-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

function attributes(tag: string, names: string[]): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`\s(?:${names.join('|')})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`, 'gi');
  for (const m of tag.matchAll(re)) out.push(decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim());
  return out;
}

// Text as the text/plain part would carry it, without what is left of comment markers.
function textOf(html: string): string {
  return toText(html.replace(/<!--\[if[^\]]*\]>|<!\[endif\]-->|<!-->|<!--|-->/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Zero-width characters and spaces some templates pad a preheader with, so inboxes show no body text after it.
const padding = /[\s ͏​-‍⁠﻿]|&zwnj;|&#8204;|&#x200c;|&#847;/gi;

// The end of an element's content: its closing tag, counting nested ones of the same name.
function closeOf(html: string, name: string, from: number): number {
  const re = new RegExp(String.raw`<(/?)${name.replace(/[-:]/g, m => `\\${m}`)}\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m; (m = re.exec(html));) {
    depth += m[1] ? -1 : 1;
    if (!depth) return m.index;
  }
  return html.length;
}

export function inspectMail(source: string): Inspection {
  const html = stripComments(source);
  const links: string[] = [];
  const images: string[] = [];
  const add = (list: string[], v: string) => { if (v && !list.includes(v)) list.push(v); };
  for (const [tag, name] of html.matchAll(tagPattern)) {
    // A <link> is loaded, like an image, not followed.
    const loads = name.toLowerCase() === 'link';
    for (const v of attributes(tag, ['href', 'action', 'formaction'])) add(loads ? images : links, v);
    for (const v of attributes(tag, ['src', 'background', 'poster'])) add(images, v);
  }
  for (const m of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) add(images, decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim());

  const blocks = [...html.matchAll(/<!--\[if\s+([^\]]+)\]>([\s\S]*?)<!\[endif\]-->/gi)];
  const outlook = blocks
    .map(m => ({ condition: m[1].trim(), text: textOf(m[2]), linked: /\s(?:href|src|action)\s*=/i.test(m[2]) }))
    .filter(b => b.text || b.linked)
    .map(({ condition, text }) => ({ condition, text: text || '(links or images, no text)' }));

  // Elements hidden by an inline style or the hidden attribute. Those with no text and no link
  // (spacers, layout fixes) do not matter; an element inside one already found is not counted twice.
  const found: { why: string; start: number; end: number; inner: string }[] = [];
  const bodyAt = html.search(/<body\b/i);
  for (const m of html.matchAll(tagPattern)) {
    const name = m[1].toLowerCase();
    if (voidTags.has(name) || m.index! < bodyAt || found.some(f => m.index! > f.start && m.index! < f.end)) continue;
    const style = attributes(m[0], ['style']).join(';');
    const attribute = /\shidden(?:\s|=|>|\/)/i.test(m[0]);
    const candidates = hiders.filter(([, hides]) => hides.test(style));
    const boxed = zeroBox.test(style) && /overflow\s*:\s*hidden/i.test(style);
    if (!attribute && !candidates.length && !boxed) continue;
    const start = m.index! + m[0].length;
    const end = closeOf(html, name, start);
    const inner = html.slice(start, end);
    const why = attribute ? 'the hidden attribute'
      : candidates.find(([, , shows]) => !(shows && shows.test(inner)))?.[0] ?? (boxed ? 'zero size' : '');
    if (why && (textOf(inner) || /\s(?:href|action)\s*=/i.test(inner))) found.push({ why, start: m.index!, end, inner });
  }

  // The usual preheader: the first hidden element, before any text a reader sees, short and with no link.
  let preheader: string | null = null;
  const first = found[0];
  if (first && !/\s(?:href|action)\s*=/i.test(first.inner)) {
    const before = textOf(html.slice(Math.max(0, bodyAt), first.start).replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, '').replace(/<body\b[^>]*>/i, ''));
    const text = textOf(first.inner);
    if (!before && text.replace(padding, '').length <= 200) {
      preheader = text.replace(/(?:&zwnj;|&#8204;|&#x200c;|&#847;|[͏​-‍⁠﻿])+/gi, '').replace(/\s+/g, ' ').trim();
      found.shift();
    }
  }
  const sheets = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  return {
    links, images, outlook, outlookBlocks: blocks.length,
    hidden: found.map(f => ({ why: f.why, text: textOf(f.inner) })),
    preheader,
    styleSheetHides: /display\s*:\s*none|visibility\s*:\s*hidden/i.test(sheets),
  };
}

