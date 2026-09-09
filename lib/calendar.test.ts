import { expect, test } from 'vitest';
import { toCalendarEvent, type GoogleEvent } from './calendar';

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
