import { expect, test } from 'vitest';
import { CalendarAccessLost, CalendarGone, SyncTokenExpired, eventsUrl, googleClient } from './google-api';

test('первая загрузка просит окно и разворачивает повторы', () => {
  const url = new URL(eventsUrl('primary', { timeMin: '2026-08-08T00:00:00.000Z', timeMax: '2026-12-08T00:00:00.000Z' }));
  expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
  expect(url.searchParams.get('singleEvents')).toBe('true');
  expect(url.searchParams.get('showDeleted')).toBe('true');
  expect(url.searchParams.get('timeMin')).toBe('2026-08-08T00:00:00.000Z');
});

test('инкрементальная загрузка не передаёт окно — Google это запрещает', () => {
  const url = new URL(eventsUrl('primary', { syncToken: 'tok-1' }));
  expect(url.searchParams.get('syncToken')).toBe('tok-1');
  expect(url.searchParams.has('timeMin')).toBe(false);
  expect(url.searchParams.has('timeMax')).toBe(false);
});

test('идентификатор календаря экранируется', () => {
  const url = new URL(eventsUrl('zz+cal@group.calendar.google.com', { syncToken: 't' }));
  expect(url.pathname).toBe('/calendar/v3/calendars/zz%2Bcal%40group.calendar.google.com/events');
});

test('410 превращается в SyncTokenExpired, 401 — в CalendarAccessLost', async () => {
  const client = googleClient('zz-token', async (url) =>
    new Response('{}', { status: url.includes('syncToken') ? 410 : 401 }));
  await expect(client.listEvents('primary', { syncToken: 't' })).rejects.toBeInstanceOf(SyncTokenExpired);
  await expect(client.listEvents('primary', { timeMin: 'a', timeMax: 'b' })).rejects.toBeInstanceOf(CalendarAccessLost);
});

test('403 тоже даёт CalendarAccessLost', async () => {
  const client = googleClient('zz-token', async () => new Response('{}', { status: 403 }));
  await expect(client.listEvents('primary', { timeMin: 'a', timeMax: 'b' })).rejects.toBeInstanceOf(
    CalendarAccessLost
  );
});

test('500 даёт обычную Error, не содержащую тела ответа', async () => {
  const secretBody = '{"error":"ZZ-секретное название встречи"}';
  const client = googleClient('zz-token', async () => new Response(secretBody, { status: 500 }));
  const error = await client.listEvents('primary', { timeMin: 'a', timeMax: 'b' }).catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(SyncTokenExpired);
  expect(error).not.toBeInstanceOf(CalendarAccessLost);
  expect(error.message).not.toContain('секретное');
  expect(error.message).not.toContain('ZZ');
});

const draft = {
  summary: 'ZZ-тренировка', startDate: '2026-09-10', startMinute: 600,
  endDate: '2026-09-10', endMinute: 660, timeZone: 'Europe/Amsterdam', taskKey: 't1',
};

interface EventPayload {
  summary: string;
  start: unknown;
  end: unknown;
  extendedProperties: { private: { taskKey: string } };
}

/** Что ушло в Google: адрес, метод, заголовки и тело одного запроса. */
interface SentRequest {
  url: string;
  method?: string;
  contentType: string | null;
  body?: string;
}

function recorder(response: () => Response) {
  const sent: SentRequest = { url: '', contentType: null };
  const fetcher = async (url: string, init: RequestInit) => {
    sent.url = url;
    sent.method = init.method;
    sent.contentType = new Headers(init.headers).get('Content-Type');
    sent.body = init.body as string | undefined;
    return response();
  };
  return { sent, fetcher };
}

