import type { EventDay, Settings, Task } from './types';

/** Час, к которому относится задача без явной длительности. */
const DEFAULT_DURATION_MINUTES = 60;

/**
 * Диапазон часов, который показывает недельная сетка: рабочий день, расширенный
 * на два часа в обе стороны, а затем растянутый так, чтобы вместить самое раннее
 * и самое позднее дело недели. Без этого растяжения дело вне рабочих часов
 * получало бы отступ за пределами сетки и рисовалось поверх соседей.
 *
 * Встречи из календаря растягивают диапазон наравне с задачами, и это не
 * косметика. Пока считались только задачи, встреча вне рабочих часов —
 * планёрка в восемь утра, кусок ночного перелёта после полуночи — оказывалась
 * выше первой нарисованной строки и не показывалась вовсе. В ленте дня
 * на телефоне она при этом видна, то есть два экрана расходились в том, что
 * вообще существует, и человеку неоткуда было узнать, что от него что-то
 * скрыли. Растянутая сетка неудобна; невидимая встреча — обман.
 */
export function visibleHourRange(
  tasks: Task[],
  settings: Settings,
  events: EventDay[] = [],
): { firstHour: number; lastHour: number } {
  let firstHour = Math.max(0, Math.floor(settings.workStartMinute / 60) - 2);
  let lastHour = Math.min(24, Math.ceil(settings.workEndMinute / 60) + 2);

  for (const item of [...tasks, ...events]) {
    if (item.allDay || item.startMinute === null) continue;
    const start = item.startMinute;
    const end = start + (item.durationMinutes ?? DEFAULT_DURATION_MINUTES);
    firstHour = Math.min(firstHour, Math.max(0, Math.floor(start / 60)));
    lastHour = Math.max(lastHour, Math.min(24, Math.ceil(end / 60)));
  }

  return { firstHour, lastHour };
}
