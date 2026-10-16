import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLostWork, findProjectProblems } from '../src/lib/consistency';

const page = (body: string, head = '<link rel="stylesheet" href="styles/main.css">') =>
  `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;

test('a finished multi-page site has no problems', () => {
  const nav = '<nav><a href="index.html">Home</a><a href="classes.html">Classes</a></nav>';
  assert.deepEqual(findProjectProblems({
    'index.html': page(nav + '<img src="img/logo.svg"><a href="https://example.com">x</a><a href="#top">top</a><a href="mailto:a@b.c">mail</a>'),
    'classes.html': page(nav),
    'styles/main.css': 'body { background: url("../img/logo.svg"); }',
    'img/logo.svg': '<svg/>',
  }), []);
});

test('pages that ignore the stylesheet, or that nothing links to, are reported (the four-page site)', () => {
  const problems = findProjectProblems({
    'home.html': page('<h1>Welcome</h1>', ''),
    'pricing.html': page('<h1>Pricing</h1>', ''),
    'styles/main.css': 'body {}',
  });
  assert.ok(problems.includes('home.html does not use any stylesheet, although the project has styles/main.css.'), problems.join('\n'));
  assert.ok(problems.includes('pricing.html does not use any stylesheet, although the project has styles/main.css.'));
  assert.ok(problems.includes('No page links to pricing.html, so visitors cannot reach it.'));
});

test('an inline style block counts as styling the page', () => {
  assert.deepEqual(findProjectProblems({ 'index.html': page('<p>hi</p>', '<style>p{}</style>'), 'other.css': '' }), []);
});

test('links, scripts, images and CSS urls to missing files are reported', () => {
  const problems = findProjectProblems({
    'index.html': page('<script src="app.js"></script><img src="hero.png"><a href="about.html">About</a>', '<link rel="stylesheet" href="css/site.css">'),
    'theme.css': 'h1 { background: url(images/bg.jpg) }',
  });
  for (const expected of [
    'index.html links to css/site.css, which is not in the project.',
    'index.html links to app.js, which is not in the project.',
    'index.html links to hero.png, which is not in the project.',
    'index.html links to about.html, which is not in the project.',
    'theme.css refers to images/bg.jpg, which is not in the project.',
  ]) assert.ok(problems.includes(expected), `${expected}\n---\n${problems.join('\n')}`);
});

test('JavaScript imports of missing files are reported, existing ones are not', () => {
  const problems = findProjectProblems({
    'src/main.js': "import { a } from './util.js';\nimport b from './missing';\nconst c = require('../lib/c');\nimport 'react';",
    'src/util.js': 'export const a = 1;',
    'lib/c.ts': 'export {}',
  });
  assert.deepEqual(problems, ['src/main.js imports ./missing, which is not in the project.']);
});

test("Python imports of functions a project module does not define are reported (the expense tracker)", () => {
  const problems = findProjectProblems({
    'main.py': 'import argparse\n\ndef main():\n    add_expense()\n\nCONFIG = 1\n',
    'tests/test_main.py': 'from main import main, add_expense, CONFIG\nfrom os import path\n',
  });
  assert.deepEqual(problems, ['tests/test_main.py imports add_expense from main.py, which does not define it.']);
});

test('a Python entry point placed above the functions it calls is reported (the expense tracker)', () => {
  const broken = 'import argparse\n\ndef main():\n    add_expense()\n\nif __name__ == "__main__":\n    main()\n\ndef add_expense():\n    pass\n\nclass Store:\n    pass\n';
  assert.deepEqual(findProjectProblems({ 'main.py': broken }), [
    'main.py runs its entry point (if __name__ == "__main__") before defining add_expense, Store, so running it fails; move that block to the end of the file.',
  ]);
  const fixed = 'def add_expense():\n    pass\n\ndef main():\n    add_expense()\n\nif __name__ == "__main__":\n    main()\n';
  assert.deepEqual(findProjectProblems({ 'main.py': fixed }), []);
});

test('the list stops at twenty problems', () => {
  const files: Record<string, string> = { 'index.html': page(Array.from({ length: 30 }, (_, i) => `<img src="missing-${i}.png">`).join('')) };
  files['styles/main.css'] = '';
  assert.equal(findProjectProblems(files).length, 20);
});

test('rewriting a file and dropping its functions is described, a careful edit is not', () => {
  const before = 'import json\n\ndef load(path):\n    pass\n\ndef add_expense(x):\n    pass\n\nclass Store:\n    pass\n';
  const after = 'import argparse\n\ndef main():\n    add_expense(1)\n';
  const note = describeLostWork('main.py', before, after);
  assert.match(note, /The previous version defined load, add_expense, Store, which this version no longer has\./);
  assert.equal(describeLostWork('main.py', before, before + '\ndef main():\n    pass\n'), '');
  assert.equal(describeLostWork('notes.md', 'a', 'b'), '');
});

test('JavaScript functions dropped in a rewrite are named, and a big shrink is mentioned', () => {
  const before = `export function render() {}\nexport const update = (x) => x;\nfunction helper() {}\n${'// padding\n'.repeat(60)}`;
  const note = describeLostWork('app.js', before, 'export function render() {}\n');
  assert.match(note, /defined update, helper/);
  assert.match(note, /went from \d+ lines to 2/);
});
