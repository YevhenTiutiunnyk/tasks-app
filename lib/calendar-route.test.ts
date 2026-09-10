import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Владельца в роутах даёт сессия better-auth. Поднимать её ради проверки
// роутов незачем — подменяем помощника, как в lib/api-key-route.test.ts.
const session = vi.hoisted(() => ({ userId: 'zz-cal-owner' }));
vi.mock('@/lib/require-user', () => ({
  requireUser: async () => ({ userId: session.userId }),
}));

// Роут при каждом GET пытается обновить список у Google — реальный поход
// в API стоит времени и требует настоящего токена. Подменяем модуль целиком
// и по умолчанию бросаем «доступа нет»: ровно то, что видит роут, когда
// человек ещё не подключал календарь вовсе.
const googleToken = vi.hoisted(() => ({
  fail: true,
  calendars: [] as { calendarId: string; summary: string }[],
}));
vi.mock('@/lib/google-token', () => ({
  getCalendarClient: async () => {
    if (googleToken.fail) throw new Error('ZZ-нет доступа');
    return { listCalendars: async () => googleToken.calendars };
  },
}));

import { sql } from '@/lib/db';
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
    googleToken.fail = true;
    googleToken.calendars = [];
  });

  afterAll(async () => {
    await sql`delete from google_events where user_id = ${USER_ID}`;
    await sql`delete from google_calendars where user_id = ${USER_ID}`;
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
    googleToken.fail = false;
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
    googleToken.fail = false;
    googleToken.calendars = [{ calendarId: 'primary', summary: 'ZZ-основной' }];
    await GET(new Request('http://localhost/api/calendar'));

    googleToken.fail = true;
    let body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(true);

    // Возврат с экрана согласия Google делает ровно этот запрос — удачный
    // GET и есть единственный человеческий сигнал «связь снова жива».
    googleToken.fail = false;
    body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(false);
  });

  it('C1: живой календарь помечается сломанным после неудачного GET', async () => {
    googleToken.fail = false;
    googleToken.calendars = [{ calendarId: 'primary', summary: 'ZZ-основной' }];
    await GET(new Request('http://localhost/api/calendar'));
    let body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(false);

    googleToken.fail = true;
    body = await (await GET(new Request('http://localhost/api/calendar'))).json();
    expect(body.broken).toBe(true);
  });

  it('DELETE убирает строки владельца zz-cal-owner', async () => {
    googleToken.fail = false;
    googleToken.calendars = [{ calendarId: 'primary', summary: 'ZZ-основной' }];
    await GET(new Request('http://localhost/api/calendar'));

    expect((await DELETE(new Request('http://localhost/api/calendar', { method: 'DELETE' }))).status)
      .toBe(200);

    const [row] = await sql`select * from google_calendars where user_id = ${USER_ID}`;
    expect(row).toBeUndefined();
  });
});
