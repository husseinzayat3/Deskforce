import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LAYOUT, MAP_SIZE, deskFor, sanitizeLayout } from '../src/lib/layout';

const person = (id: string, role: string) => ({ id, role });

test('employees sit at the desks of their role, in hiring order', () => {
  const team = [person('a', 'Tech Lead'), person('b', 'Junior Dev'), person('c', 'Tech Lead')];
  const leads = DEFAULT_LAYOUT.desks.filter(d => d.role === 'Tech Lead');
  assert.deepEqual(deskFor(team[0], team, DEFAULT_LAYOUT), leads[0]);
  assert.deepEqual(deskFor(team[2], team, DEFAULT_LAYOUT), leads[1]);
});

test('a role with no desks of its own shares the unmarked ones', () => {
  const team = [person('a', 'CEO'), person('q', 'QA'), person('w', 'Copywriter')];
  const open = DEFAULT_LAYOUT.desks.filter(d => !d.role);
  assert.deepEqual(deskFor(team[1], team, DEFAULT_LAYOUT), open[0]);
  assert.deepEqual(deskFor(team[2], team, DEFAULT_LAYOUT), open[1]);
});

test('more people than desks double up instead of having nowhere to sit', () => {
  const layout = { ...DEFAULT_LAYOUT, desks: [{ x: 10, y: 10, role: 'QA' }] };
  const team = [person('1', 'QA'), person('2', 'QA')];
  assert.deepEqual(deskFor(team[1], team, layout), layout.desks[0]);
  // With no unmarked desk at all, other roles use what there is
  assert.deepEqual(deskFor(person('x', 'CEO'), [person('x', 'CEO')], layout), layout.desks[0]);
});

test('a layout from outside is made safe', () => {
  const cleaned = sanitizeLayout({
    background: 'https://evil.example/map.png',
    desks: [{ x: -50, y: 5000, role: '  QA ' }, { x: 'abc', y: 20 }],
    rooms: { coffee: { x: 2000, y: 12.6 }, nonsense: { x: 1, y: 1 } },
    avatars: ['/api/media/avatar-1.png', 'javascript:alert(1)', '/avatars/robot.png', '/api/media/x.svg'],
  });
  assert.equal(cleaned.background, '');
  assert.deepEqual(cleaned.desks, [{ x: 0, y: MAP_SIZE, role: 'QA' }, { x: MAP_SIZE / 2, y: 20 }]);
  assert.deepEqual(cleaned.rooms.coffee, { x: MAP_SIZE, y: 13 });
  assert.deepEqual(cleaned.rooms.meeting, DEFAULT_LAYOUT.rooms.meeting);
  assert.equal('nonsense' in cleaned.rooms, false);
  assert.deepEqual(cleaned.avatars, ['/api/media/avatar-1.png', '/avatars/robot.png']);
  assert.deepEqual(sanitizeLayout(null).desks, DEFAULT_LAYOUT.desks);
});
