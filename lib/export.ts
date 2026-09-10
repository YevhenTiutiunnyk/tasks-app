import { createHash } from 'node:crypto';
import { addDays } from './dates';
import type { Task } from './types';
import type { ExportLink } from './db';

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

export interface ExportDiff {
  create: Task[];
  update: { task: Task; eventId: string }[];
  remove: ExportLink[];
}

/**
 * Что надо сделать в Google, чтобы календарь совпал с задачами.
 *
 * Чистая функция и сердце всей ступени: сверщик не знает, что именно
 * поменялось, он каждый раз спрашивает «что должно быть» и «что выгружено»
 * и берёт разницу. Поэтому его нельзя забыть научить — в отличие от
 * восьми мест, где задача меняется.
 *
 * Ключ связки — это `task.id`, а у вхождения повтора он синтетический
 * (`occ:<правило>:<дата>`). Отдельного пространства ключей не заводим:
 * тем же ключом пользуются напоминания и снимок недельного отчёта.
 */
export function diffExport(tasks: Task[], links: ExportLink[]): ExportDiff {
  const byKey = new Map(links.map((link) => [link.taskKey, link]));
  const diff: ExportDiff = { create: [], update: [], remove: [] };

  for (const task of tasks) {
    const link = byKey.get(task.id);
    if (!link) {
      diff.create.push(task);
      continue;
    }
    byKey.delete(task.id);
    if (link.fingerprint !== fingerprintOf(task)) {
      diff.update.push({ task, eventId: link.eventId });
    }
  }

  // Осталось в карте — то, чему в календаре больше не место: задачу
  // удалили, либо она уехала за пределы окна.
  diff.remove.push(...byKey.values());

  return diff;
}

const MINUTES_PER_DAY = 1440;
const DEFAULT_DURATION_MINUTES = 60;

export interface EventDraft {
  summary: string;
  startDate: string;
  startMinute: number;
  endDate: string;
  endMinute: number;
  timeZone: string;
  taskKey: string;
}

/**
 * Задача в том виде, в каком её примет Google.
 *
 * Абсолютное время не считаем: Google принимает стенные часы и отдельно
 * имя пояса, а перевод делает сам. Правило проекта «дата строкой, время
 * минутами, никаких Date» остаётся в силе, и переход на летнее время
 * считает тот, у кого для этого есть база поясов.
 */
export function draftFor(task: Task, timeZone: string): EventDraft {
  const startMinute = task.startMinute!;
  const end = startMinute + (task.durationMinutes ?? DEFAULT_DURATION_MINUTES);
  // Задача может кончаться за полночь. Без переноса даты Google получил бы
  // конец раньше начала и отказал бы.
  const overnight = end >= MINUTES_PER_DAY;

  return {
    summary: eventTitle(task),
    startDate: task.date,
    startMinute,
    endDate: overnight ? addDays(task.date, 1) : task.date,
    endMinute: overnight ? end - MINUTES_PER_DAY : end,
    timeZone,
    taskKey: task.id,
  };
}
