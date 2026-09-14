import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Владельца в роуте даёт сессия better-auth — подменяем помощника, как
// в lib/calendar-route.test.ts.
const session = vi.hoisted(() => ({ userId: 'zz-cmd-owner' }));
vi.mock('@/lib/require-user', () => ({
  requireUser: async () => ({ userId: session.userId }),
}));

// Разбор фразы — настоящий поход к Anthropic, платный и недетерминированный.
// Подменяем модуль целиком: тест управляет тем, какие операции «распознала»
// модель, через parseMock.operations.
const parseMock = vi.hoisted(() => ({
  operations: [] as unknown[],
}));
vi.mock('@/lib/parse', () => ({
  parseCommand: async () => ({
    reply: 'ZZ-готово',
    operations: parseMock.operations,
    needsTime: [],
  }),
}));

// Толчок выгрузки зовёт after() из Next, а тот вне настоящего запроса бросает.
// Подменяем модуль — и заодно видим, что роут толкает выгрузку своему владельцу.
const exportNowMock = vi.hoisted(() => ({ scheduled: [] as string[] }));
vi.mock('@/lib/export-now', () => ({
  scheduleExport: (userId: string) => { exportNowMock.scheduled.push(userId); },
}));

import { saveUserKey, sql } from '@/lib/db';
import { encryptApiKey } from '@/lib/user-key';
import { POST } from '@/app/api/command/route';
import type { Operation } from '@/lib/types';

const run = process.env.DATABASE_URL ? describe : describe.skip;

const USER_ID = 'zz-cmd-owner';
const TODAY = '2031-03-03'; // понедельник — весь контекст (3 недели) гарантированно накрывает эту дату

function createOp(title: string, date: string): Operation {
  return {
    type: 'create', title, date, startMinute: null, durationMinutes: null,
    allDay: true, categoryId: null, recurrence: null, horizon: null,
  };
}

function post(text: string) {
  return POST(new Request('http://localhost/api/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, today: TODAY, timezone: 'Europe/Amsterdam' }),
  }));
}

