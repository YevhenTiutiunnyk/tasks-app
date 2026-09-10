import 'server-only';
import type { GoogleEvent } from './calendar';
// Только тип: lib/export.ts обязан остаться чистым (ни базы, ни сети, ни
// server-only), иначе его тесты перестанут запускаться без окружения.
// type-import стирается при сборке и кольца зависимостей не создаёт.
import type { EventDraft } from './export';

const BASE = 'https://www.googleapis.com/calendar/v3';

/** Токен синхронизации протух: надо очистить копию и загрузить заново. */
export class SyncTokenExpired extends Error {}

/** Доступ отозван на стороне Google: ходить дальше бессмысленно. */
export class CalendarAccessLost extends Error {}

/** 404: календаря или события больше нет. Не отказ доступа — другое лечение. */
export class CalendarGone extends Error {}

export interface ListEventsParams {
  syncToken?: string;
  timeMin?: string;
  timeMax?: string;
  pageToken?: string;
}

export interface ListEventsResult {
  events: GoogleEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface CalendarClient {
  listCalendars(): Promise<{ calendarId: string; summary: string }[]>;
  listEvents(calendarId: string, params: ListEventsParams): Promise<ListEventsResult>;
  createCalendar(summary: string): Promise<string>;
  deleteCalendar(calendarId: string): Promise<void>;
  insertEvent(calendarId: string, draft: EventDraft): Promise<string>;
  patchEvent(calendarId: string, eventId: string, draft: EventDraft): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

/**
 * Адрес запроса событий. Вынесен из клиента, чтобы правило «с syncToken
 * нельзя передавать окно» проверялось тестом, а не помнилось.
 *
 * showDeleted обязателен: без него отменённые события не придут вовсе,
 * и удалённая встреча осталась бы у нас навсегда.
 */
export function eventsUrl(calendarId: string, params: ListEventsParams): string {
  const url = new URL(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('showDeleted', 'true');
  url.searchParams.set('maxResults', '250');
  if (params.syncToken) {
    url.searchParams.set('syncToken', params.syncToken);
  } else {
    url.searchParams.set('timeMin', params.timeMin!);
    url.searchParams.set('timeMax', params.timeMax!);
  }
  if (params.pageToken) url.searchParams.set('pageToken', params.pageToken);
  return url.toString();
}

/** Адрес одного события: нужен и правке, и удалению. */
function eventUrl(calendarId: string, eventId: string): string {
  return `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

/**
 * Тело события в том виде, в каком его принимает Google.
 *
 * Одна функция на создание и на правку: разойдись они, перенос задачи чинил
 * бы время в одном пути и оставлял старое в другом.
 *
 * Время уходит стенными часами (`dateTime` без смещения) плюс отдельным
 * именем пояса — абсолютное время не считаем никогда, перевод делает тот,
 * у кого есть база часовых поясов.
 */
function eventBody(draft: EventDraft) {
  const clock = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
  return {
    summary: draft.summary,
    start: { dateTime: `${draft.startDate}T${clock(draft.startMinute)}`, timeZone: draft.timeZone },
    end: { dateTime: `${draft.endDate}T${clock(draft.endMinute)}`, timeZone: draft.timeZone },
    // Метка своего события. Нужна полной сверке: если таблица связок
    // потеряется, а календарь останется, без неё сверка создала бы всё
    // заново и получились бы дубли.
    extendedProperties: { private: { taskKey: draft.taskKey } },
  };
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface GoogleResponse {
  id?: string;
  items?: Record<string, unknown>[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

interface CallOptions {
  method?: string;
  body?: unknown;
}

/**
 * Клиент к Google. Второй аргумент — подмена fetch, нужна тестам:
 * живого обращения к Google в автоматических тестах нет.
 */
export function googleClient(accessToken: string, fetcher: Fetcher = fetch): CalendarClient {
  /**
   * Единственное место, где разбираются коды ответа Google.
   *
   * Запись добавляет сюда метод и тело, а не заводит второй такой функции:
   * будь лестница кодов написана дважды, одна копия однажды разошлась бы
   * с другой — и, скажем, 410 при записи перестал бы значить то же, что при
   * чтении.
   */
  async function call(url: string, options: CallOptions = {}): Promise<GoogleResponse> {
    const hasBody = options.body !== undefined;
    const response = await fetcher(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    });
    if (response.status === 410) throw new SyncTokenExpired();
    if (response.status === 401 || response.status === 403) throw new CalendarAccessLost();
    if (response.status === 404) throw new CalendarGone();
    if (!response.ok) {
      // Тело не читаем и в лог не кладём: там могут быть названия встреч.
      throw new Error(`Google ответил ${response.status}`);
    }
    // На удаление Google отвечает 204 без тела, и response.json() на пустом
    // теле бросает. Без этого каждое удавшееся удаление считалось бы отказом,
    // а сверщик повторял бы его вечно. Тело читаем один раз текстом и
    // разбираем только непустое — лестница выше от этого не раздваивается.
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  return {
    async listCalendars() {
      const data = await call(`${BASE}/users/me/calendarList?minAccessRole=reader&maxResults=250`);
      return (data.items ?? []).map((item) => ({
        calendarId: item.id as string,
        summary: (item.summaryOverride ?? item.summary ?? item.id) as string,
      }));
    },
    async listEvents(calendarId, params) {
      const data = await call(eventsUrl(calendarId, params));
      return {
        events: (data.items ?? []) as unknown as GoogleEvent[],
        nextPageToken: data.nextPageToken ?? null,
        nextSyncToken: data.nextSyncToken ?? null,
      };
    },
    async createCalendar(summary) {
      const data = await call(`${BASE}/calendars`, { method: 'POST', body: { summary } });
      return data.id!;
    },
    async deleteCalendar(calendarId) {
      await call(`${BASE}/calendars/${encodeURIComponent(calendarId)}`, { method: 'DELETE' });
    },
    async insertEvent(calendarId, draft) {
      const data = await call(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
        method: 'POST', body: eventBody(draft),
      });
      return data.id!;
    },
    async patchEvent(calendarId, eventId, draft) {
      await call(eventUrl(calendarId, eventId), { method: 'PATCH', body: eventBody(draft) });
    },
    async deleteEvent(calendarId, eventId) {
      await call(eventUrl(calendarId, eventId), { method: 'DELETE' });
    },
  };
}
