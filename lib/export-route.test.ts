import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { CalendarAccessLost, CalendarGone } from '@/lib/google-api';

// Владельца в роутах даёт сессия better-auth. Поднимать её ради проверки
// роута незачем — подменяем помощника, как в lib/calendar-route.test.ts.
// Ветка «сессии нет» нужна здесь по-настоящему: requireUser возвращает либо
// userId, либо готовый response, и оба исхода должны дойти до теста.
const session = vi.hoisted(() => ({
  next: { userId: 'zz-export-owner' } as
    | { userId: string; response?: undefined }
    | { userId?: undefined; response: NextResponse },
}));
vi.mock('@/lib/require-user', () => ({
  requireUser: async () => session.next,
}));

// Живого обращения к Google в тестах нет: подменяем модуль токена целиком,
// как в lib/calendar-route.test.ts. Клиент заодно ведёт журнал вызовов —
// без него порядок «сначала Google, потом база» проверить нечем.
const google = vi.hoisted(() => ({
  // Отказ при выдаче клиента: 'access-lost' — разрешения нет, 'generic' —
  // любой другой сбой (сеть, 500 у Google).
  tokenFailure: null as 'access-lost' | 'generic' | null,
  createFailure: null as 'access-lost' | 'generic' | null,
  deleteFailure: null as 'gone' | 'access-lost' | 'generic' | null,
  newCalendarId: 'zz-export-calendar',
  created: [] as string[],
  deleted: [] as string[],
  // Крючок, который срабатывает ВНУТРИ удаления календаря в Google, то есть
  // в тот единственный момент, когда ещё можно посмотреть, на месте ли
  // строка владельца. Тест ставит его сам: из фабрики vi.mock до базы
  // не дотянуться.
  onDeleteCalendar: null as null | (() => Promise<void>),
}));
vi.mock('@/lib/google-token', () => ({
  getCalendarClient: async () => {
    if (google.tokenFailure === 'access-lost') throw new CalendarAccessLost();
    if (google.tokenFailure === 'generic') throw new Error('ZZ-сбой сети');
    return {
      createCalendar: async (summary: string) => {
        if (google.createFailure === 'access-lost') throw new CalendarAccessLost();
        if (google.createFailure === 'generic') throw new Error('ZZ-сбой сети');
        google.created.push(summary);
        return google.newCalendarId;
      },
      deleteCalendar: async (calendarId: string) => {
        google.deleted.push(calendarId);
        if (google.onDeleteCalendar) await google.onDeleteCalendar();
        if (google.deleteFailure === 'gone') throw new CalendarGone();
        if (google.deleteFailure === 'access-lost') throw new CalendarAccessLost();
        if (google.deleteFailure === 'generic') throw new Error('ZZ-сбой сети');
      },
    };
  },
}));

import { sql } from '@/lib/db';
import { DELETE, GET, POST } from '@/app/api/calendar/export/route';

const run = process.env.DATABASE_URL ? describe : describe.skip;

const USER_ID = 'zz-export-owner';

function get() {
  return GET(new Request('http://localhost/api/calendar/export'));
}

function post() {
  return POST(new Request('http://localhost/api/calendar/export', { method: 'POST' }));
}

function del() {
  return DELETE(new Request('http://localhost/api/calendar/export', { method: 'DELETE' }));
}

/** Строка выгрузки прямо из базы — минуя getExport, чтобы проверять факт. */
async function row() {
  const [found] = await sql`
    select calendar_id, enabled, broken_at from google_export where user_id = ${USER_ID}`;
  return found as { calendar_id: string | null; enabled: boolean; broken_at: Date | null } | undefined;
}

