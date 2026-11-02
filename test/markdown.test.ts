import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToEmail, markdownToHtml } from '../src/markdown.ts';
import { trackedLinks } from '../src/render.ts';

test('Markdown: headings, paragraphs, emphasis, links, lists, quotes and rules', () => {
  const html = markdownToHtml([
    '# Title', '', 'Hi *|FNAME|*, this is **bold**, *soft* and `code`.', 'Same paragraph.  ', 'After a break.', '',
    '- one', '- [two](https://example.com/two)', '', '1. first', '2. second', '', '> quoted', '', '---', '',
    '![A chart](https://example.com/chart.png)',
  ].join('\n'));
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<p[^>]*>Hi \*\|FNAME\|\*, this is <strong>bold<\/strong>, <em>soft<\/em> and <code[^>]*>code<\/code>\.\nSame paragraph\.<br>\nAfter a break\.<\/p>/);
  assert.match(html, /<ul[^>]*><li[^>]*>one<\/li><li[^>]*><a href="https:\/\/example\.com\/two"[^>]*>two<\/a><\/li><\/ul>/);
  assert.match(html, /<ol[^>]*><li[^>]*>first<\/li><li[^>]*>second<\/li><\/ol>/);
  assert.match(html, /<blockquote[^>]*><p[^>]*>quoted<\/p><\/blockquote>/);
  assert.match(html, /<hr[^>]*>/);
  assert.match(html, /<img src="https:\/\/example\.com\/chart\.png" alt="A chart"[^>]*>/);
});

test('Markdown: HTML is escaped and only http, https and mailto links survive', () => {
  const html = markdownToHtml('<script>alert(1)</script> [x](javascript:alert(1)) [y](mailto:a@example.com) "q" & <b>');
  assert.doesNotMatch(html, /<script>|<b>|javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /\[x\]\(javascript:alert\(1\)\)|x/);
  assert.match(html, /href="mailto:a@example\.com"/);
  assert.match(html, /&quot;q&quot; &amp;/);
});

test('a Markdown email has an unsubscribe and an archive link, and tracks only the content links', () => {
  const html = markdownToEmail('Read [this](https://example.com/a).', 'Subject <1>');
  assert.match(html, /href="\*\|UNSUB\|\*"/);
  assert.match(html, /href="\*\|ARCHIVE\|\*"/);
  assert.match(html, /<title>Subject &lt;1&gt;<\/title>/);
  assert.deepEqual(trackedLinks(html), ['https://example.com/a']);
});
