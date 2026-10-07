import { Template } from './types';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The next time a schedule fires strictly after `after`, in local time, or undefined when it has no schedule.
 * Runs that were missed while the server was off are not replayed one by one: the schedule
 * fires once when it is next checked and then continues from there.
 */
export const nextRunTime = (template: Pick<Template, 'schedule' | 'weekday' | 'minuteOfDay'>, after: number) => {
  if (template.schedule === 'none') return undefined;

  const candidate = new Date(after);
  candidate.setHours(Math.floor(template.minuteOfDay / 60), template.minuteOfDay % 60, 0, 0);

  // At most a week ahead; setDate keeps the local time of day across clock changes
  for (let day = 0; day <= 7; day++) {
    const fits = template.schedule === 'daily' || candidate.getDay() === template.weekday;
    if (fits && candidate.getTime() > after) return candidate.getTime();
    candidate.setDate(candidate.getDate() + 1);
  }
  return undefined;
};

export const formatTimeOfDay = (minuteOfDay: number) =>
  `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;

/** e.g. "Every Monday at 09:00". */
export const describeSchedule = (template: Pick<Template, 'schedule' | 'weekday' | 'minuteOfDay'>) => {
  if (template.schedule === 'none') return 'Not scheduled';
  const time = formatTimeOfDay(template.minuteOfDay);
  return template.schedule === 'daily' ? `Every day at ${time}` : `Every ${WEEKDAYS[template.weekday]} at ${time}`;
};
