import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from './db';
import {
  clearCalendarEvents, deleteEvents, disconnectCalendars, getCalendars,
  getEventsBetween, replaceCalendarEvents, saveSyncState, setSelectedCalendars,
  upsertCalendars, upsertEvents,
} from './db';

// Файл ходит в базу. Без DATABASE_URL в окружении (обычный `npx vitest run`)
// пропускаем — тот же приём, что в db.test.ts, ownership.test.ts
// и user-key-db.test.ts: контракт проекта — прогон без базы обязан
// пропускать такие тесты, а не падать на ECONNREFUSED.
const run = process.env.DATABASE_URL ? describe : describe.skip;

const USER = 'zz-cal-owner';
// Второй владелец — только для проверки «чужого не тронул» у replaceCalendarEvents:
// регрессия фильтра user_id иначе неотличима от простого совпадения.
const OTHER_USER = 'zz-cal-other-owner';

run('google_calendars / google_events', () => {
  beforeAll(async () => {
    await sql`
      insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      values (${USER}, 'ZZ', 'zz-cal@example.invalid', false, now(), now())
      on conflict ("id") do nothing`;
    await sql`
      insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      values (${OTHER_USER}, 'ZZ2', 'zz-cal-other@example.invalid', false, now(), now())
      on conflict ("id") do nothing`;
  });

  afterAll(async () => {
    await sql`delete from google_events where user_id = ${USER} or user_id = ${OTHER_USER}`;
    await sql`delete from google_calendars where user_id = ${USER} or user_id = ${OTHER_USER}`;
    await sql`delete from "user" where "id" = ${USER} or "id" = ${OTHER_USER}`;
    await sql.end();
  });

  it('upsertCalendars не затирает выбор и токен у существующей строки', async () => {
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

  it('события пишутся, перезаписываются и выбираются по пересечению отрезка', async () => {
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

  it('replaceCalendarEvents меняет копию целиком одной операцией', async () => {
    await upsertCalendars(USER, [
      { calendarId: 'primary', summary: 'ZZ-основной' },
      { calendarId: 'work', summary: 'ZZ-рабочий' },
    ]);
    await upsertCalendars(OTHER_USER, [{ calendarId: 'primary', summary: 'ZZ-чужой' }]);
    // getEventsBetween показывает только выбранные календари — без этого
    // тест зависел бы от того, что 'primary' у USER выбрали более ранние
    // тесты файла, а свежесозданные 'work' и календарь OTHER_USER остались
    // бы невыбранными (selected по умолчанию false) и молча выпали из выборки.
    await setSelectedCalendars(USER, ['primary', 'work']);
    await setSelectedCalendars(OTHER_USER, ['primary']);

    // Старьё лежит в трёх местах: в целевом календаре (должно исчезнуть),
    // в другом календаре того же владельца и у чужого владельца в календаре
    // с тем же именем — оба должны остаться нетронутыми ровно потому,
    // что replaceCalendarEvents фильтрует по паре (user_id, calendar_id).
    await upsertEvents(USER, [{
      calendarId: 'primary', eventId: 'old', title: 'ZZ-старое',
      startsAt: '2026-09-09T08:00:00.000Z', endsAt: '2026-09-09T09:00:00.000Z',
      allDay: false, mine: true, organizerEmail: 'zz-cal@example.invalid',
      googleUpdatedAt: '2026-09-08T10:00:00.000Z',
    }]);
    await upsertEvents(USER, [{
      calendarId: 'work', eventId: 'other-cal', title: 'ZZ-другой-календарь',
      startsAt: '2026-09-09T08:00:00.000Z', endsAt: '2026-09-09T09:00:00.000Z',
      allDay: false, mine: true, organizerEmail: 'zz-cal@example.invalid',
      googleUpdatedAt: '2026-09-08T10:00:00.000Z',
    }]);
    await upsertEvents(OTHER_USER, [{
      calendarId: 'primary', eventId: 'other-owner', title: 'ZZ-чужое',
      startsAt: '2026-09-09T08:00:00.000Z', endsAt: '2026-09-09T09:00:00.000Z',
      allDay: false, mine: true, organizerEmail: 'zz-cal-other@example.invalid',
      googleUpdatedAt: '2026-09-08T10:00:00.000Z',
    }]);

    await replaceCalendarEvents(USER, 'primary', [{
      calendarId: 'primary', eventId: 'new', title: 'ZZ-новое',
      startsAt: '2026-09-10T08:00:00.000Z', endsAt: '2026-09-10T09:00:00.000Z',
      allDay: false, mine: true, organizerEmail: 'zz-cal@example.invalid',
      googleUpdatedAt: '2026-09-09T10:00:00.000Z',
    }]);

    const mine = await getEventsBetween(USER, '2026-09-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
    expect(mine.map((event) => event.eventId).sort()).toEqual(['new', 'other-cal']);

    const theirs = await getEventsBetween(OTHER_USER, '2026-09-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
    expect(theirs.map((event) => event.eventId)).toEqual(['other-owner']);
  });

  it('replaceCalendarEvents откатывает всё целиком, если транзакция падает', async () => {
    await upsertCalendars(USER, [{ calendarId: 'atomic', summary: 'ZZ-атомарность' }]);
    await upsertEvents(USER, [{
      calendarId: 'atomic', eventId: 'keep-me', title: 'ZZ-старое',
      startsAt: '2026-09-09T08:00:00.000Z', endsAt: '2026-09-09T09:00:00.000Z',
      allDay: false, mine: true, organizerEmail: 'zz-cal@example.invalid',
      googleUpdatedAt: '2026-09-08T10:00:00.000Z',
    }]);

    // Дублирующийся event_id роняет вторую вставку нарушением первичного
    // ключа (user_id, calendar_id, event_id) — дёшево воспроизводит настоящий
    // сбой транзакции настоящей базой, без подмены sql. Если replaceCalendarEvents
    // когда-нибудь лишится sql.begin, delete и первая вставка успеют
    // закоммититься по отдельности до того, как вторая упадёт, — и старое
    // событие останется удалённым, а не восстановленным откатом.
    const dup = {
      calendarId: 'atomic', eventId: 'dup', title: 'ZZ-новое',
      startsAt: '2026-09-10T08:00:00.000Z', endsAt: '2026-09-10T09:00:00.000Z',
      allDay: false, mine: true, organizerEmail: 'zz-cal@example.invalid',
      googleUpdatedAt: '2026-09-09T10:00:00.000Z',
    };
    await expect(replaceCalendarEvents(USER, 'atomic', [dup, dup])).rejects.toThrow();

    const rows = await sql`
      select event_id from google_events where user_id = ${USER} and calendar_id = 'atomic'`;
    expect(rows.map((row) => row.event_id)).toEqual(['keep-me']);
  });

  it('disconnectCalendars убирает и календари, и события', async () => {
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
});