// Находка I4 финального ревью: наложение считалось по ВСЕМ задачам
// трёхнедельного окна вместо тех, кого коснулась именно эта фраза.
// Значит человек, продиктовавший «купи молоко», получал список ВСЕХ старых
// наложений за три недели — одинаковый после каждой фразы, а предупреждение,
// которое повторяется всегда, перестают читать.
run('/api/command — I4: наложение только по изменённым задачам', () => {
  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${USER_ID}, 'ZZ-роут-команды', 'zz-cmd-route@example.invalid', false, now(), now())
      on conflict (id) do nothing
    `;
    // clientForUser требует читаемый ключ — сам разбор замокан, но роут
    // проверяет наличие ключа до вызова parseCommand.
    await saveUserKey(USER_ID, encryptApiKey(USER_ID, 'sk-ant-zz-test-key'));
    await sql`
      insert into google_calendars (user_id, calendar_id, summary, selected)
      values (${USER_ID}, 'primary', 'ZZ-основной', true)
      on conflict (user_id, calendar_id) do update set selected = true
    `;
  });

  beforeEach(async () => {
    await sql`delete from tasks where user_id = ${USER_ID}`;
    await sql`delete from command_log where user_id = ${USER_ID}`;
    await sql`delete from google_events where user_id = ${USER_ID}`;
    // recurrence_exceptions уходит каскадом за recurrences (on delete cascade).
    await sql`delete from recurrences where user_id = ${USER_ID}`;

    // Встреча 09:00–10:00 UTC = 10:00–11:00 по Амстердаму (март, ещё зима).
    await sql`
      insert into google_events (
        user_id, calendar_id, event_id, title, starts_at, ends_at,
        all_day, mine, organizer_email, google_updated_at)
      values (
        ${USER_ID}, 'primary', 'ev1', 'ZZ-Событие',
        '2031-03-03T09:00:00.000Z', '2031-03-03T10:00:00.000Z',
        false, true, null, now())
    `;
    // Задача уже лежит поверх этой встречи (10:00–11:00 локально), но
    // сегодняшняя фраза её не касается вовсе.
    await sql`
      insert into tasks (title, date, start_minute, duration_minutes, all_day, category_id, horizon, user_id)
      values ('ZZ-Старая-встреча', ${TODAY}, 600, 60, false, null, 'day', ${USER_ID})
    `;
  });

  afterAll(async () => {
    await sql`delete from tasks where user_id = ${USER_ID}`;
    await sql`delete from command_log where user_id = ${USER_ID}`;
    await sql`delete from google_events where user_id = ${USER_ID}`;
    await sql`delete from recurrences where user_id = ${USER_ID}`;
    await sql`delete from google_calendars where user_id = ${USER_ID}`;
    await sql`delete from user_api_keys where user_id = ${USER_ID}`;
    // Роут пишет пояс при первом же POST (см. saveTimezone в app/api/command/route.ts).
    await sql`delete from user_settings where user_id = ${USER_ID}`;
    await sql`delete from "user" where id = ${USER_ID}`;
  });

  it('задача, которой фраза не касалась, не попадает в наложения, даже лёжа поверх встречи', async () => {
    // Фраза создаёт целодневную задачу — сама по себе никогда не может
    // наложиться (findOverlaps пропускает allDay). Единственный кандидат
    // на наложение в базе — ZZ-Старая-встреча, которую эта фраза не трогала.
    parseMock.operations = [createOp('ZZ-Купить молоко', TODAY)];

    const response = await post('купи молоко');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.overlaps).toEqual([]);
  });

  // Находка 3 второго круга финального ревью: положительный случай не был
  // закрыт ничем — обнуление списка затронутых задач в роуте (то есть
  // полное выключение функции) оставляло все тесты зелёными.
  it('фраза, создавшая задачу поверх встречи, показывает наложение с обоими названиями', async () => {
    parseMock.operations = [{
      type: 'create', title: 'ZZ-Врач', date: TODAY, startMinute: 600, durationMinutes: 60,
      allDay: false, categoryId: null, recurrence: null, horizon: null,
    }];

    const response = await post('запиши к врачу в 10');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.overlaps).toEqual([{ taskTitle: 'ZZ-Врач', eventTitle: 'ZZ-Событие' }]);
  });

  // Находка 2 второго круга финального ревью: create с recurrence кладёт
  // идентификатор только в snapshot.recurrences, а вхождения серии в
  // загруженном диапазоне — синтетические (occ:<правило>:<дата>), их нет
  // в snapshot.tasks никогда. Ревьюер проверил на живой базе: фраза
  // «тренировка по понедельникам 10:30» поверх встречи 10:00–11:00 давала
  // ПУСТОЙ список наложений вместо верного предупреждения — регрессия,
  // а не убранный шум.
  it('вхождение только что созданного повтора проверяется на наложение', async () => {
    parseMock.operations = [{
      type: 'create', title: 'ZZ-Тренировка', date: null, startMinute: 630, durationMinutes: 60,
      allDay: false, categoryId: null,
      // TODAY — понедельник (weekday 1); правило стартует в тот же день,
      // поэтому первое же вхождение приходится ровно на TODAY.
      recurrence: { weekdays: [1], startsOn: TODAY, endsOn: null },
      horizon: null,
    }];

    const response = await post('тренировка по понедельникам 10:30');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.overlaps).toEqual([{ taskTitle: 'ZZ-Тренировка', eventTitle: 'ZZ-Событие' }]);
  });

  // Правка обязана уезжать в Google сразу, а не ждать пятиминутного прохода
  // планировщика — ровно ради этого толчок и заведён.
  it('команда толкает выгрузку в Google для своего владельца', async () => {
    exportNowMock.scheduled = [];
    parseMock.operations = [createOp('ZZ-Толчок', TODAY)];

    const response = await post('ZZ-толчок выгрузки');
    expect(response.status).toBe(200);
    expect(exportNowMock.scheduled).toEqual([USER_ID]);
  });
});
