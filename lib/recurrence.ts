import { eachDay, weekdayOf } from './dates';
import type { Recurrence, RecurrenceException, Task } from './types';

const PREFIX = 'occ:';

export function occurrenceId(recurrenceId: string, date: string): string {
  return `${PREFIX}${recurrenceId}:${date}`;
}

export function parseOccurrenceId(id: string): { recurrenceId: string; date: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const split = rest.lastIndexOf(':');
  if (split <= 0) return null;
  return { recurrenceId: rest.slice(0, split), date: rest.slice(split + 1) };
}

/**
 * Раскрывает правила повтора в конкретные вхождения на отрезке дат.
 * Чистая функция: в базу не ходит, времени не читает.
 */
export function expandRecurrences(
  recurrences: Recurrence[],
  exceptions: RecurrenceException[],
  from: string,
  to: string,
): Task[] {
  const skipped = new Set(exceptions.map((e) => `${e.recurrenceId}:${e.date}`));
  const days = eachDay(from, to);
  const result: Task[] = [];

  for (const rec of recurrences) {
    const weekdays = new Set(rec.weekdays);
    for (const date of days) {
      if (date < rec.startsOn) continue;
      if (rec.endsOn && date > rec.endsOn) continue;
      if (!weekdays.has(weekdayOf(date))) continue;
      if (skipped.has(`${rec.id}:${date}`)) continue;

      result.push({
        id: occurrenceId(rec.id, date),
        title: rec.title,
        date,
        startMinute: rec.startMinute,
        durationMinutes: rec.durationMinutes,
        allDay: rec.allDay,
        categoryId: rec.categoryId,
        done: false,
        // Правило повтора описывается днями недели, то есть по определению
        // дневное. Недельных и месячных повторов не бывает, и поле здесь
        // не выбор, а константа.
        horizon: 'day' as const,
        recurrenceId: rec.id,
        recurrenceDate: date,
      });
    }
  }

  return result;
}
