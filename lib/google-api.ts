import 'server-only';
import type { GoogleEvent } from './calendar';
// lib/export.ts обязан остаться чистым (ни базы, ни сети, ни server-only),
// иначе его тесты перестанут запускаться без окружения. Зависимость идёт
// в эту сторону — «грязный» модуль тянет чистый, — и кольца не создаёт:
// export.ts про этот файл не знает.
import { eventIdFor, type EventDraft } from './export';

const BASE = 'https://www.googleapis.com/calendar/v3';

/** Токен синхронизации протух: надо очистить копию и загрузить заново. */
export class SyncTokenExpired extends Error {}

/** Доступ отозван на стороне Google: ходить дальше бессмысленно. */
export class CalendarAccessLost extends Error {}

/** 404: календаря или события больше нет. Не отказ доступа — другое лечение. */
export class CalendarGone extends Error {}

/**
 * 409: событие с таким идентификатором в календаре уже есть.
 *
 * Возможно только с тех пор, как идентификатор выводится из ключа задачи
 * (eventIdFor в lib/export.ts): раньше его назначал Google и столкнуться
 * было не с чем. Это не отказ, а успех наоборот — «то, что ты просишь
 * создать, уже создано», — и лечится правкой того же идентификатора.
 */
export class EventAlreadyExists extends Error {}

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
    // заново и получились бы дубли. Выведенный идентификатор её НЕ заменяет:
    // сверка ищет наши события в чужом списке, а не проверяет догадку об id.
    extendedProperties: { private: { taskKey: draft.taskKey } },
    // Всегда явно «живое». На создании это и так умолчание, а вот на правке
    // несёт вес: правкой мы чиним ответ 409 на создание, а один из поводов
    // для 409 — событие с этим идентификатором в календаре уже БЫЛО и было
    // удалено (Google помнит идентификаторы удалённых). Без этого поля
    // правка оставила бы его отменённым, и задача, удалённая и возвращённая
    // отменой, больше никогда не показалась бы в календаре.
    status: 'confirmed',
  };
}

/**
 * Идентификатор из ответа — то единственное, ради чего делался запрос
 * на создание. Без проверки undefined уехал бы в таблицу связок под видом
 * идентификатора, и каждая последующая правка ходила бы по адресу
 * .../events/undefined и получала бы 404 вечно. Ответ в сообщение
 * не кладём: там бывают названия встреч.
 */
function requireId(data: GoogleResponse): string {
  if (!data.id) throw new Error('Google не вернул идентификатор');
  return data.id;
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
 * Причины 403, за которыми стоит не потеря доступа, а лимит запросов —
 * Google отвечает тем же кодом на оба исхода. До этой правки оба лечились
 * одинаково: `broken_at` и остановка стадии, а единственный описанный выход
 * с экрана настроек — «Выключить» + «Включить», то есть удаление всего
 * календаря «Расписание» ради временной заминки (находка I3 финального
 * ревью). rateLimitExceeded/userRateLimitExceeded — старое семейство ошибок
 * Calendar API, quotaExceeded — новое; Google не обещает прислать только
 * одно из трёх, поэтому распознаём все.
 */
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

/**
 * Причина отказа 403 из тела ответа Google — если тело вообще пришло
 * и хоть отдалённо похоже на ожидаемую форму. `undefined` значит «не
 * поняли», а не «лимита нет»: неопознанное тело неотличимо от чужого
 * формата ошибки, и в этом случае 403 остаётся потерей доступа — это
 * безопасная сторона ошибки, лимит хотя бы называет себя явно в `reason`.
 */
async function rateLimitReason(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => '');
  if (!text) return undefined;
  try {
    const data = JSON.parse(text) as { error?: { errors?: { reason?: string }[] } };
    return data.error?.errors?.[0]?.reason;
  } catch {
    return undefined;
  }
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
    if (response.status === 401) throw new CalendarAccessLost();
    if (response.status === 403) {
      // Тело читаем ТОЛЬКО чтобы отличить лимит запросов от настоящей
      // потери доступа — и не логируем ни при каком исходе, там бывают
      // названия встреч (см. rateLimitReason выше). Лестница кодов
      // остаётся одной: ветвление на причину живёт внутри этого же 403,
      // а не превращается во вторую лестницу рядом.
      const reason = await rateLimitReason(response);
      if (reason !== undefined && RATE_LIMIT_REASONS.has(reason)) {
        throw new Error('Google ответил 403: превышен лимит запросов');
      }
      throw new CalendarAccessLost();
    }
    if (response.status === 404) throw new CalendarGone();
    if (response.status === 409) throw new EventAlreadyExists();
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
      return requireId(data);
    },
    async deleteCalendar(calendarId) {
      await call(`${BASE}/calendars/${encodeURIComponent(calendarId)}`, { method: 'DELETE' });
    },
    async insertEvent(calendarId, draft) {
      const data = await call(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
        // Идентификатор задаём САМИ и выводим его из ключа задачи — только
        // это и делает создание идемпотентным. Уберёшь `id` отсюда, и Google
        // снова начнёт назначать случайный: повтор создания перестанет
        // отвечать 409 и вернёт вечный дубль (см. eventIdFor в lib/export.ts).
        method: 'POST', body: { id: eventIdFor(draft.taskKey), ...eventBody(draft) },
      });
      return requireId(data);
    },
    async patchEvent(calendarId, eventId, draft) {
      await call(eventUrl(calendarId, eventId), { method: 'PATCH', body: eventBody(draft) });
    },
    async deleteEvent(calendarId, eventId) {
      // 410 здесь значит не то же самое, что у списка событий: там это
      // «токен синхронизации протух, нужен полный обход», а на удаление
      // одного события Google так отвечает, когда событие уже удалено —
      // например, при повторном удалении после сбоя середины прохода
      // сверщика. Общая лестница в call() не различает эндпоинты нарочно
      // (иначе разошлась бы), поэтому смысл 410 переводится здесь, на
      // границе конкретного метода, который знает, что тут значит именно
      // это. Без перевода отказ уходил бы как «прочий», сверщик не снимал
      // бы связку и повторял бы обречённое удаление каждые пять минут
      // вечно.
      try {
        await call(eventUrl(calendarId, eventId), { method: 'DELETE' });
      } catch (error) {
        if (error instanceof SyncTokenExpired) throw new CalendarGone();
        throw error;
      }
    },
  };
}
