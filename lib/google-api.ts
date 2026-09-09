import 'server-only';
import type { GoogleEvent } from './calendar';

const BASE = 'https://www.googleapis.com/calendar/v3';

/** Токен синхронизации протух: надо очистить копию и загрузить заново. */
export class SyncTokenExpired extends Error {}

/** Доступ отозван на стороне Google: ходить дальше бессмысленно. */
export class CalendarAccessLost extends Error {}

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

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface GoogleResponse {
  items?: Record<string, unknown>[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/**
 * Клиент к Google. Второй аргумент — подмена fetch, нужна тестам:
 * живого обращения к Google в автоматических тестах нет.
 */
export function googleClient(accessToken: string, fetcher: Fetcher = fetch): CalendarClient {
  async function call(url: string): Promise<GoogleResponse> {
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 410) throw new SyncTokenExpired();
    if (response.status === 401 || response.status === 403) throw new CalendarAccessLost();
    if (!response.ok) {
      // Тело не читаем и в лог не кладём: там могут быть названия встреч.
      throw new Error(`Google ответил ${response.status}`);
    }
    return response.json();
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
  };
}
