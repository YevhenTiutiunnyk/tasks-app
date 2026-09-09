import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// Владельца в роутах даёт сессия better-auth. Поднимать её ради проверки
// роута незачем — подменяем помощника, как в lib/calendar-route.test.ts.
// В отличие от того файла, здесь нужна и ветка «сессии нет»: requireUser
// возвращает либо userId, либо готовый response, и оба исхода должны дойти
// до теста без подмены изнутри самого POST.
const session = vi.hoisted(() => ({
  next: { userId: 'zz-cal-sync-user' } as
    | { userId: string; response?: undefined }
    | { userId?: undefined; response: NextResponse },
}));
vi.mock('@/lib/require-user', () => ({
  requireUser: async () => session.next,
}));

// syncUser ходит в Google и в базу календарей — реальный поход не нужен,
// важно только то, что роут делает с результатом { synced, failed }.
// calendarDeps подменяется пустышкой: раз syncUser замокан целиком, она
// внутрь него не попадает вовсе.
const calendarRun = vi.hoisted(() => ({
  result: { synced: 0, failed: 0 } as { synced: number; failed: number },
}));
vi.mock('@/lib/calendar-run', () => ({
  calendarDeps: {},
  syncUser: async () => calendarRun.result,
}));

import { POST } from '@/app/api/calendar/sync/route';

const run = process.env.DATABASE_URL ? describe : describe.skip;

const USER_ID = 'zz-cal-sync-user';

function post() {
  return POST(new Request('http://localhost/api/calendar/sync', { method: 'POST' }));
}

run('/api/calendar/sync', () => {
  beforeEach(() => {
    session.next = { userId: USER_ID };
    calendarRun.result = { synced: 0, failed: 0 };
    // getTimezone(userId) в отсутствие строки user_settings отвечает
    // умолчанием без обращения к таблице user — вставлять владельца
    // в базу для этого теста не нужно.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('без сессии отдаёт то же, что вернул requireUser, и до синхронизации не доходит', async () => {
    session.next = { response: NextResponse.json({ error: 'Не авторизован' }, { status: 401 }) };
    const response = await post();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Не авторизован' });
  });

  it('успешная синхронизация возвращает synced и failed=0, лог сбоя не пишет', async () => {
    calendarRun.result = { synced: 2, failed: 0 };
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ synced: 2, failed: 0 });
    expect(console.error).not.toHaveBeenCalled();
  });

  // Находка ревью: до починки роут смотрел только на synced и молчание
  // выдавал за успех. syncCalendar после отказа помечает календарь
  // brokenAt, а планировщик такие календари молча пропускает — значит
  // ответ и лог этого запроса часто единственный след сбоя вообще.
  it('частичный сбой (failed > 0) виден и в ответе, и в логе', async () => {
    calendarRun.result = { synced: 1, failed: 1 };
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ synced: 1, failed: 1 });
    expect(console.error).toHaveBeenCalledTimes(1);
    // Только стадия — ни адреса, ни идентификатора владельца, ни названия
    // календаря в сообщении быть не должно.
    const [message] = vi.mocked(console.error).mock.calls[0];
    expect(message).not.toMatch(USER_ID);
    expect(message).toMatch('calendar');
  });
});
