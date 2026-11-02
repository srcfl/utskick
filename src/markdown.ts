// Markdown for the drafts an assistant writes: enough for a newsletter, and nothing that runs.
// Raw HTML is escaped, and a link survives only as http, https or mailto. Mailchimp merge tags
// such as *|FNAME|* pass through untouched, so render.ts fills them in as for any issue.
import { escapeHtml } from './render.ts';

// Inline styles, since many mail clients drop <style>. The colours are pages.ts's.
const css = {
  p: 'margin:0 0 16px',
  h1: 'font-size:28px;line-height:1.2;font-weight:600;margin:0 0 16px',
  h2: 'font-size:22px;line-height:1.25;font-weight:600;margin:24px 0 12px',
  h3: 'font-size:18px;line-height:1.3;font-weight:600;margin:20px 0 8px',
  list: 'margin:0 0 16px;padding-left:24px',
  li: 'margin:0 0 6px',
  quote: 'margin:0 0 16px;padding:0 0 0 16px;border-left:3px solid #E7E5E0;color:#4B5563',
  hr: 'border:0;border-top:1px solid #E7E5E0;margin:24px 0',
  a: 'color:#E85D1F',
  code: 'font-family:ui-monospace,Menlo,monospace;font-size:14px;background:#F3F4F6;padding:1px 4px',
  pre: 'font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#F3F4F6;padding:12px;margin:0 0 16px;white-space:pre-wrap',
  img: 'max-width:100%;height:auto;border:0;display:block;margin:0 0 16px',
};

const heading = /^(#{1,3})\s+(.*?)\s*#*\s*$/;
const rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
const quote = /^\s*>/;
const bullet = /^\s*[-*+]\s+/;
const numbered = /^\s*\d{1,3}[.)]\s+/;
const fence = /^\s*```/;
const startsBlock = (line: string) => [heading, rule, quote, bullet, numbered, fence].some(r => r.test(line));

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\0/g, '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  // Lines from i on while they match, with the marker cut off.
  const take = (match: RegExp, strip: RegExp) => {
    const got: string[] = [];
    while (i < lines.length && match.test(lines[i])) got.push(lines[i++].replace(strip, ''));
    return got;
  };
  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if (!line.trim()) { i++; continue; }
    if ((m = line.match(heading))) {
      const n = m[1].length as 1 | 2 | 3;
      out.push(`<h${n} style="${css[`h${n}`]}">${inline(m[2])}</h${n}>`);
      i++;
    } else if (rule.test(line)) {
      out.push(`<hr style="${css.hr}">`);
      i++;
    } else if (quote.test(line)) {
      out.push(`<blockquote style="${css.quote}">${markdownToHtml(take(quote, /^\s*> ?/).join('\n'))}</blockquote>`);
    } else if (bullet.test(line) || numbered.test(line)) {
      const tag = bullet.test(line) ? 'ul' : 'ol';
      const items = take(tag === 'ul' ? bullet : numbered, tag === 'ul' ? bullet : numbered);
      out.push(`<${tag} style="${css.list}">${items.map(t => `<li style="${css.li}">${inline(t)}</li>`).join('')}</${tag}>`);
    } else if (fence.test(line)) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !fence.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre style="${css.pre}"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    } else {
      // A paragraph runs to a blank line or a new block. Two trailing spaces or a backslash break the line.
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++]);
      out.push(`<p style="${css.p}">${para.map((l, k) => {
        const hard = k < para.length - 1 && / {2,}$|\\$/.test(l);
        return inline(l.replace(/\\$/, '').trimEnd()) + (hard ? '<br>' : '');
      }).join('\n')}</p>`);
    }
  }
  return out.join('\n');
}

// Bold, italics, code, links and images in one line of text.
function inline(text: string): string {
  const kept: string[] = [];
  const keep = (html: string) => `\0${kept.push(html) - 1}\0`;
  let s = text
    .replace(/\*\|[A-Z0-9_]+\|\*/g, keep)
    .replace(/`([^`]+)`/g, (_, code) => keep(`<code style="${css.code}">${escapeHtml(code)}</code>`));
  s = escapeHtml(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) =>
      /^https?:\/\//i.test(url) ? keep(`<img src="${url}" alt="${alt}" style="${css.img}">`) : alt)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
      /^(https?:\/\/|mailto:)/i.test(url) ? keep(`<a href="${url}" style="${css.a}">${emphasis(label)}</a>`) : label)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, before, url) => before + keep(`<a href="${url}" style="${css.a}">${url}</a>`));
  s = emphasis(s);
  while (s.includes('\0')) s = s.replace(/\0(\d+)\0/g, (_, n) => kept[Number(n)]);
  return s;
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)__(?=\S)(.+?)(?<=\S)__(?=\W|$)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '<em>$1</em>')
    .replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?=\W|$)/g, '$1<em>$2</em>');
}

// A whole email: the content, then links to the web version and to unsubscribe.
export function markdownToEmail(markdown: string, subject: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#FAFAF7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
<tr><td style="padding:32px 24px 8px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0A0A0A">
${markdownToHtml(markdown)}
</td></tr>
<tr><td style="padding:16px 24px 40px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#6B7280">
<a href="*|ARCHIVE|*" style="color:#6B7280">View in your browser</a> &middot; <a href="*|UNSUB|*" style="color:#6B7280">Unsubscribe</a>
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}
