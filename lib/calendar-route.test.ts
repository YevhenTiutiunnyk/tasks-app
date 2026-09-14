import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarAccessLost } from '@/lib/google-api';

// Владельца в роутах даёт сессия better-auth. Поднимать её ради проверки
// роутов незачем — подменяем помощника, как в lib/api-key-route.test.ts.
const session = vi.hoisted(() => ({ userId: 'zz-cal-owner' }));
vi.mock('@/lib/require-user', () => ({
  requireUser: async () => ({ userId: session.userId }),
}));

// Роут при каждом GET пытается обновить список у Google — реальный поход
// в API стоит времени и требует настоящего токена. Подменяем модуль целиком.
//
// 'access-lost' — единственный отказ, который роут вправе счесть потерей
// доступа (CalendarAccessLost, ровно то, что реально умеет отличать
// getCalendarClient). 'generic' — любой другой сбой (500 у Google, обрыв
// сети, что угодно ещё) — до второго круга финального ревью роут ставил
// пометку «связь сломана» и на него тоже, хотя сломанный календарь
// пропускают и планировщик, и обновление при открытии: одна сетевая икота
// тихо выключала бы календарь до ручного похода в настройки.
const googleToken = vi.hoisted(() => ({
  failWith: 'access-lost' as 'access-lost' | 'generic' | null,
  calendars: [] as { calendarId: string; summary: string }[],
}));
vi.mock('@/lib/google-token', () => ({
  getCalendarClient: async () => {
    if (googleToken.failWith === 'generic') throw new Error('ZZ-сбой сети');
    if (googleToken.failWith === 'access-lost') throw new CalendarAccessLost();
    return { listCalendars: async () => googleToken.calendars };
  },
}));

import { enableExport, sql } from '@/lib/db';
import { DELETE, GET, PUT } from '@/app/api/calendar/route';

const run = process.env.DATABASE_URL ? describe : describe.skip;

const USER_ID = 'zz-cal-owner';

function put(calendarIds: unknown) {
  return PUT(
    new Request('http://localhost/api/calendar', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarIds }),
    }),
  );
}

