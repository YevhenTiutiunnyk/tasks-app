import { expect, test } from 'vitest';
import { CalendarAccessLost, SyncTokenExpired, type CalendarClient } from './google-api';
import { needsFullSync, syncCalendar, syncUser, syncWindow, type CalendarDeps } from './calendar-run';
import type { CalendarRow } from './db';
import type { CalendarEvent } from './types';

const TODAY = '2026-09-08';

function calendar(patch: Partial<CalendarRow> = {}): CalendarRow {
  return {
    calendarId: 'primary', summary: 'ZZ', selected: true, syncToken: 'tok-1',
    windowStart: '2026-08-08', windowEnd: '2026-12-08',
    syncedAt: '2026-09-08T09:00:00.000Z', brokenAt: null, ...patch,
  };
}

function deps(client: Partial<CalendarClient>, calendars: CalendarRow[] = [calendar()]) {
  const state = {
    upserted: [] as CalendarEvent[],
    deleted: [] as string[],
    cleared: 0,
    saved: [] as Parameters<CalendarDeps['saveSyncState']>[2][],
  };
  const full: CalendarDeps = {
    getCalendars: async () => calendars,
    saveSyncState: async (_u, _c, s) => { state.saved.push(s); },
    upsertEvents: async (_u, events) => { state.upserted.push(...events); },
    deleteEvents: async (_u, _c, ids) => { state.deleted.push(...ids); },
    clearCalendarEvents: async () => { state.cleared += 1; },
    clientFor: async () => ({
      listCalendars: async () => [],
      listEvents: async () => ({ events: [], nextPageToken: null, nextSyncToken: null }),
      ...client,
    }),
    ownerEmail: async () => 'zz-owner@example.invalid',
  };
  return { deps: full, state };
}

test('окно — месяц назад и три вперёд', () => {
  const window = syncWindow(TODAY);
  expect(window.from).toBe('2026-08-08T00:00:00.000Z');
  expect(window.to).toBe('2026-12-08T00:00:00.000Z');
});

test('без токена нужна полная загрузка, со свежим окном — нет', () => {
  expect(needsFullSync(calendar({ syncToken: null }), TODAY)).toBe(true);
  expect(needsFullSync(calendar(), TODAY)).toBe(false);
  // Окно уехало: конец ближе, чем через два месяца.
  expect(needsFullSync(calendar({ windowEnd: '2026-10-01' }), TODAY)).toBe(true);
});

test('страницы дочитываются до конца, токен сохраняется с последней', async () => {
  const pages = [
    { events: [{ id: 'a', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-1', start: { dateTime: '2026-09-09T10:00:00Z' }, end: { dateTime: '2026-09-09T11:00:00Z' } }], nextPageToken: 'p2', nextSyncToken: null },
    { events: [{ id: 'b', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-2', start: { dateTime: '2026-09-09T12:00:00Z' }, end: { dateTime: '2026-09-09T13:00:00Z' } }], nextPageToken: null, nextSyncToken: 'tok-2' },
  ];
  let call = 0;
  const { deps: d, state } = deps({ listEvents: async () => pages[call++] });
  await syncCalendar(d, 'zz-user', calendar(), TODAY);
  expect(state.upserted.map((event) => event.eventId)).toEqual(['a', 'b']);
  expect(state.saved.at(-1)!.syncToken).toBe('tok-2');
});

test('отменённое и отклонённое удаляются из копии', async () => {
  const { deps: d, state } = deps({
    listEvents: async () => ({
      events: [
        { id: 'gone', status: 'cancelled', updated: '2026-09-08T10:00:00.000Z' },
        { id: 'free', transparency: 'transparent', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-др', start: { date: '2026-09-09' }, end: { date: '2026-09-10' } },
      ],
      nextPageToken: null, nextSyncToken: 'tok-2',
    }),
  });
  await syncCalendar(d, 'zz-user', calendar(), TODAY);
  expect(state.deleted.sort()).toEqual(['free', 'gone']);
  expect(state.upserted).toEqual([]);
});

test('протухший токен приводит к полной перезагрузке, а не к остановке', async () => {
  let first = true;
  const { deps: d, state } = deps({
    listEvents: async (_id, params) => {
      if (first && params.syncToken) { first = false; throw new SyncTokenExpired(); }
      return { events: [], nextPageToken: null, nextSyncToken: 'tok-new' };
    },
  });
  await syncCalendar(d, 'zz-user', calendar(), TODAY);
  expect(state.cleared).toBe(1);
  expect(state.saved.at(-1)!.syncToken).toBe('tok-new');
});

test('потеря доступа помечает связь сломанной', async () => {
  const { deps: d, state } = deps({ listEvents: async () => { throw new CalendarAccessLost(); } });
  await expect(syncCalendar(d, 'zz-user', calendar(), TODAY)).rejects.toBeInstanceOf(CalendarAccessLost);
  expect(state.saved.at(-1)!.brokenAt).not.toBeNull();
});

test('syncUser пропускает невыбранные, сломанные и свежие календари', async () => {
  const now = new Date('2026-09-08T09:03:00.000Z');
  const { deps: d } = deps({}, [
    calendar({ calendarId: 'a', selected: false }),
    calendar({ calendarId: 'b', brokenAt: '2026-09-08T08:00:00.000Z' }),
    calendar({ calendarId: 'c', syncedAt: '2026-09-08T09:01:00.000Z' }), // 2 минуты назад
  ]);
  expect(await syncUser(d, 'zz-user', TODAY, now)).toBe(0);
});
