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

import { readFileSync } from 'node:fs';
import { sql } from '@/lib/db';
import { DELETE, GET, POST } from '@/app/api/calendar/export/route';
// Функция, а не компонент: рендерить нечем (jsdom в проекте нет), а весь
// двухшаговый механизм выключения лежит именно в ней.
import { pressExportOff } from '@/app/settings/google-calendar';

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

  it('POST при СЛОМАННОЙ выгрузке второго календаря тоже не заводит', async () => {
    await post();
    // broken_at ставит планировщик — в том числе на потерю доступа
    // (lib/export-run.ts), когда календарь в Google жив-здоров.
    await sql`update google_export set broken_at = now() where user_id = ${USER_ID}`;
    google.created = [];

    const response = await post();

    // Заведи мы здесь новый календарь, enableExport перенацелил бы
    // calendar_id — и живое первое «Расписание» осталось бы в Google
    // навсегда без единого указателя с нашей стороны. Та же беда, от которой
    // защищает порядок в DELETE, только с парадного входа (находка ревью).
    expect(response.status).toBe(200);
    expect(google.created).toEqual([]);
    expect(await row()).toMatchObject({ calendar_id: 'zz-export-calendar' });
  });

  it('POST при сбое базы ПОСЛЕ создания календаря не врёт, что календаря нет', async () => {
    // Строка не вставится: владельца больше нет, а user_id в google_export —
    // внешний ключ на "user". Календарь при этом в Google уже создан.
    await sql`delete from "user" where id = ${USER_ID}`;

    const response = await post();

    expect(response.status).toBe(500);
    expect(google.created).toEqual(['Расписание']);
    const body = await response.json();
    // «Не удалось завести календарь в Google» здесь было бы ложью: календарь
    // заведён, и человек, поверив, никогда не пошёл бы искать сироту.
    expect(body.error).not.toBe('Не удалось завести календарь в Google');
    expect(body.error).toMatch('Расписание');
    expect(body.error).toMatch(/руками/);
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
    // enabled: true здесь не украшение. Без него проверка держится только
    // на том, что disableExport удаляет строку физически: сделай кто-нибудь
    // выключение мягким (enabled = false), и перестановка шагов снова
    // проходила бы мимо теста (находка ревью).
    expect(rowAtGoogleCall).toMatchObject({ calendar_id: 'zz-export-calendar', enabled: true });
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

  it('одно нажатие «Выключить» НЕ удаляет ни календарь в Google, ни строку', async () => {
    await post();

    // pressExportOff — весь двухшаговый механизм кнопки целиком, взятый
    // из самого экрана. turnOff здесь — настоящее выключение, роутом
    // и базой: если механизм когда-нибудь схлопнут обратно в одно касание,
    // календарь удалится прямо здесь и тест покраснеет.
    let armed = false;
    const setArmed = (next: boolean) => { armed = next; };
    const turnOff = async () => { await del(); };

    pressExportOff(armed, setArmed, () => void turnOff());

    expect(armed).toBe(true);
    expect(google.deleted).toEqual([]);
    expect(await row()).toMatchObject({ calendar_id: 'zz-export-calendar', enabled: true });

    // Второе нажатие — то самое осознанное подтверждение, и вот оно уже
    // удаляет. Без этой половины тест был бы зелёным и у кнопки, которая
    // не работает вовсе.
    pressExportOff(armed, setArmed, () => void turnOff());
    await vi.waitFor(async () => expect(await row()).toBeUndefined());

    expect(armed).toBe(false);
    expect(google.deleted).toEqual(['zz-export-calendar']);
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

/**
 * Проверки по исходнику экрана. Рендерить его нечем — jsdom в проекте нет,
 * — но две вещи слишком дороги, чтобы держаться на одной ничем не защищённой
 * строке (находка ревью: расширение разрешения до полного доступа оставляло
 * все 507 тестов зелёными).
 *
 * База этим тестам не нужна, поэтому они идут без run-гейта.
 */
describe('экран настроек: разрешение и возврат с согласия', () => {
  const source = readFileSync(
    new URL('../app/settings/google-calendar.tsx', import.meta.url),
    'utf8',
  );

  it('просит только чтение и календари, созданные приложением', () => {
    const scopes = [...source.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[\w.]+/g)]
      .map(([scope]) => scope);

    // Именно на этой строке держится обещание, ради которого всё и затевалось:
    // calendar.app.created ТЕХНИЧЕСКИ не даёт власти над чужими встречами
    // человека, а calendar и calendar.events — дают. Список закреплён целиком,
    // а не поиском запрещённого: так красным станет и добавление нового
    // разрешения, которого никто не обсуждал.
    expect(new Set(scopes)).toEqual(new Set([
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.app.created',
    ]));
  });

  it('после возврата с согласия сам делает запрос — и тот, за которым шли', () => {
    // Без запроса отсюда человек увидел бы «согласие дано» и пустой Google:
    // само согласие календаря не создаёт.
    expect(source).toMatch('sessionStorage.getItem(EXPORT_PENDING_KEY)');
    expect(source).toMatch("fetch('/api/calendar/export', { method })");

    // Намерение решает метод. Пока его не было, согласие, взятое ради
    // неудавшегося ВЫКЛЮЧЕНИЯ, возвращалось включением: заводился второй
    // календарь, а первый, живой, оставался в Google без указателя.
    expect(source).toMatch("intent === EXPORT_INTENT_ENABLE ? 'POST' : 'DELETE'");
    expect(source).toMatch('askExportConsent(EXPORT_INTENT_DISABLE)');
  });

  it('выключение идёт только через двухшаговое подтверждение', () => {
    // Тест выше проверяет сам механизм, но мимо него можно пройти: хватит
    // повесить выключение на кнопку напрямую, и pressExportOff останется
    // проверенной и никем не вызванной. Поэтому здесь — про проводку.
    const presses = [...source.matchAll(/turnExportOff\(\)/g)].length;
    const throughConfirm = [...source.matchAll(
      /pressExportOff\(exportOffArmed, setExportOffArmed, \(\) => void turnExportOff\(\)\)/g,
    )].length;

    // Объявление функции плюс её вызовы из кнопок: все до единого — через
    // подтверждение.
    expect(presses).toBe(throughConfirm + 1);
    expect(throughConfirm).toBeGreaterThan(0);
  });
});
