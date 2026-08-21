import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Связка «сессия → session.user.id» не проверялась нигде: во всех тестах
// изоляции (lib/ownership.test.ts) requireUser подменён целиком — там важно,
// что роут делает с уже названным владельцем, а не откуда владелец берётся.
// Значит, единственное место, где эта связка написана, до сих пор держалось
// на типах. Здесь она проверяется по-настоящему, а подменяется то, что ниже
// неё, — better-auth.
//
// Подмена объявляется до импорта require-user, отсюда динамический import:
// статический import наверху файла случился бы раньше vi.mock.
const getSession = vi.fn();
// Стрелка обязана принять и передать аргумент: потеряй она его, реализация,
// зовущая getSession() без заголовков, прошла бы тесты здесь, а в бою
// получала бы null всегда — то есть 401 всем подряд.
vi.mock('./auth', () => ({ auth: { api: { getSession: (opts: unknown) => getSession(opts) } } }));

const { requireUser } = await import('./require-user');
// Тот же самый lib/auth: proxy импортирует его через алиас '@', requireUser —
// относительным путём, но подмена одна на обоих, потому что ведёт к одному
// файлу. Нужен здесь proxy ровно для одной проверки — что тело отказа
// у роута и у прокси совпадает буквально, а не «на вид».
const { proxy } = await import('../proxy');

/** Запрос с кукой сессии — как его видит роут. */
function requestWithCookie() {
  return new Request('http://t/api/week', {
    headers: { cookie: 'zz.session_token=zz-token' },
  });
}

beforeEach(() => {
  getSession.mockReset();
});

describe('requireUser', () => {
  it('отдаёт владельца из сессии', async () => {
    getSession.mockResolvedValue({ user: { id: 'zz-user' }, session: { id: 'zz-session' } });

    const result = await requireUser(requestWithCookie());
    expect(result.userId).toBe('zz-user');
    // Не «просто нет отказа»: роуты различают ветки по наличию response,
    // и лишний response при живой сессии закрыл бы доступ всем.
    expect(result.response).toBeUndefined();

    // Заголовки не просто «какие-нибудь», а именно заголовки запроса:
    // реализация, собравшая новые пустые, тоже вернула бы Headers.
    const passed = getSession.mock.calls[0][0] as { headers: Headers };
    expect(passed.headers.get('cookie')).toBe('zz.session_token=zz-token');
  });

  it('без сессии отвечает 401 тем же телом, что и proxy.ts', async () => {
    getSession.mockResolvedValue(null);

    const result = await requireUser(requestWithCookie());
    expect(result.userId).toBeUndefined();
    expect(result.response!.status).toBe(401);
    const body = await result.response!.json();
    expect(body).toEqual({ error: 'Не авторизован' });

    // Ответ прокси на api без сессии берётся не из памяти, а из самого
    // proxy.ts: разъедься эти два тела — и клиент, разбирающий отказ,
    // получал бы разное в зависимости от того, кто именно отказал.
    getSession.mockResolvedValue({ headers: new Headers(), response: null });
    const fromProxy = await proxy(new NextRequest('https://example.test/api/week'));
    expect(fromProxy.status).toBe(401);
    await expect(fromProxy.json()).resolves.toEqual(body);
  });

  it('отвечает 401, когда в сессии нет user.id', async () => {
    // Сессия есть, а владельца в ней нет — форма, которой не должно быть,
    // но именно на ней «угадывание» и было бы опасным: роут, взявший
    // undefined за идентификатор, отфильтровал бы запрос по нему и показал
    // бы пусто вместо отказа, а запись ушла бы в ничьи строки.
    for (const session of [
      { session: { id: 'zz-session' } },
      { user: {}, session: { id: 'zz-session' } },
      { user: { id: '' }, session: { id: 'zz-session' } },
    ]) {
      getSession.mockResolvedValue(session);
      const result = await requireUser(requestWithCookie());
      expect(result.userId).toBeUndefined();
      expect(result.response!.status).toBe(401);
      await expect(result.response!.json()).resolves.toEqual({ error: 'Не авторизован' });
    }
  });

  it('не превращает сбой базы в 401, а даёт ошибке всплыть', async () => {
    // Записанное решение (см. комментарий в require-user.ts): моргнувшая база
    // должна кончиться пятисоткой, которую видно, а не тихим «не авторизован»,
    // по которому человека молча выкидывает на страницу входа.
    getSession.mockRejectedValue(new Error('connection refused'));
    await expect(requireUser(requestWithCookie())).rejects.toThrow('connection refused');
  });
});
