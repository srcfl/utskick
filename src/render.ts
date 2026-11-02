// Turns an issue's HTML (Mailchimp merge tags and all) into one recipient's email.
// Pure string work, so the Worker and the tests run the same code.

// Keeps <!--[if mso]> ... <![endif]--> for Outlook; drops the notes we leave for ourselves.
// Also keeps the "not Outlook" form, <!--[if !mso]><!--> … <!--<![endif]-->, whose <!--> and
// <!--<![endif]--> must survive or the content between them disappears for every reader.
export function stripComments(html: string): string {
  return html.replace(/<!--(?!\[if)(?!<!\[endif)(?!>)[\s\S]*?-->/g, '').replace(/^\s+(?=<!DOCTYPE)/i, '');
}

const anchorHref = /(<a\b[^>]*?\bhref\s*=\s*")([^"]*)(")/gi;

// The distinct http(s) links in <a> tags, decoded, in the order they first appear.
export function trackedLinks(html: string): string[] {
  const links: string[] = [];
  for (const [, , href] of html.matchAll(anchorHref)) {
    const url = decodeEntities(href);
    if (/^https?:\/\//i.test(url) && !links.includes(url)) links.push(url);
  }
  return links;
}

export interface RenderOptions {
  firstName: string | null;
  fallback: string;
  unsubscribeUrl: string;
  archiveUrl: string;
  links?: string[];
  clickUrl?: (n: number) => string;
  openUrl?: string;
}

export function render(html: string, o: RenderOptions): string {
  const name = o.firstName?.trim() || o.fallback;
  let out = html
    .replaceAll('*|FNAME|*', escapeHtml(name))
    .replaceAll('*|UNSUB|*', o.unsubscribeUrl)
    .replaceAll('*|ARCHIVE|*', o.archiveUrl);
  if (o.links && o.clickUrl) {
    const { links, clickUrl } = o;
    out = out.replace(anchorHref, (all, before, href, after) => {
      const n = links.indexOf(decodeEntities(href));
      return n === -1 ? all : before + clickUrl(n) + after;
    });
  }
  if (o.openUrl) {
    const pixel = `<img src="${o.openUrl}" width="1" height="1" alt="" style="display:block; width:1px; height:1px; border:0;">`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, pixel + '</body>') : out + pixel;
  }
  return out;
}

// The text/plain part. Mail clients rarely show it, but spam filters look for it.
export function toText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<a\b[^>]*?\bhref\s*=\s*"(https?:[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `${text} (${href})`)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const named: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', rarr: '→', larr: '←', middot: '·', copy: '©',
  times: '×', deg: '°', euro: '€', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return named[e.toLowerCase()] ?? all;
  });
}
