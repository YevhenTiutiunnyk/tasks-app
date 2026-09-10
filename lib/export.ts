import { createHash } from 'node:crypto';
import { addDays } from './dates';
import type { Task } from './types';

/**
 * Окно выгрузки: неделя назад, месяц вперёд.
 *
 * Календарь нужен про ближайшее — что сегодня, что на неделе, что скоро.
 * Окно шире не берём сознательно: повторы выгружаются отдельными
 * событиями на каждое вхождение, и ежедневная привычка за три месяца
 * превратилась бы в сотню записей в чужом календаре.
 */
export function exportWindow(today: string): { from: string; to: string } {
  return { from: addDays(today, -7), to: addDays(today, 30) };
}

/**
 * Что вообще уезжает в Google: только дела с днём и часом.
 *
 * У недельных и месячных дел дня нет по замыслу — их дата это якорь
 * периода, и событие на неё соврало бы. Дела на весь день событием
 * тоже не описываются: у них нет времени, а полоса «весь день» в чужом
 * календаре быстро превращается в свалку.
 */
export function exportableTasks(tasks: Task[]): Task[] {
  return tasks.filter(
    (task) => task.horizon === 'day' && !task.allDay && task.startMinute !== null,
  );
}

/**
 * Название события. Галочка выводится из `done` здесь и нигде не хранится:
 * иначе снятие отметки оставило бы её в названии навсегда, а однажды она
 * просочилась бы в название самой задачи.
 */
export function eventTitle(task: Task): string {
  return task.done ? `✓ ${task.title}` : task.title;
}

/**
 * Отпечаток выгруженного состояния.
 *
 * В него входят ровно те поля, которые уезжают в событие, и ни одного
 * лишнего: попади сюда категория — смена цвета в приложении гнала бы
 * в Google правку, которая там ничего не меняет.
 *
 * Хранится свёртка, а не сами поля: иначе таблица связок стала бы второй
 * копией расписания, которую надо держать в соответствии с первой.
 */
export function fingerprintOf(task: Task): string {
  const parts = [
    eventTitle(task),
    task.date,
    String(task.startMinute),
    String(task.durationMinutes),
  ];
  return createHash('sha256').update(parts.join(' ')).digest('hex');
}
