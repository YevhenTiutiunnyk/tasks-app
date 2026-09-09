import { expect, test } from 'vitest';
import { CalendarAccessLost, SyncTokenExpired, eventsUrl, googleClient } from './google-api';

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
