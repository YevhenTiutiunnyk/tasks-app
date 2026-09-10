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

/** Встречи, целиком выпавшие за края видимого диапазона сетки. */
export interface HiddenEvents {
  before: EventDay[];
  after: EventDay[];
}

/**
 * Какие встречи не поместились в показанный диапазон часов.
 *
 * Нужна, чтобы сетка могла честно сказать «есть встречи выше» вместо того,
 * чтобы растягиваться на все сутки из-за одного ночного перелёта. Растяжение
 * честно, но дорого: девять часов пустой ночи ради полутора часов дела.
 *
 * Считается только то, что не видно СОВСЕМ. Встреча, задевающая край хотя бы
 * краем, на экране присутствует, и объявлять её скрытой значило бы звать
 * человека раскрывать то, что он и так видит.
 *
 * Дела на весь день сюда не попадают никогда: они живут в своей полосе над
 * сеткой и от диапазона часов не зависят.
 */
export function eventsOutsideRange(
  events: EventDay[],
  firstHour: number,
  lastHour: number,
): HiddenEvents {
  const from = firstHour * 60;
  const to = lastHour * 60;
  const hidden: HiddenEvents = { before: [], after: [] };

  for (const event of events) {
    if (event.allDay || event.startMinute === null) continue;
    const start = event.startMinute;
    const end = start + (event.durationMinutes ?? DEFAULT_DURATION_MINUTES);
    if (end <= from) hidden.before.push(event);
    else if (start >= to) hidden.after.push(event);
  }

  return hidden;
}
