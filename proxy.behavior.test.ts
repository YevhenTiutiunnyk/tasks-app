import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мок объявляется до импорта proxy — отсюда динамический import ниже:
// статический import наверху файла сломал бы подмену.
const getSession = vi.fn();
// Стрелка обязана принять и передать аргумент: потеряй она его, реализация,
// вызывающая getSession() без заголовков, прошла бы все тесты здесь, а в
// бою всегда получала бы null — то есть отказ входа всем подряд, незаметно.
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: (opts: unknown) => getSession(opts) } } }));

const { proxy } = await import('./proxy');

beforeEach(() => {
  getSession.mockReset();
});

describe('proxy', () => {
  it('пропускает запрос, когда сессия есть', async () => {
    getSession.mockResolvedValue({ user: { id: 'zz-user' } });
    const response = await proxy(new NextRequest('https://example.test/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    // Отличаем NextResponse.next() от произвольного пустого 200: только
    // этот заголовок подтверждает, что запрос ушёл дальше по цепочке, а не
    // упёрся в подделанный руками ответ с тем же статусом.
    expect(response.headers.get('x-middleware-next')).toBe('1');
    // Без этой проверки мок мог бы терять заголовки запроса, и реализация,
    // забывшая передать их в getSession, тоже прошла бы тест.
    expect(getSession).toHaveBeenCalledWith({ headers: expect.any(Headers) });
  });

  it('отвечает 401 на api без сессии, а не редиректом', async () => {
    // Редирект на /login в ответ на fetch превратился бы для клиента
    // в HTML вместо JSON — и в невнятную ошибку разбора на экране.
    getSession.mockResolvedValue(null);
    const response = await proxy(new NextRequest('https://example.test/api/week'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Не авторизован' });
  });

  it('уводит страницу на вход без сессии', async () => {
    getSession.mockResolvedValue(null);
    const response = await proxy(new NextRequest('https://example.test/settings'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.test/login');
  });

  it('отвечает 503, а не редиректом, когда база недоступна', async () => {
    // Обрыв связи с Postgres — не отсутствие сессии. Редирект на /login тут
    // выбросил бы и уже вошедшего пользователя, а вход всё равно не сработал
    // бы без той же базы — дорога в никуда. Проверяем это и для страницы, и
    // для api: развилка 401/307 в этой ветке не участвует.
    getSession.mockRejectedValue(new Error('connection refused'));
    const page = await proxy(new NextRequest('https://example.test/settings'));
    expect(page.status).toBe(503);
    expect(page.headers.get('location')).toBeNull();
    await expect(page.json()).resolves.toEqual({ error: 'Сервис временно недоступен' });

    getSession.mockRejectedValue(new Error('connection refused'));
    const api = await proxy(new NextRequest('https://example.test/api/week'));
    expect(api.status).toBe(503);
    await expect(api.json()).resolves.toEqual({ error: 'Сервис временно недоступен' });
  });
});