// Адрес и метод проверяются наравне с телом. Запись в чужой календарь —
// ровно то, от чего бережёт разрешение calendar.app.created, а вызывающего
// у этих методов пока нет: кроме теста, за адрес не отвечает никто.
// Молча потерянный calendarId отправил бы задачи человека в его основной
// календарь, и тело при этом было бы правильным до последнего поля.
test('создание события шлёт POST по адресу событий календаря, стенными часами', async () => {
  const { sent, fetcher } = recorder(() => new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
  const client = googleClient('zz-token', fetcher);
  const eventId = await client.insertEvent('cal-1', draft);
  expect(eventId).toBe('e1');
  expect(sent.method).toBe('POST');
  expect(new URL(sent.url).pathname).toBe('/calendar/v3/calendars/cal-1/events');
  expect(sent.contentType).toBe('application/json');
  const body = JSON.parse(sent.body!) as EventPayload;
  expect(body.start).toEqual({ dateTime: '2026-09-10T10:00:00', timeZone: 'Europe/Amsterdam' });
  expect(body.end).toEqual({ dateTime: '2026-09-10T11:00:00', timeZone: 'Europe/Amsterdam' });
  expect(body.extendedProperties.private.taskKey).toBe('t1');
});

test('идентификатор календаря в адресе события экранируется', async () => {
  const { sent, fetcher } = recorder(() => new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
  await googleClient('zz-token', fetcher).insertEvent('zz+cal@group.calendar.google.com', draft);
  expect(new URL(sent.url).pathname).toBe(
    '/calendar/v3/calendars/zz%2Bcal%40group.calendar.google.com/events',
  );
});

// Часы и минуты обязаны быть двузначными всегда: Google отказывает
// на кривом dateTime, и без этой проверки любая задача раньше десяти утра
// уезжала бы как «9:05:00» и не создавалась вовсе.
test('однозначный час и ненулевая минута уезжают двузначными', async () => {
  const { sent, fetcher } = recorder(() => new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
  await googleClient('zz-token', fetcher).insertEvent('cal-1', {
    ...draft, startMinute: 5, endMinute: 545,
  });
  const body = JSON.parse(sent.body!) as EventPayload;
  expect(body.start).toEqual({ dateTime: '2026-09-10T00:05:00', timeZone: 'Europe/Amsterdam' });
  expect(body.end).toEqual({ dateTime: '2026-09-10T09:05:00', timeZone: 'Europe/Amsterdam' });
});

test('создание календаря шлёт POST со списком календарей и возвращает идентификатор', async () => {
  const { sent, fetcher } = recorder(() => new Response(JSON.stringify({ id: 'cal-new' }), { status: 200 }));
  expect(await googleClient('zz-token', fetcher).createCalendar('Расписание')).toBe('cal-new');
  expect(sent.method).toBe('POST');
  expect(new URL(sent.url).pathname).toBe('/calendar/v3/calendars');
  expect(sent.contentType).toBe('application/json');
  expect(JSON.parse(sent.body!)).toEqual({ summary: 'Расписание' });
});

// Ответ без идентификатора — не успех: undefined уехал бы в таблицу связок
// под видом идентификатора события, и каждая следующая правка ходила бы
// по адресу .../events/undefined и получала 404 навсегда.
test('ответ без идентификатора — отказ, а не молчаливый undefined', async () => {
  const client = googleClient('zz-token', async () => new Response('{}', { status: 200 }));
  await expect(client.insertEvent('cal-1', draft)).rejects.toThrow(/идентификатор/);
  await expect(client.createCalendar('Расписание')).rejects.toThrow(/идентификатор/);
});

test('404 превращается в CalendarGone, а не в общий отказ', async () => {
  const client = googleClient('zz-token', async () => new Response('{}', { status: 404 }));
  await expect(client.deleteEvent('cal-1', 'e1')).rejects.toBeInstanceOf(CalendarGone);
});

test('403 при записи по-прежнему означает потерю доступа', async () => {
  const client = googleClient('zz-token', async () => new Response('{}', { status: 403 }));
  await expect(client.insertEvent('cal-1', draft)).rejects.toBeInstanceOf(CalendarAccessLost);
});

// Ответ Google на DELETE пуст (204 No Content), и response.json() на нём
// бросает. Без этой проверки каждое удавшееся удаление считалось бы
// отказом, а сверщик повторял бы его вечно.
test('удачное удаление события с пустым телом не считается отказом', async () => {
  const client = googleClient('zz-token', async () => new Response(null, { status: 204 }));
  await expect(client.deleteEvent('cal-1', 'e1')).resolves.toBeUndefined();
});

test('удачное удаление календаря с пустым телом не считается отказом', async () => {
  const client = googleClient('zz-token', async () => new Response(null, { status: 204 }));
  await expect(client.deleteCalendar('cal-1')).resolves.toBeUndefined();
});

test('удаление события шлёт DELETE по адресу события, с экранированием', async () => {
  const { sent, fetcher } = recorder(() => new Response(null, { status: 204 }));
  await googleClient('zz-token', fetcher).deleteEvent('zz+cal@group.calendar.google.com', 'e 1');
  expect(sent.method).toBe('DELETE');
  expect(new URL(sent.url).pathname).toBe(
    '/calendar/v3/calendars/zz%2Bcal%40group.calendar.google.com/events/e%201',
  );
  // Тела у запроса нет — значит и заголовка о его виде быть не должно:
  // ровно это и стережёт признак hasBody в call.
  expect(sent.contentType).toBeNull();
  expect(sent.body).toBeUndefined();
});

test('удаление календаря шлёт DELETE по адресу календаря', async () => {
  const { sent, fetcher } = recorder(() => new Response(null, { status: 204 }));
  await googleClient('zz-token', fetcher).deleteCalendar('zz+cal@group.calendar.google.com');
  expect(sent.method).toBe('DELETE');
  expect(new URL(sent.url).pathname).toBe(
    '/calendar/v3/calendars/zz%2Bcal%40group.calendar.google.com',
  );
  expect(sent.contentType).toBeNull();
});

// Правка идёт тем же телом, что и создание: разойдись они, событие после
// переноса показывало бы старое время в одном из двух путей.
test('правка события шлёт PATCH тем же телом, что и создание', async () => {
  const { sent, fetcher } = recorder(() => new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
  const client = googleClient('zz-token', fetcher);
  await expect(client.patchEvent('cal-1', 'e1', draft)).resolves.toBeUndefined();
  expect(sent.method).toBe('PATCH');
  expect(new URL(sent.url).pathname).toBe('/calendar/v3/calendars/cal-1/events/e1');
  // Заголовок проверяется и здесь, а не только на создании: тело есть у обоих
  // путей записи, и признак hasBody в call не знает разницы между POST
  // и PATCH. Без этой проверки правку можно было бы нечаянно оставить
  // без Content-Type — Google не разобрал бы тело, и в Google не уезжало бы
  // ни одно изменение уже существующей задачи.
  expect(sent.contentType).toBe('application/json');
  expect(JSON.parse(sent.body!)).toEqual({
    summary: 'ZZ-тренировка',
    start: { dateTime: '2026-09-10T10:00:00', timeZone: 'Europe/Amsterdam' },
    end: { dateTime: '2026-09-10T11:00:00', timeZone: 'Europe/Amsterdam' },
    extendedProperties: { private: { taskKey: 't1' } },
  });
});

// Ветка 404 добавлена в общую call, а через неё ходят и чтения ступени A.
// CalendarGone обязана оставаться обычной Error, чтобы catch в calendar-run
// ловил её как прежде, и обязана не быть CalendarAccessLost — иначе чтение
// по несуществующему календарю ложно помечало бы связь сломанной.
test('404 при чтении остаётся обычной Error и не выглядит потерей доступа', async () => {
  const client = googleClient('zz-token', async () => new Response('{}', { status: 404 }));
  const error = await client.listEvents('primary', { timeMin: 'a', timeMax: 'b' }).catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(CalendarGone);
  expect(error).not.toBeInstanceOf(CalendarAccessLost);
  expect(error).not.toBeInstanceOf(SyncTokenExpired);
});
