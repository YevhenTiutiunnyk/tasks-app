import 'server-only';
import { getExceptions, getRecurrences, getSettings, getTasksBetween } from './db';
import { expandRecurrences } from './recurrence';
import { weekRange } from './dates';
import type { Settings, Task } from './types';

export interface WeekData {
  from: string;
  to: string;
  tasks: Task[];
  settings: Settings;
}

export async function loadRange(from: string, to: string): Promise<Task[]> {
  const [stored, recurrences, exceptions] = await Promise.all([
    getTasksBetween(from, to),
    getRecurrences(),
    getExceptions(),
  ]);
  // Материализованные вхождения уже лежат в stored, а на их даты стоят исключения,
  // поэтому раскрытие их не продублирует.
  return [...stored, ...expandRecurrences(recurrences, exceptions, from, to)].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.allDay === b.allDay ? (a.startMinute ?? 0) - (b.startMinute ?? 0) : a.allDay ? -1 : 1),
  );
}

export async function loadWeek(anchor: string): Promise<WeekData> {
  const { from, to } = weekRange(anchor);
  const [tasks, settings] = await Promise.all([loadRange(from, to), getSettings()]);
  return { from, to, tasks, settings };
}