run('/api/calendar', () => {
  beforeEach(async () => {
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${USER_ID}, 'ZZ-роут-календаря', 'zz-cal-route@example.invalid', false, now(), now())
      on conflict (id) do nothing
    `;
    await sql`delete from google_events where user_id = ${USER_ID}`;
    await sql`delete from google_calendars where user_id = ${USER_ID}`;
    await sql`delete from google_export where user_id = ${USER_ID}`;
    googleToken.failWith = 'access-lost';
    googleToken.calendars = [];
  });

  afterAll(async () => {
    await sql`delete from google_events where user_id = ${USER_ID}`;
    await sql`delete from google_calendars where user_id = ${USER_ID}`;
    await sql`delete from google_export where user_id = ${USER_ID}`;
    await sql`delete from "user" where id = ${USER_ID}`;
  });

  it('PUT без calendarIds отвечает 400', async () => {
    expect((await put(undefined)).status).toBe(400);
  });

  it('PUT со строкой вместо массива отвечает 400', async () => {
    expect((await put('primary')).status).toBe(400);
  });

  it('PUT с элементом не-строкой отвечает 400', async () => {
    expect((await put(['primary', 42])).status).toBe(400);
  });

  it('GET без подключения — connected false, доступ к Google не роняет роут', async () => {
    const body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body).toEqual({ connected: false, broken: false, calendars: [] });
  });

  it('PUT сохраняет выбор, GET его возвращает', async () => {
    googleToken.failWith = null;
    googleToken.calendars = [
      { calendarId: 'primary', summary: 'ZZ-основной' },
      { calendarId: 'work', summary: 'ZZ-рабочий' },
    ];
    // Первый GET заводит строки в google_calendars через upsertCalendars.
    await GET(new Request('http://localhost/api/calendar'));

    expect((await put(['primary'])).status).toBe(200);

    const body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.connected).toBe(true);
    expect(body.calendars.sort((a: { calendarId: string }, b: { calendarId: string }) =>
      a.calendarId.localeCompare(b.calendarId))).toEqual([
      { calendarId: 'primary', summary: 'ZZ-основной', selected: true },
      { calendarId: 'work', summary: 'ZZ-рабочий', selected: false },
    ]);
  });

  it('C1: сломанный календарь оживает после удачного GET', async () => {
    // Календарь сначала должен появиться (успешный поход в Google), потом
    // сломаться (неудачный) — и только тогда проверяем оживление.
    googleToken.failWith = null;
    googleToken.calendars = [{ calendarId: 'primary', summary: 'ZZ-основной' }];
    await GET(new Request('http://localhost/api/calendar'));

    googleToken.failWith = 'access-lost';
    let body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(true);

    // Возврат с экрана согласия Google делает ровно этот запрос — удачный
    // GET и есть единственный человеческий сигнал «связь снова жива».
    googleToken.failWith = null;
    body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(false);
  });

  it('C1: живой календарь помечается сломанным после отказа CalendarAccessLost', async () => {
    googleToken.failWith = null;
    googleToken.calendars = [{ calendarId: 'primary', summary: 'ZZ-основной' }];
    await GET(new Request('http://localhost/api/calendar'));
    let body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(false);

    googleToken.failWith = 'access-lost';
    body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(true);
  });

  it('второй круг, находка 1: голый сбой (не CalendarAccessLost) НЕ помечает связь сломанной', async () => {
    // 500 у Google на списке календарей, обрыв сети, сбой обновления токена
    // по другой причине, сбой upsertCalendars — ничего из этого не значит
    // «доступа нет». Сломанный календарь пропускают и планировщик,
    // и обновление при открытии — до второго круга финального ревью такая
    // ложная пометка тихо выключала бы календарь на дни, до ручного похода
    // в настройки.
    googleToken.failWith = null;
    googleToken.calendars = [{ calendarId: 'primary', summary: 'ZZ-основной' }];
    await GET(new Request('http://localhost/api/calendar'));
    let body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(false);

    googleToken.failWith = 'generic';
    body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(false);

    // А CalendarAccessLost по-прежнему помечает — иначе находка 1 просто
    // выключила бы C1 вместо того, чтобы сузить её.
    googleToken.failWith = 'access-lost';
    body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(true);
  });

  // Google отдаёт «Расписание» в listCalendars наравне с остальными. Покажи его
  // в списке — и одна галочка превратила бы каждую задачу ещё и во встречу.
  it('календарь выгрузки «Расписание» не попадает в список на чтение', async () => {
    googleToken.failWith = null;
    googleToken.calendars = [
      { calendarId: 'primary', summary: 'ZZ-основной' },
      { calendarId: 'zz-export-cal', summary: 'Расписание' },
    ];
    await enableExport(USER_ID, 'zz-export-cal');

    let body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.calendars.map((c: { calendarId: string }) => c.calendarId)).toEqual(['primary']);

    // Даже прямая попытка отметить его не должна вернуть его в список.
    expect((await put(['primary', 'zz-export-cal'])).status).toBe(200);
    body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.calendars.map((c: { calendarId: string }) => c.calendarId)).toEqual(['primary']);
  });

  it('DELETE убирает строки владельца zz-cal-owner', async () => {
    googleToken.failWith = null;
    googleToken.calendars = [{ calendarId: 'primary', summary: 'ZZ-основной' }];
    await GET(new Request('http://localhost/api/calendar'));

    expect((await DELETE(new Request('http://localhost/api/calendar', { method: 'DELETE' }))).status)
      .toBe(200);

    const [row] = await sql`select * from google_calendars where user_id = ${USER_ID}`;
    expect(row).toBeUndefined();
  });
});
