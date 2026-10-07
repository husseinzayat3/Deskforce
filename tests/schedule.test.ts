import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSchedule, nextRunTime } from '../src/lib/schedule';

// Wednesday 7 October 2026, 10:00 local time
const now = new Date(2026, 9, 7, 10, 0, 0).getTime();
const at = (time: number | undefined) => new Date(time!);

test('no schedule, no next run', () => {
  assert.equal(nextRunTime({ schedule: 'none', weekday: 1, minuteOfDay: 540 }, now), undefined);
});

test('daily: later today, or tomorrow when the time has passed', () => {
  assert.deepEqual(at(nextRunTime({ schedule: 'daily', weekday: 0, minuteOfDay: 11 * 60 }, now)), new Date(2026, 9, 7, 11, 0));
  assert.deepEqual(at(nextRunTime({ schedule: 'daily', weekday: 0, minuteOfDay: 9 * 60 }, now)), new Date(2026, 9, 8, 9, 0));
  // Exactly now is not "after now"
  assert.deepEqual(at(nextRunTime({ schedule: 'daily', weekday: 0, minuteOfDay: 10 * 60 }, now)), new Date(2026, 9, 8, 10, 0));
});

test('weekly: the next such weekday', () => {
  assert.deepEqual(at(nextRunTime({ schedule: 'weekly', weekday: 1, minuteOfDay: 540 }, now)), new Date(2026, 9, 12, 9, 0));
  assert.deepEqual(at(nextRunTime({ schedule: 'weekly', weekday: 3, minuteOfDay: 9 * 60 }, now)), new Date(2026, 9, 14, 9, 0));
  assert.deepEqual(at(nextRunTime({ schedule: 'weekly', weekday: 3, minuteOfDay: 15 * 60 }, now)), new Date(2026, 9, 7, 15, 0));
});

test('schedules read naturally', () => {
  assert.equal(describeSchedule({ schedule: 'weekly', weekday: 1, minuteOfDay: 545 }), 'Every Monday at 09:05');
  assert.equal(describeSchedule({ schedule: 'none', weekday: 1, minuteOfDay: 0 }), 'Not scheduled');
});
