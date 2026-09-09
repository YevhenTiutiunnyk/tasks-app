import { expect, test } from 'vitest';
import { toCalendarEvent, splitIntoDays, type GoogleEvent } from './calendar';
import type { CalendarEvent } from './types';

const OWNER = 'zz-owner@example.invalid';

function raw(patch: Partial<GoogleEvent> = {}): GoogleEvent {
  return {
    id: 'e1',
    summary: 'ZZ-созвон',
    updated: '2026-09-08T10:00:00.000Z',
    start: { dateTime: '2026-09-09T10:00:00+02:00' },
    end: { dateTime: '2026-09-09T11:00:00+02:00' },
    organizer: { email: OWNER },
    ...patch,
  };
}

test('обычная встреча переводится в абсолютные времена', () => {
  const event = toCalendarEvent(raw(), 'primary', OWNER)!;
  expect(event.startsAt).toBe('2026-09-09T08:00:00.000Z');
  expect(event.endsAt).toBe('2026-09-09T09:00:00.000Z');
  expect(event.allDay).toBe(false);
  expect(event.mine).toBe(true);
});

test('событие на весь день остаётся датами, а не мгновениями', () => {
  const event = toCalendarEvent(
    raw({ start: { date: '2026-09-09' }, end: { date: '2026-09-11' } }),
    'primary', OWNER,
  )!;
  expect(event.allDay).toBe(true);
  expect(event.startsAt).toBe('2026-09-09T00:00:00.000Z');
  expect(event.endsAt).toBe('2026-09-11T00:00:00.000Z');
});

test('отменённое событие в копии не место', () => {
  expect(toCalendarEvent(raw({ status: 'cancelled' }), 'primary', OWNER)).toBeNull();
});

test('отклонённое приглашение не занимает время', () => {
  const declined = raw({
    organizer: { email: 'zz-other@example.invalid' },
    attendees: [{ email: OWNER, self: true, responseStatus: 'declined' }],
  });
  expect(toCalendarEvent(declined, 'primary', OWNER)).toBeNull();
});

test('помеченное «свободен» не занимает время', () => {
  expect(toCalendarEvent(raw({ transparency: 'transparent' }), 'primary', OWNER)).toBeNull();
});

test('чужая встреча помечается как не своя, регистр адреса не важен', () => {
  const foreign = raw({ organizer: { email: 'ZZ-Other@Example.Invalid' } });
  expect(toCalendarEvent(foreign, 'primary', OWNER)!.mine).toBe(false);
  const upper = raw({ organizer: { email: OWNER.toUpperCase() } });
  expect(toCalendarEvent(upper, 'primary', OWNER)!.mine).toBe(true);
});

test('событие без организатора считается своим', () => {
  const own = raw({ organizer: undefined });
  expect(toCalendarEvent(own, 'primary', OWNER)!.mine).toBe(true);
});

test('событие без названия получает читаемую заглушку', () => {
  expect(toCalendarEvent(raw({ summary: undefined }), 'primary', OWNER)!.title).toBe('(без названия)');
});

test('событие без start или end не может быть отображено, возвращает null', () => {
  expect(toCalendarEvent(raw({ start: undefined }), 'primary', OWNER)).toBeNull();
  expect(toCalendarEvent(raw({ end: undefined }), 'primary', OWNER)).toBeNull();
  expect(toCalendarEvent(raw({ start: undefined, end: undefined }), 'primary', OWNER)).toBeNull();
});

test('событие без явного контекста времени (без Z или смещения) неопределённо, возвращает null', () => {
  // Строка без Z и без смещения разбирается по часовому поясу процесса
  const noContext = raw({ start: { dateTime: '2026-09-09T10:00:00' }, end: { dateTime: '2026-09-09T11:00:00' } });
  expect(toCalendarEvent(noContext, 'primary', OWNER)).toBeNull();

  // Только Z в start, но не в end
  const onlyStartZ = raw({ start: { dateTime: '2026-09-09T10:00:00Z' }, end: { dateTime: '2026-09-09T11:00:00' } });
  expect(toCalendarEvent(onlyStartZ, 'primary', OWNER)).toBeNull();

  // С Z или смещением — проходит
  expect(toCalendarEvent(raw({ start: { dateTime: '2026-09-09T10:00:00Z' }, end: { dateTime: '2026-09-09T11:00:00Z' } }), 'primary', OWNER)).not.toBeNull();
  expect(toCalendarEvent(raw({ start: { dateTime: '2026-09-09T10:00:00+02:00' }, end: { dateTime: '2026-09-09T11:00:00+02:00' } }), 'primary', OWNER)).not.toBeNull();
});

// Тесты для splitIntoDays
function event(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: 'primary', eventId: 'e1', title: 'ZZ-созвон',
    startsAt: '2026-09-09T08:00:00.000Z', endsAt: '2026-09-09T09:30:00.000Z',
    allDay: false, mine: true, organizerEmail: null,
    googleUpdatedAt: '2026-09-08T10:00:00.000Z', ...patch,
  };
}

test('встреча переводится в локальные минуты пояса', () => {
  const [day] = splitIntoDays([event()], 'Europe/Amsterdam', '2026-09-07', '2026-09-13');
  expect(day.date).toBe('2026-09-09');
  expect(day.startMinute).toBe(600); // 10:00 по Амстердаму
  expect(day.durationMinutes).toBe(90);
});

test('встреча через полночь режется на два дня', () => {
  const days = splitIntoDays(
    [event({ startsAt: '2026-09-09T21:00:00.000Z', endsAt: '2026-09-09T23:30:00.000Z' })],
    'Europe/Amsterdam', '2026-09-07', '2026-09-13',
  );
  expect(days.map((day) => [day.date, day.startMinute, day.durationMinutes])).toEqual([
    ['2026-09-09', 1380, 60],  // 23:00–24:00
    ['2026-09-10', 0, 90],     // 00:00–01:30
  ]);
});

test('событие на весь день появляется на каждом своём дне, конец не включается', () => {
  const days = splitIntoDays(
    [event({ allDay: true, startsAt: '2026-09-09T00:00:00.000Z', endsAt: '2026-09-11T00:00:00.000Z' })],
    'Europe/Amsterdam', '2026-09-07', '2026-09-13',
  );
  expect(days.map((day) => day.date)).toEqual(['2026-09-09', '2026-09-10']);
  expect(days[0].allDay).toBe(true);
  expect(days[0].startMinute).toBeNull();
});

test('за пределы окна не выходит', () => {
  const days = splitIntoDays(
    [event({ allDay: true, startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-30T00:00:00.000Z' })],
    'Europe/Amsterdam', '2026-09-09', '2026-09-10',
  );
  expect(days.map((day) => day.date)).toEqual(['2026-09-09', '2026-09-10']);
});

test('встреча, кончающаяся ровно в полночь, лишнего дня не даёт', () => {
  const days = splitIntoDays(
    [event({ startsAt: '2026-09-09T20:00:00.000Z', endsAt: '2026-09-09T22:00:00.000Z' })],
    'Europe/Amsterdam', '2026-09-07', '2026-09-13',
  );
  expect(days.map((day) => day.date)).toEqual(['2026-09-09']);
  expect(days[0].durationMinutes).toBe(120);
});
