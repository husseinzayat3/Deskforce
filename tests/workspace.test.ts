import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The data folder is read when the module loads, so it is set first and the module loaded after
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
process.env.OFFICE_DATA_DIR = dataDir;
const load = () => import('../src/lib/server/workspace');

const projectsDir = path.join(dataDir, 'projects');
const outside = path.join(dataDir, 'secret.txt');
fs.writeFileSync(outside, 'keys');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** Paths a model might send to reach a file outside its project. */
const ESCAPES = ['../secret.txt', '../../secret.txt', 'a/../../secret.txt', 'a/b/../../../secret.txt', '..\\secret.txt', 'a\\..\\..\\secret.txt', '..', '.', '', '   '];

test('project names that could leave the projects folder are refused', async () => {
  const { safeProject, writeProjectFile, readProjectFile } = await load();
  for (const name of ['landing-page', 'a', 'app2']) assert.equal(safeProject(name), name);
  for (const name of ['..', '.', '', '../other', 'a/b', 'a\\b', '/etc', '-leading', 'Upper', 'with space', 'a'.repeat(62), null, 42, ['a']]) {
    assert.equal(safeProject(name), null, String(name));
  }
  assert.throws(() => writeProjectFile('../other', 'a.txt', 'x'), /Invalid project/);
  assert.throws(() => readProjectFile('..', 'secret.txt'), /Invalid project/);
});

test('files are written inside the project', async () => {
  const { writeProjectFile, readProjectFile } = await load();
  assert.equal(writeProjectFile('demo', 'src/app.js', 'let a = 1;'), path.join('src', 'app.js'));
  assert.equal(fs.readFileSync(path.join(projectsDir, 'demo', 'src', 'app.js'), 'utf-8'), 'let a = 1;\n');
  assert.equal(readProjectFile('demo', 'src/app.js')?.data.toString(), 'let a = 1;\n');
});

test('an absolute path is kept inside the project instead of followed', async () => {
  const { writeProjectFile } = await load();
  assert.equal(writeProjectFile('demo', '/etc/office-test.txt', 'x'), path.join('etc', 'office-test.txt'));
  assert.ok(fs.existsSync(path.join(projectsDir, 'demo', 'etc', 'office-test.txt')));
  assert.ok(!fs.existsSync('/etc/office-test.txt'));
});

test('writing outside the project is refused', async () => {
  const { writeProjectFile } = await load();
  for (const escape of ESCAPES) assert.throws(() => writeProjectFile('demo', escape, 'overwritten'), /Unsafe path/, JSON.stringify(escape));
  assert.equal(fs.readFileSync(outside, 'utf-8'), 'keys');
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['projects', 'secret.txt']);
});

test('reading outside the project finds nothing', async () => {
  const { readProjectFile, viewProjectFile } = await load();
  for (const escape of ESCAPES) {
    assert.equal(readProjectFile('demo', escape), null, JSON.stringify(escape));
    assert.equal(viewProjectFile('demo', escape), null, JSON.stringify(escape));
  }
});

test('deleting outside the project is refused', async () => {
  const { deleteProjectFile } = await load();
  for (const escape of ESCAPES) assert.throws(() => deleteProjectFile('demo', escape), /Unsafe path/, JSON.stringify(escape));
  assert.ok(fs.existsSync(outside));
  assert.equal(deleteProjectFile('demo', 'src/app.js'), true);
  assert.equal(deleteProjectFile('demo', 'src/app.js'), false);
});

test('one project cannot reach another', async () => {
  const { writeProjectFile, readProjectFile } = await load();
  writeProjectFile('other', 'notes.txt', 'private');
  assert.equal(readProjectFile('demo', '../other/notes.txt'), null);
  assert.throws(() => writeProjectFile('demo', '../other/notes.txt', 'changed'), /Unsafe path/);
  assert.equal(readProjectFile('other', 'notes.txt')?.data.toString(), 'private\n');
});

test('a symbolic link in a project is not followed out of it', async () => {
  const { writeProjectFile, readProjectFile, viewProjectFile, deleteProjectFile, listProjectFiles, readProjectContents } = await load();
  const project = path.join(projectsDir, 'linked');
  writeProjectFile('linked', 'real.txt', 'mine');
  const elsewhere = path.join(dataDir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'private.txt'), 'private');
  // What code run by the checks could leave behind
  fs.symlinkSync(outside, path.join(project, 'link.txt'));
  fs.symlinkSync(elsewhere, path.join(project, 'linkdir'));
  fs.symlinkSync(path.join(dataDir, 'not-there.txt'), path.join(project, 'dangling.txt'));

  for (const file of ['link.txt', 'linkdir/private.txt', 'dangling.txt']) {
    assert.equal(readProjectFile('linked', file), null, file);
    assert.equal(viewProjectFile('linked', file), null, file);
    assert.throws(() => writeProjectFile('linked', file, 'overwritten'), /Unsafe path/, file);
    assert.throws(() => deleteProjectFile('linked', file), /Unsafe path/, file);
  }
  assert.throws(() => writeProjectFile('linked', 'linkdir/new.txt', 'x'), /Unsafe path/);

  assert.equal(fs.readFileSync(outside, 'utf-8'), 'keys');
  assert.deepEqual(fs.readdirSync(elsewhere), ['private.txt']);
  assert.ok(!fs.existsSync(path.join(dataDir, 'not-there.txt')));

  // Links are not listed, so their contents never reach a model or the search
  assert.deepEqual(listProjectFiles('linked'), ['real.txt']);
  assert.deepEqual(readProjectContents('linked'), { 'real.txt': 'mine\n' });
});

test('a link that stays inside the project still works', async () => {
  const { writeProjectFile, readProjectFile } = await load();
  fs.symlinkSync(path.join(projectsDir, 'linked', 'real.txt'), path.join(projectsDir, 'linked', 'alias.txt'));
  assert.equal(readProjectFile('linked', 'alias.txt')?.data.toString(), 'mine\n');
  writeProjectFile('linked', 'alias.txt', 'changed');
  assert.equal(readProjectFile('linked', 'real.txt')?.data.toString(), 'changed\n');
});
