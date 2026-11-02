import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments, trackedLinks, render, toText } from '../src/render.ts';

const issue20 = readFileSync(new URL('./fixtures/issue-20-the-source.html', import.meta.url), 'utf8');

const urls = {
  unsubscribeUrl: 'https://news.example/u/abc',
  archiveUrl: 'https://news.example/a/the-source-20',
};

test('strips internal comments but keeps Outlook conditionals', () => {
  const html = '<!-- TODO before send --><html><!--[if mso]><table><![endif]--><p>Hi</p><!-- note --></html>';
  assert.equal(stripComments(html), '<html><!--[if mso]><table><![endif]--><p>Hi</p></html>');
});

test('the comment at the top of #20 is gone, and with it the merge tags it lists', () => {
  const html = stripComments(issue20);
  assert.ok(html.trimStart().startsWith('<!DOCTYPE html>'));
  assert.equal(html.match(/\*\|FNAME\|\*/g)?.length, 1);
});

test('finds each http link once, in order, and leaves out merge tags and mailto', () => {
  const html = `<a href="https://a.example/x?y=1&amp;z=2">A</a> <a href="mailto:info@sourceful.energy">M</a>
    <a href="*|UNSUB|*">U</a> <a class="b" href="https://b.example">B</a> <a href="https://a.example/x?y=1&amp;z=2">A again</a>
    <a href="#top">T</a>`;
  assert.deepEqual(trackedLinks(html), ['https://a.example/x?y=1&z=2', 'https://b.example']);
});

test('#20 has nine distinct links, and the font stylesheets are not among them', () => {
  const links = trackedLinks(stripComments(issue20));
  assert.equal(links.length, 9);
  assert.ok(links.includes('https://ftw.sourceful.energy'));
  assert.ok(!links.some(l => l.includes('fonts')));
});

test('fills in the first name, escaped', () => {
  const out = render('<p>Hi *|FNAME|*,</p>', { firstName: '<b>Åsa</b>', fallback: 'there', ...urls });
  assert.equal(out, '<p>Hi &lt;b&gt;Åsa&lt;/b&gt;,</p>');
});

test('uses the fallback when there is no first name', () => {
  assert.equal(render('Hi *|FNAME|*,', { firstName: '  ', fallback: 'there', ...urls }), 'Hi there,');
  assert.equal(render('Hi *|FNAME|*,', { firstName: null, fallback: 'there', ...urls }), 'Hi there,');
});

test('puts in the unsubscribe and archive links', () => {
  const out = render('<a href="*|UNSUB|*">Unsubscribe</a> <a href="*|ARCHIVE|*">Web</a>', { firstName: 'A', fallback: 'x', ...urls });
  assert.equal(out, '<a href="https://news.example/u/abc">Unsubscribe</a> <a href="https://news.example/a/the-source-20">Web</a>');
});

test('routes tracked links through the click URL and adds the open pixel', () => {
  const html = '<html><body><a href="https://a.example">A</a><a href="*|UNSUB|*">U</a></body></html>';
  const out = render(html, {
    firstName: 'A', fallback: 'x', ...urls,
    links: ['https://a.example'],
    clickUrl: n => `https://news.example/c/abc/${n}`,
    openUrl: 'https://news.example/o/abc.gif',
  });
  assert.match(out, /<a href="https:\/\/news\.example\/c\/abc\/0">A<\/a>/);
  assert.match(out, /<a href="https:\/\/news\.example\/u\/abc">U<\/a>/);
  assert.match(out, /<img src="https:\/\/news\.example\/o\/abc\.gif" width="1" height="1" alt=""[^>]*><\/body>/);
});

test('a rendered #20 has no merge tags left and every link tracked', () => {
  const html = stripComments(issue20);
  const links = trackedLinks(html);
  const out = render(html, {
    firstName: 'Fredrik', fallback: 'there', ...urls, links,
    clickUrl: n => `https://news.example/c/abc/${n}`, openUrl: 'https://news.example/o/abc.gif',
  });
  assert.doesNotMatch(out, /\*\|[A-Z_]+\|\*/);
  assert.match(out, /Hi Fredrik,/);
  assert.deepEqual(trackedLinks(out).filter(l => !l.startsWith('https://news.example/')), []);
});

test('the text part reads as text and keeps the links', () => {
  const html = '<html><head><style>p{}</style><title>T</title></head><body><p>Hi&nbsp;Fredrik &mdash; <a href="https://a.example">read&nbsp;this</a></p><p>Next&rsquo;s here.</p></body></html>';
  assert.equal(toText(html), 'Hi Fredrik — read this (https://a.example)\n\nNext’s here.');
});

test('keeps the "not Outlook" conditional, so its content reaches every other reader', () => {
  const html = '<!--[if !mso]><!--><p>Everyone else</p><!--<![endif]--><!-- note --><!--[if mso]><p>Outlook</p><![endif]-->';
  assert.equal(stripComments(html), '<!--[if !mso]><!--><p>Everyone else</p><!--<![endif]--><!--[if mso]><p>Outlook</p><![endif]-->');
});
