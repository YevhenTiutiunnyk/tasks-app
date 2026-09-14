import { afterAll, describe, expect, test } from 'vitest';
import {
  deleteLink, disableExport, enableExport, getCalendars, getEventsBetween, getExport, getLinks,
  replaceCalendarEvents, saveExportState, saveLink, setSelectedCalendars, sql, upsertCalendars,
} from './db';

const run = process.env.DATABASE_URL ? describe : describe.skip;
const USER = 'zz-export-owner';

async function seedUser() {
  await sql`
    insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    values (${USER}, 'ZZ', 'zz-export@example.invalid', false, now(), now())
    on conflict ("id") do nothing`;
}

afterAll(async () => {
  await sql`delete from google_export where user_id = ${USER}`;
  await sql`delete from "user" where "id" = ${USER}`;
  await sql.end();
});

run('выгрузка: доступ к базе', () => {
  test('включение заводит строку, повторное включение обновляет календарь', async () => {
    await seedUser();
    await enableExport(USER, 'cal-1');
    expect(await getExport(USER)).toMatchObject({ calendarId: 'cal-1', enabled: true, brokenAt: null });

    await enableExport(USER, 'cal-2');
    expect((await getExport(USER))!.calendarId).toBe('cal-2');
  });

  test('связки пишутся, перезаписываются и удаляются адресно', async () => {
    await seedUser();
    await enableExport(USER, 'cal-1');
    await saveLink(USER, { taskKey: 't1', eventId: 'e1', fingerprint: 'aaa' });
    await saveLink(USER, { taskKey: 't2', eventId: 'e2', fingerprint: 'bbb' });
    await saveLink(USER, { taskKey: 't1', eventId: 'e1', fingerprint: 'ccc' });

    const links = await getLinks(USER);
    expect(links.find((link) => link.taskKey === 't1')!.fingerprint).toBe('ccc');
    expect(links).toHaveLength(2);

    await deleteLink(USER, 't1');
    expect((await getLinks(USER)).map((link) => link.taskKey)).toEqual(['t2']);
  });

  // Выключение обязано уносить связки: иначе повторное включение начнёт
  // с указателей на события удалённого календаря и получит поток 404.
  test('выключение уносит и строку, и связки', async () => {
    await seedUser();
    await enableExport(USER, 'cal-1');
    await saveLink(USER, { taskKey: 't1', eventId: 'e1', fingerprint: 'aaa' });

    await disableExport(USER);
    expect(await getExport(USER)).toBeNull();
    expect(await getLinks(USER)).toEqual([]);
  });

  test('отметки времени ставятся по отдельности', async () => {
    await seedUser();
    await enableExport(USER, 'cal-1');
    await saveExportState(USER, { syncedAt: true });
    const afterQuick = await getExport(USER);
    expect(afterQuick!.syncedAt).not.toBeNull();
    expect(afterQuick!.reconciledAt).toBeNull();

    await saveExportState(USER, { reconciledAt: true, brokenAt: '2026-09-10T10:00:00.000Z' });
    const afterFull = await getExport(USER);
    expect(afterFull!.reconciledAt).not.toBeNull();
    expect(afterFull!.brokenAt).not.toBeNull();
  });

  function zzEvent(calendarId: string, eventId: string) {
    return {
      calendarId, eventId, title: `ZZ-${eventId}`,
      startsAt: '2026-09-15T10:00:00.000Z', endsAt: '2026-09-15T11:00:00.000Z',
      allDay: false, mine: true, organizerEmail: null, googleUpdatedAt: '2026-09-14T08:00:00.000Z',
    };
  }

  // «Расписание» приходит в listCalendars как любой другой календарь. Отметь
  // его в чтении — и каждая задача появилась бы в сетке ещё и встречей, с двойным
  // напоминанием и предупреждением о наложении задачи на саму себя.
  test('свой календарь выгрузки не виден чтению, даже если его отметили', async () => {
    await seedUser();
    await sql`delete from google_calendars where user_id = ${USER}`;
    await enableExport(USER, 'zz-export-cal');
    await upsertCalendars(USER, [
      { calendarId: 'zz-primary', summary: 'ZZ-основной' },
      { calendarId: 'zz-export-cal', summary: 'Расписание' },
    ]);
    await setSelectedCalendars(USER, ['zz-primary', 'zz-export-cal']);
    await replaceCalendarEvents(USER, 'zz-primary', [zzEvent('zz-primary', 'meeting')]);
    await replaceCalendarEvents(USER, 'zz-export-cal', [zzEvent('zz-export-cal', 'own-task')]);

    expect((await getCalendars(USER)).map((row) => row.calendarId)).toEqual(['zz-primary']);
    const events = await getEventsBetween(USER, '2026-09-15T00:00:00.000Z', '2026-09-16T00:00:00.000Z');
    expect(events.map((event) => event.eventId)).toEqual(['meeting']);
  });

  // После выключения календарь в Google удалён, а upsertCalendars пропавших
  // не убирает: без этой чистки «Расписание» вернулось бы в список чтения
  // мёртвым пунктом, как только исчезнет строка выгрузки.
  test('выключение убирает строку своего календаря из чтения, чужие не трогает', async () => {
    await seedUser();
    await sql`delete from google_calendars where user_id = ${USER}`;
    await enableExport(USER, 'zz-export-cal');
    await upsertCalendars(USER, [
      { calendarId: 'zz-primary', summary: 'ZZ-основной' },
      { calendarId: 'zz-export-cal', summary: 'Расписание' },
    ]);

    await disableExport(USER);

    const [left] = await sql`
      select count(*)::int as n from google_calendars
      where user_id = ${USER} and calendar_id = 'zz-export-cal'`;
    expect(left.n).toBe(0);
    expect((await getCalendars(USER)).map((row) => row.calendarId)).toEqual(['zz-primary']);
  });
});
