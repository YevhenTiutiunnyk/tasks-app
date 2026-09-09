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
    // После guard'а выше startMinute гарантированно число, но ?? 0 пишем
    // явно, а не полагаемся на неявное приведение null к 0 в арифметике:
    // на этом приведении тест чуть не проглядел снятый guard (ревью
    // задачи 11, Important-2) — оно молча даёт «правдоподобное» число
    // вместо NaN, и мутация осталась бы незамеченной.
    const taskStart = task.startMinute ?? 0;
    const taskEnd = taskStart + (task.durationMinutes ?? 60);

    for (const event of events) {
      if (event.allDay || event.startMinute === null) continue;
      if (event.date !== task.date) continue;
      const eventStart = event.startMinute ?? 0;
      const eventEnd = eventStart + (event.durationMinutes ?? 60);
      // Строгие неравенства: встреча в 11:00 после задачи, кончающейся
      // в 11:00, — это плотный день, а не ошибка.
      if (taskStart < eventEnd && eventStart < taskEnd) {
        result.push({ taskTitle: task.title, eventTitle: event.title });
      }
    }
  }

  return result;
}
