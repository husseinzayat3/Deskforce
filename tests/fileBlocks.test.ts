import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileBlocks } from '../src/lib/fileBlocks';

test('reads properly closed blocks', () => {
  const { files, unclosed } = parseFileBlocks('Intro\n[FILE: a.txt]\nA\n[/FILE]\ntext\n[FILE: lib/b.py]\nB1\nB2\n[/FILE]\n[SUMMARY] done [/SUMMARY]');
  assert.deepEqual(files, [{ path: 'a.txt', content: 'A' }, { path: 'lib/b.py', content: 'B1\nB2' }]);
  assert.deepEqual(unclosed, []);
});

test('a block with no closing tag ends at the next file', () => {
  const { files, unclosed } = parseFileBlocks('[FILE: a.py]\nA\n[FILE: b.py]\nB\n[FILE: c.py]\nC\n[/FILE]');
  assert.deepEqual(files.map(f => [f.path, f.content]), [['a.py', 'A'], ['b.py', 'B'], ['c.py', 'C']]);
  assert.deepEqual(unclosed, []);
});

test('a block with no closing tag ends at the summary or an assignment', () => {
  assert.deepEqual(parseFileBlocks('[FILE: a.py]\nA\n[SUMMARY] s [/SUMMARY]').files, [{ path: 'a.py', content: 'A' }]);
  assert.deepEqual(parseFileBlocks('[FILE: a.py]\nA\n[ASSIGN: x1 | T] do [/ASSIGN]').files, [{ path: 'a.py', content: 'A' }]);
});

test('a last block with no closing tag is kept when the response was complete', () => {
  assert.deepEqual(parseFileBlocks('[FILE: a.py]\nprint(1)\n').files, [{ path: 'a.py', content: 'print(1)' }]);
});

test('a last block cut off by the length limit is reported, not saved', () => {
  const { files, unclosed } = parseFileBlocks('[FILE: a.py]\nA\n[/FILE]\n[FILE: b.py]\ndef half(', true);
  assert.deepEqual(files, [{ path: 'a.py', content: 'A' }]);
  assert.deepEqual(unclosed, ['b.py']);
});

test('code that contains square brackets is left alone', () => {
  const content = 'items = [1, 2]\nprint(items[0])  # [not a tag]';
  assert.deepEqual(parseFileBlocks(`[FILE: a.py]\n${content}\n[/FILE]`).files, [{ path: 'a.py', content }]);
});
