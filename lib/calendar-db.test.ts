import { afterAll, expect, test } from 'vitest';
import { sql } from './db';
import {
  clearCalendarEvents, deleteEvents, disconnectCalendars, getCalendars,
  getEventsBetween, saveSyncState, setSelectedCalendars, upsertCalendars, upsertEvents,
} from './db';

const USER = 'zz-cal-owner';

async function seedUser() {
  await sql`
    insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    values (${USER}, 'ZZ', 'zz-cal@example.invalid', false, now(), now())
    on conflict ("id") do nothing`;
}

afterAll(async () => {
  await sql`delete from google_events where user_id = ${USER}`;
  await sql`delete from google_calendars where user_id = ${USER}`;
  await sql`delete from "user" where "id" = ${USER}`;
  await sql.end();
});

test('upsertCalendars не затирает выбор и токен у существующей строки', async () => {
  await seedUser();
  await upsertCalendars(USER, [{ calendarId: 'primary', summary: 'ZZ-основной' }]);
  await setSelectedCalendars(USER, ['primary']);
  await saveSyncState(USER, 'primary', { syncToken: 'tok-1' });

  // Повторный список от Google: название поменялось, выбор и токен обязаны выжить.
  await upsertCalendars(USER, [{ calendarId: 'primary', summary: 'ZZ-переименован' }]);

  const [row] = await getCalendars(USER);
  expect(row.summary).toBe('ZZ-переименован');
  expect(row.selected).toBe(true);
  expect(row.syncToken).toBe('tok-1');
});

test('события пишутся, перезаписываются и выбираются по пересечению отрезка', async () => {
  await seedUser();
  await upsertCalendars(USER, [{ calendarId: 'primary', summary: 'ZZ-основной' }]);
  await upsertEvents(USER, [{
    calendarId: 'primary', eventId: 'e1', title: 'ZZ-созвон',
    startsAt: '2026-09-09T08:00:00.000Z', endsAt: '2026-09-09T09:00:00.000Z',
    allDay: false, mine: true, organizerEmail: 'zz-cal@example.invalid',
    googleUpdatedAt: '2026-09-08T10:00:00.000Z',
  }]);

  // Многодневная встреча: начинается до окна, кончается внутри него.
  await upsertEvents(USER, [{
    calendarId: 'primary', eventId: 'e2', title: 'ZZ-отпуск',
    startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-10T00:00:00.000Z',
    allDay: true, mine: true, organizerEmail: null,
    googleUpdatedAt: '2026-09-08T10:00:00.000Z',
  }]);

  const found = await getEventsBetween(USER, '2026-09-09T00:00:00.000Z', '2026-09-10T00:00:00.000Z');
  expect(found.map((event) => event.eventId).sort()).toEqual(['e1', 'e2']);

  await deleteEvents(USER, 'primary', ['e1']);
  const after = await getEventsBetween(USER, '2026-09-09T00:00:00.000Z', '2026-09-10T00:00:00.000Z');
  expect(after.map((event) => event.eventId)).toEqual(['e2']);

  await clearCalendarEvents(USER, 'primary');
  expect(await getEventsBetween(USER, '2026-09-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z')).toEqual([]);
});

test('disconnectCalendars убирает и календари, и события', async () => {
  await seedUser();
  await upsertCalendars(USER, [{ calendarId: 'primary', summary: 'ZZ-основной' }]);
  await upsertEvents(USER, [{
    calendarId: 'primary', eventId: 'e3', title: 'ZZ-встреча',
    startsAt: '2026-09-09T08:00:00.000Z', endsAt: '2026-09-09T09:00:00.000Z',
    allDay: false, mine: false, organizerEmail: 'zz-other@example.invalid',
    googleUpdatedAt: '2026-09-08T10:00:00.000Z',
  }]);

  await disconnectCalendars(USER);
  expect(await getCalendars(USER)).toEqual([]);
});
