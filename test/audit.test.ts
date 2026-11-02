import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/audit.ts';

test('redact blanks addresses anywhere in a summary, also right before a quote', () => {
  const out = redact({ subject: 'Say "hi foo@example.net"', to: ['a@example.com', 'x'], 'b@example.com': 1, n: 2, nested: { note: "it's c@example.org's" } });
  assert.deepEqual(out, { subject: 'Say "hi [address]"', to: ['[address]', 'x'], '[address]': 1, n: 2, nested: { note: "it's [address]'s" } });
});
