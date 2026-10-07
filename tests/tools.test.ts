import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit } from '../src/lib/edits';
import { htmlToText, isPublicAddress } from '../src/lib/netGuard';

test('edit replaces one passage and keeps the rest', () => {
  assert.equal(applyEdit('a = 1\nb = 2\n', 'b = 2', 'b = 3'), 'a = 1\nb = 3\n');
});

test('edit keeps dollar signs in the new text as they are', () => {
  assert.equal(applyEdit('price = X', 'X', '$1 and $&'), 'price = $1 and $&');
});

test('edit refuses a passage that is missing, and says when only the spacing differs', () => {
  assert.throws(() => applyEdit('def f():\n    return 1\n', 'return 2', 'x'), /not found.*Read the file again/);
  assert.throws(() => applyEdit('def f():\n    return 1\n', 'def f():\n  return 1', 'x'), /spacing or line breaks differ/);
});

test('edit refuses an ambiguous passage unless told to replace all', () => {
  assert.throws(() => applyEdit('x\nx\n', 'x', 'y'), /appears 2 times/);
  assert.equal(applyEdit('x\nx\n', 'x', 'y', true), 'y\ny\n');
});

test('edit refuses empty or unchanged input', () => {
  assert.throws(() => applyEdit('abc', '', 'x'), /old_text is empty/);
  assert.throws(() => applyEdit('abc', 'b', 'b'), /nothing would change/);
});

test('only public addresses may be fetched', () => {
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const address of [
    '127.0.0.1', '127.9.9.9', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '[::1]', '224.0.0.1', 'localhost', '999.1.1.1',
  ]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('172.32.0.1'), true);
  assert.equal(isPublicAddress('100.128.0.1'), true);
});

test('pages are reduced to their text', () => {
  const html = '<html><head><title>T</title><style>p{}</style></head><body><script>evil()</script><h1>Prices</h1><p>GPT &amp; co: &lt;$5&gt;</p><!-- hidden --></body></html>';
  assert.equal(htmlToText(html), 'Prices\nGPT & co: <$5>');
});