run('/api/calendar/export', () => {
  beforeEach(async () => {
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${USER_ID}, 'ZZ-роут-выгрузки', 'zz-export-route@example.invalid', false, now(), now())
      on conflict (id) do nothing
    `;
    await sql`delete from google_export where user_id = ${USER_ID}`;
    session.next = { userId: USER_ID };
    google.tokenFailure = null;
    google.createFailure = null;
    google.deleteFailure = null;
    google.newCalendarId = 'zz-export-calendar';
    google.created = [];
    google.deleted = [];
    google.onDeleteCalendar = null;
    // Сначала снять прошлую подмену: без этого шпионы вкладываются друг
    // в друга и счётчик вызовов копит записи из прежних тестов.
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(async () => {
    await sql`delete from google_export where user_id = ${USER_ID}`;
    await sql`delete from "user" where id = ${USER_ID}`;
    vi.restoreAllMocks();
  });

  it('без сессии все три метода отдают отказ requireUser и в Google не ходят', async () => {
    for (const call of [get, post, del]) {
      // Ответ каждый раз новый: тело Response читается ровно один раз,
      // общий объект на три вызова тест бы и уронил.
      session.next = { response: NextResponse.json({ error: 'Не авторизован' }, { status: 401 }) };
      const response = await call();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Не авторизован' });
    }
    expect(google.created).toEqual([]);
    expect(google.deleted).toEqual([]);
  });

  it('GET до включения — выгрузка выключена и не сломана', async () => {
    expect(await (await get()).json()).toEqual({ enabled: false, broken: false });
  });

  it('POST заводит календарь «Расписание» и включает выгрузку', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    // Название закреплено: по нему человек узнаёт календарь в Google.
    expect(google.created).toEqual(['Расписание']);
    expect(await row()).toMatchObject({ calendar_id: 'zz-export-calendar', enabled: true });
    expect(await (await get()).json()).toEqual({ enabled: true, broken: false });
  });

  it('повторный POST при живой выгрузке второго календаря не заводит', async () => {
    await post();
    google.created = [];

    // Экран делает POST сам после возврата с согласия Google, а вернуться
    // туда можно и кнопкой «назад». Второй календарь «Расписание» повис бы
    // у человека сиротой: указателя на первый у нас бы уже не осталось.
    const response = await post();

    expect(response.status).toBe(200);
    expect(google.created).toEqual([]);
    expect(await row()).toMatchObject({ calendar_id: 'zz-export-calendar' });
  });

  it('POST при потере доступа просит согласие, а не отвечает общим 500', async () => {
    google.createFailure = 'access-lost';

    const response = await post();

    // 500 отправил бы человека чинить сеть вместо того, чтобы нажать одну
    // кнопку и дать разрешение заново.
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.needsConsent).toBe(true);
    expect(body.error).toMatch(/разрешени/i);
    expect(await row()).toBeUndefined();
  });

  it('POST при прочем сбое — 500 без подробностей, выгрузка не включена', async () => {
    google.createFailure = 'generic';

    const response = await post();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.needsConsent).toBeUndefined();
    expect(body.error).not.toMatch('ZZ-сбой сети');
    expect(await row()).toBeUndefined();
  });

  it('DELETE удаляет календарь в Google ДО того, как убирает строку', async () => {
    await post();

    // Строка — единственный указатель на календарь. Убери её первой,
    // и сорвись удаление в Google, — «Расписание» осталось бы висеть
    // в аккаунте навсегда, а удалить его было бы уже нечем.
    let rowAtGoogleCall: Awaited<ReturnType<typeof row>> | 'не заходили' = 'не заходили';
    google.onDeleteCalendar = async () => { rowAtGoogleCall = await row(); };

    const response = await del();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(google.deleted).toEqual(['zz-export-calendar']);
    // Вот это и есть проверка порядка: в момент похода в Google строка
    // обязана быть на месте. Переставь шаги — здесь окажется undefined.
    expect(rowAtGoogleCall).toMatchObject({ calendar_id: 'zz-export-calendar' });
    expect(await row()).toBeUndefined();
  });

  it('DELETE при CalendarGone всё равно выключает выгрузку', async () => {
    await post();
    // Календаря в Google уже нет — его удалили руками. Это ровно то, чего
    // мы добивались, а не отказ.
    google.deleteFailure = 'gone';

    const response = await del();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(await row()).toBeUndefined();
  });

  it('DELETE при потере доступа оставляет строку — иначе указатель потерян', async () => {
    await post();
    google.deleteFailure = 'access-lost';

    const response = await del();

    expect(response.status).toBe(403);
    expect((await response.json()).needsConsent).toBe(true);
    expect(await row()).toMatchObject({ calendar_id: 'zz-export-calendar', enabled: true });
  });

  it('DELETE при прочем сбое оставляет строку и говорит об этом', async () => {
    await post();
    google.deleteFailure = 'generic';

    const response = await del();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).not.toMatch('ZZ-сбой сети');
    expect(await row()).toMatchObject({ calendar_id: 'zz-export-calendar', enabled: true });
  });

  it('DELETE без строки не краснеет и в Google не ходит', async () => {
    const response = await del();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(google.deleted).toEqual([]);
  });

  it('GET показывает сломанную связь', async () => {
    await post();
    await sql`update google_export set broken_at = now() where user_id = ${USER_ID}`;

    expect(await (await get()).json()).toEqual({ enabled: true, broken: true });
  });

  it('в лог уходит только стадия — ни владельца, ни названия календаря', async () => {
    google.createFailure = 'generic';
    await post();

    expect(console.error).toHaveBeenCalledTimes(1);
    const [message] = vi.mocked(console.error).mock.calls[0];
    expect(message).not.toMatch(USER_ID);
    expect(message).not.toMatch('zz-export-calendar');
    expect(message).toMatch('export');
  });
});
