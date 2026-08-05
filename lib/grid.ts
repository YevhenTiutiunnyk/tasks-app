import type { Settings, Task } from './types';

/** Час, к которому относится задача без явной длительности. */
const DEFAULT_DURATION_MINUTES = 60;

/**
 * Диапазон часов, который показывает недельная сетка: рабочий день, расширенный
 * на два часа в обе стороны, а затем растянутый так, чтобы вместить самую раннюю
 * и самую позднюю задачу недели. Без этого растяжения задача вне рабочих часов
 * получала бы отступ за пределами сетки и рисовалась поверх соседей.
 */
export function visibleHourRange(
  tasks: Task[],
  settings: Settings,
): { firstHour: number; lastHour: number } {
  let firstHour = Math.max(0, Math.floor(settings.workStartMinute / 60) - 2);
  let lastHour = Math.min(24, Math.ceil(settings.workEndMinute / 60) + 2);

  for (const task of tasks) {
    if (task.allDay || task.startMinute === null) continue;
    const start = task.startMinute;
    const end = start + (task.durationMinutes ?? DEFAULT_DURATION_MINUTES);
    firstHour = Math.min(firstHour, Math.max(0, Math.floor(start / 60)));
    lastHour = Math.max(lastHour, Math.min(24, Math.ceil(end / 60)));
  }

  return { firstHour, lastHour };
}
