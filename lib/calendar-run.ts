import 'server-only';
import { addDays } from './dates';
import { toCalendarEvent } from './calendar';
import { CalendarAccessLost, SyncTokenExpired, type CalendarClient } from './google-api';
import type { CalendarRow } from './db';
import type { CalendarEvent } from './types';

/** Пять минут между фоновыми обновлениями одного календаря. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Запас страниц на один обход. Google обязан останавливаться сам, но
 * ошибка на его стороне или в моке теста не должна съесть весь запуск
 * планировщика вместе со всеми остальными владельцами — у обхода обязан
 * быть потолок, даже когда каждый следующий pageToken не похож на прошлый.
 */
const MAX_PAGES = 100;

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
  /**
   * Замена копии календаря целиком, одной операцией. Используется только
   * полной перезагрузкой — см. комментарий у одноимённой функции в lib/db.ts:
   * старая копия обязана дожить до момента, когда все страницы уже дочитаны,
   * а не исчезать в начале обхода.
   */
  replaceCalendarEvents(userId: string, calendarId: string, events: CalendarEvent[]): Promise<void>;
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

  /**
   * Один сквозной обход всех страниц — без замены копии посередине.
   *
   * При полной перезагрузке события копятся в памяти (`fullKeep`) и уходят
   * в `replaceCalendarEvents` одной операцией только после того, как обход
   * дочитан до конца: четыре месяца встреч одного человека — сотни строк,
   * память не проблема, а частичная замена по ходу дела вернула бы ту же
   * дыру, что и старое «сначала очистить», просто короче. Инкрементальная
   * ветка, наоборот, пишет постранично — там нет старой копии, которую можно
   * было бы стереть раньше времени.
   */
  async function run(full: boolean): Promise<void> {
    let pageToken: string | undefined;
    let syncToken: string | null = null;
    const fullKeep: CalendarEvent[] = [];
    let pages = 0;

    do {
      pages += 1;
      // Предохранитель от вечного цикла, когда pageToken меняется каждый раз,
      // но обход всё равно не кончается: без потолка это съело бы весь запуск
      // планировщика вместе с остальными владельцами.
      if (pages > MAX_PAGES) {
        throw new Error('Обход событий календаря не остановился в разумное число страниц');
      }

      const requestedPageToken = pageToken;
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

      if (full) {
        fullKeep.push(...keep);
      } else {
        if (keep.length > 0) await deps.upsertEvents(userId, keep);
        if (drop.length > 0) await deps.deleteEvents(userId, calendar.calendarId, drop);
      }

      pageToken = page.nextPageToken ?? undefined;
      syncToken = page.nextSyncToken ?? syncToken;
      // Тот же токен второй раз подряд — Google не продвигается по страницам.
      // Без этой проверки обход крутился бы вечно вместо того, чтобы дойти
      // до потолка выше или (что то же самое, но медленнее) съесть его весь.
      if (pageToken !== undefined && pageToken === requestedPageToken) break;
    } while (pageToken);

    if (full) {
      await deps.replaceCalendarEvents(userId, calendar.calendarId, fullKeep);
    }

    await deps.saveSyncState(userId, calendar.calendarId, {
      syncToken,
      ...(full ? { windowStart: window.from.slice(0, 10), windowEnd: window.to.slice(0, 10) } : {}),
      brokenAt: null,
    });
  }

  async function markBroken(): Promise<void> {
    await deps.saveSyncState(userId, calendar.calendarId, {
      syncToken: calendar.syncToken, brokenAt: new Date().toISOString(),
    });
  }

  const full = needsFullSync(calendar, today);
  try {
    await run(full);
  } catch (error) {
    if (!full && error instanceof SyncTokenExpired) {
      // Штатная ветка, а не отказ: Google так говорит «начни заново».
      // Без неё календарь однажды замрёт навсегда и молча.
      //
      // Повторная попытка — в собственном try/catch, а не внутри того же
      // блока, что её запустил: иначе отказ второй попытки (например,
      // CalendarAccessLost сразу после 410) улетал бы мимо обработки, и
      // связь никогда не помечалась бы сломанной — цикл «410 → перезагрузка
      // → отказ» повторялся бы каждые пять минут вечно.
      try {
        await run(true);
      } catch (retryError) {
        if (retryError instanceof CalendarAccessLost) await markBroken();
        throw retryError;
      }
      return;
    }
    if (error instanceof CalendarAccessLost) await markBroken();
    throw error;
  }
}

/**
 * Синхронизировать выбранные календари владельца, которым пора.
 *
 * Сбой одного календаря не должен останавливать остальные: без try/catch
 * вокруг каждого вызова транзиентная ошибка на первом календаре означала бы,
 * что второй и третий не синхронизируются никогда — каждый следующий запуск
 * планировщика падал бы на том же первом. Ничего не логируем: в этом
 * проекте lib/ в лог не пишет, а сообщение об ошибке могло бы принести
 * название встречи или адрес владельца. Вызывающий роут получит `failed`
 * и решит сам, что и как писать в лог.
 */
export async function syncUser(
  deps: CalendarDeps, userId: string, today: string, now: Date,
): Promise<{ synced: number; failed: number }> {
  const calendars = await deps.getCalendars(userId);
  let synced = 0;
  let failed = 0;
  for (const calendar of calendars) {
    if (!calendar.selected) continue;
    // Сломанную связь не дёргаем каждые пять минут: доступ вернёт человек
    // кнопкой в настройках, а не наши повторы.
    if (calendar.brokenAt !== null) continue;
    if (calendar.syncedAt !== null
        && now.getTime() - new Date(calendar.syncedAt).getTime() < SYNC_INTERVAL_MS) continue;
    try {
      await syncCalendar(deps, userId, calendar, today);
      synced += 1;
    } catch {
      failed += 1;
    }
  }
  return { synced, failed };
}
