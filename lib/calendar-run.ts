import 'server-only';
import { addDays } from './dates';
import { toCalendarEvent } from './calendar';
import { CalendarAccessLost, SyncTokenExpired, type CalendarClient } from './google-api';
import type { CalendarRow } from './db';
import type { CalendarEvent } from './types';

/** Пять минут между фоновыми обновлениями одного календаря. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Всё, чем модуль ходит наружу, — параметром: тот же приём, что
 * в lib/report-run.ts. Порядок шагов проверяется без базы и без сети.
 */
export interface CalendarDeps {
  getCalendars(userId: string): Promise<CalendarRow[]>;
  saveSyncState(
    userId: string, calendarId: string,
    state: { syncToken: string | null; windowStart?: string; windowEnd?: string; brokenAt?: string | null },
  ): Promise<void>;
  upsertEvents(userId: string, events: CalendarEvent[]): Promise<void>;
  deleteEvents(userId: string, calendarId: string, eventIds: string[]): Promise<void>;
  clearCalendarEvents(userId: string, calendarId: string): Promise<void>;
  clientFor(userId: string): Promise<CalendarClient>;
  ownerEmail(userId: string): Promise<string>;
}

export function syncWindow(today: string): { from: string; to: string } {
  return {
    from: `${addDays(today, -31)}T00:00:00.000Z`,
    to: `${addDays(today, 91)}T00:00:00.000Z`,
  };
}

/**
 * Пора ли грузить заново целиком.
 *
 * Токена нет — очевидно. Но и окно надо двигать: `timeMin`/`timeMax` нельзя
 * передавать вместе с `syncToken`, значит окно зашито в токен с первой
 * загрузки, и единственный способ его сдвинуть — начать заново. Порог
 * в два месяца до края даёт запас: перелистнув вперёд, человек не упрётся
 * в пустоту раньше, чем окно переедет.
 */
export function needsFullSync(calendar: CalendarRow, today: string): boolean {
  if (calendar.syncToken === null || calendar.windowEnd === null) return true;
  return calendar.windowEnd < addDays(today, 60);
}

export async function syncCalendar(
  deps: CalendarDeps, userId: string, calendar: CalendarRow, today: string,
): Promise<void> {
  const client = await deps.clientFor(userId);
  const ownerEmail = await deps.ownerEmail(userId);
  const window = syncWindow(today);

  async function run(full: boolean): Promise<void> {
    if (full) await deps.clearCalendarEvents(userId, calendar.calendarId);

    let pageToken: string | undefined;
    let syncToken: string | null = null;

    do {
      const params = full
        ? { timeMin: window.from, timeMax: window.to, pageToken }
        : { syncToken: calendar.syncToken!, pageToken };
      const page = await client.listEvents(calendar.calendarId, params);

      const keep: CalendarEvent[] = [];
      const drop: string[] = [];
      for (const raw of page.events) {
        const event = toCalendarEvent(raw, calendar.calendarId, ownerEmail);
        // null — не «пропустить», а «убрать»: вчера показанное приглашение
        // могли отклонить, и оно обязано исчезнуть с экрана.
        if (event) keep.push(event); else drop.push(raw.id);
      }
      if (keep.length > 0) await deps.upsertEvents(userId, keep);
      if (drop.length > 0) await deps.deleteEvents(userId, calendar.calendarId, drop);

      pageToken = page.nextPageToken ?? undefined;
      syncToken = page.nextSyncToken ?? syncToken;
    } while (pageToken);

    await deps.saveSyncState(userId, calendar.calendarId, {
      syncToken,
      ...(full ? { windowStart: window.from.slice(0, 10), windowEnd: window.to.slice(0, 10) } : {}),
      brokenAt: null,
    });
  }

  try {
    await run(needsFullSync(calendar, today));
  } catch (error) {
    if (error instanceof SyncTokenExpired) {
      // Штатная ветка, а не отказ: Google так говорит «начни заново».
      // Без неё календарь однажды замрёт навсегда и молча.
      await run(true);
      return;
    }
    if (error instanceof CalendarAccessLost) {
      await deps.saveSyncState(userId, calendar.calendarId, {
        syncToken: calendar.syncToken, brokenAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

/** Синхронизировать выбранные календари владельца, которым пора. */
export async function syncUser(
  deps: CalendarDeps, userId: string, today: string, now: Date,
): Promise<number> {
  const calendars = await deps.getCalendars(userId);
  let done = 0;
  for (const calendar of calendars) {
    if (!calendar.selected) continue;
    // Сломанную связь не дёргаем каждые пять минут: доступ вернёт человек
    // кнопкой в настройках, а не наши повторы.
    if (calendar.brokenAt !== null) continue;
    if (calendar.syncedAt !== null
        && now.getTime() - new Date(calendar.syncedAt).getTime() < SYNC_INTERVAL_MS) continue;
    await syncCalendar(deps, userId, calendar, today);
    done += 1;
  }
  return done;
}
