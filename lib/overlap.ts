import type { EventDay, Task } from './types';

/**
 * Задачи, севшие поверх встреч.
 *
 * Считается ПОСЛЕ применения операций, а не до: приложение не спрашивает
 * разрешения, оно применяет и даёт откатить. Предупреждение — это отчёт
 * о том, что вышло, а не согласование.
 *
 * Дела на весь день не участвуют: у них нет часа, и «наложение» с ними
 * означало бы, что весь день занят.
 */
export function findOverlaps(
  tasks: Task[], events: EventDay[],
): { taskTitle: string; eventTitle: string }[] {
  const result: { taskTitle: string; eventTitle: string }[] = [];

  for (const task of tasks) {
    if (task.allDay || task.startMinute === null) continue;
    const taskEnd = task.startMinute + (task.durationMinutes ?? 60);

    for (const event of events) {
      if (event.allDay || event.startMinute === null) continue;
      if (event.date !== task.date) continue;
      const eventEnd = event.startMinute + (event.durationMinutes ?? 60);
      // Строгие неравенства: встреча в 11:00 после задачи, кончающейся
      // в 11:00, — это плотный день, а не ошибка.
      if (task.startMinute < eventEnd && event.startMinute < taskEnd) {
        result.push({ taskTitle: task.title, eventTitle: event.title });
      }
    }
  }

  return result;
}
