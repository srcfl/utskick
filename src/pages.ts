// The few pages a reader can land on: unsubscribe, done, not found. Plain HTML, no scripts.
import type { Config } from './config.ts';
import { escapeHtml } from './render.ts';

type Site = Pick<Config, 'organization' | 'homepage' | 'support'>;

export function page(site: Site, title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ${escapeHtml(site.organization)}</title>
<style>
  :root { --paper: #FAFAF7; --ink: #0A0A0A; --muted: #6B7280; --line: #E7E5E0; --accent: #E85D1F; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 64px 24px; }
  .kicker { font: 12px/1 ui-monospace, "JetBrains Mono", Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 32px; }
  h1 { font-weight: 300; font-size: 34px; line-height: 1.15; margin: 0 0 16px; }
  p { margin: 0 0 16px; }
  a { color: var(--ink); }
  button { font: inherit; font-weight: 700; font-size: 15px; background: var(--ink); color: #fff; border: 0; border-radius: 0; padding: 14px 22px; cursor: pointer; margin-top: 8px; }
  button:hover { background: var(--accent); color: var(--ink); }
  .small { font-size: 14px; color: var(--muted); margin-top: 40px; }
</style>
</head>
<body><main><div class="kicker">${escapeHtml(site.organization)}</div>${body}</main></body>
</html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

const help = (site: Site) => `<p class="small">Questions? Email <a href="mailto:${escapeHtml(site.support)}">${escapeHtml(site.support)}</a>.</p>`;

export function confirmPage(site: Site, listName: string): Response {
  return page(site, `Unsubscribe from ${listName}`, `<h1>Unsubscribe from ${escapeHtml(listName)}?</h1>
<p>One click and you will get no more emails from ${escapeHtml(listName)}. Other lists you are on stay as they are.</p>
<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>${help(site)}`);
}

export function donePage(site: Site, listName: string): Response {
  const home = new URL(site.homepage).hostname.replace(/^www\./, '');
  return page(site, 'Unsubscribed', `<h1>You are unsubscribed.</h1>
<p>You will get no more emails from ${escapeHtml(listName)}. We have deleted your address from the list.</p>
<p>Changed your mind? You can sign up again at <a href="${escapeHtml(site.homepage)}">${escapeHtml(home)}</a>.</p>${help(site)}`);
}

// A test mail's link works like the real one, but nobody leaves a list because of a test.
export function testDonePage(site: Site, listName: string): Response {
  return page(site, 'Test email', `<h1>This was a test email.</h1>
<p>In a real issue this button takes the reader off ${escapeHtml(listName)}. Nothing changed for your address.</p>${help(site)}`);
}

export function notFound(site: Site): Response {
  return page(site, 'Not found', `<h1>This link does not work.</h1><p>It may be old or cut short.</p>${help(site)}`, 404);
}

export function archiveUnsubscribePage(site: Site): Response {
  return page(site, 'Unsubscribe', `<h1>Unsubscribe</h1><p>Use the unsubscribe link at the bottom of the email you got, or write to us and we will take you off the list.</p>${help(site)}`);
}
