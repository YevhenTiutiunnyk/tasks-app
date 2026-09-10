import 'server-only';
import {
  getCalendars, getExceptions, getEventsBetween, getRecurrences, getSettings, getTasksBetween,
  getTimezone, hasUserKey,
} from './db';
import { splitIntoDays } from './calendar';
import { copyWindow } from './calendar-run';
import { expandRecurrences } from './recurrence';
import { addDays, weekRange } from './dates';
import type { EventDay, Settings, Task } from './types';

export interface WeekData {
  from: string;
  to: string;
  tasks: Task[];
  /** Встречи Google, уже разложенные по локальным дням недели. Только читаются. */
  events: EventDay[];
  /**
   * Границы окна копии календаря (пересечение среди выбранных календарей),
   * либо null — календарь не подключён вовсе, либо ещё не прошёл первую
   * синхронизацию. Клиент показывает по ним приглушённую строку, когда
   * видимая неделя выходит за окно: за его пределами встреч в копии
   * точно нет, и это должно быть видно на экране, а не выглядеть как
   * «встреч не нашлось» (находка I5 финального ревью).
   */
  calendarWindow: { start: string; end: string } | null;
  settings: Settings;
  /**
   * Признак «строка ключа есть и шифротекст заполнен», а НЕ «ключ пригоден».
   *
   * Проверять пригодность значило бы расшифровывать ключ на каждой загрузке
   * недели: открытый текст материализовался бы в памяти при каждом открытии
   * расписания ради одного флажка. Непригодный ключ вскроется в роуте разбора
   * ответом key_unreadable — там он и объясняется.
   */
  hasKey: boolean;
}

export async function loadRange(userId: string, from: string, to: string): Promise<Task[]> {
  const [stored, recurrences, exceptions] = await Promise.all([
    getTasksBetween(userId, from, to),
    getRecurrences(userId),
    getExceptions(userId),
  ]);
  // Материализованные вхождения уже лежат в stored, а на их даты стоят исключения,
  // поэтому раскрытие их не продублирует.
  return [...stored, ...expandRecurrences(recurrences, exceptions, from, to)].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.allDay === b.allDay ? (a.startMinute ?? 0) - (b.startMinute ?? 0) : a.allDay ? -1 : 1),
  );
}

export async function loadWeek(userId: string, anchor: string): Promise<WeekData> {
  const { from, to } = weekRange(anchor);
  // Границы — абсолютные моменты краёв недели в поясе владельца, поэтому берём
  // сутки с запасом с каждой стороны и режем раскладкой: встреча, начавшаяся
  // в 23:30 по местному времени последнего дня недели, в UTC приходится уже
  // на следующие сутки и без запаса не попала бы в выборку вовсе.
  const [tasks, settings, hasKey, timezone, events, calendars] = await Promise.all([
    loadRange(userId, from, to),
    getSettings(userId),
    hasUserKey(userId),
    getTimezone(userId),
    getEventsBetween(userId, `${addDays(from, -1)}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`),
    getCalendars(userId),
  ]);
  return {
    from, to, tasks, events: splitIntoDays(events, timezone, from, to),
    calendarWindow: copyWindow(calendars), settings, hasKey,
  };
}
