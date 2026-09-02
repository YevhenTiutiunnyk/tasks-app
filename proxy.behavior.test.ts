import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мок объявляется до импорта proxy — отсюда динамический import ниже:
// статический import наверху файла сломал бы подмену.
const getSession = vi.fn();
// Стрелка обязана принять и передать аргумент: потеряй она его, реализация,
// вызывающая getSession() без заголовков, прошла бы все тесты здесь, а в
// бою всегда получала бы null — то есть отказ входа всем подряд, незаметно.
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: (opts: unknown) => getSession(opts) } } }));

// Этот файл проверяет механику сессии и кук, а не белый список — для него
// отдельный файл, lib/proxy-gate.test.ts. Без этого мока проверка допуска
// звала бы настоящую базу за адресом, которого у здешних сессий нет.
vi.mock('@/lib/allowed-emails', () => ({
  isEmailAllowed: () => Promise.resolve(true),
  revokeSessions: vi.fn(),
}));

const { proxy } = await import('./proxy');

/**
 * Ответ getSession в форме `returnHeaders`: сессия и заголовки приходят
 * порознь. Мок обязан повторять именно эту форму — вернув голую сессию, он
 * скрыл бы от тестов сам объект, в котором Better Auth приносит свежую куку.
 */
function sessionResult(session: unknown, setCookie: string[] = []) {
  const headers = new Headers();
  for (const cookie of setCookie) headers.append('set-cookie', cookie);
  return { headers, response: session };
}

beforeEach(() => {
  getSession.mockReset();
});

describe('proxy', () => {
  it('пропускает запрос, когда сессия есть', async () => {
    getSession.mockResolvedValue(sessionResult({ user: { id: 'zz-user' } }));
    const response = await proxy(new NextRequest('https://example.test/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    // Отличаем NextResponse.next() от произвольного пустого 200: только
    // этот заголовок подтверждает, что запрос ушёл дальше по цепочке, а не
    // упёрся в подделанный руками ответ с тем же статусом.
    expect(response.headers.get('x-middleware-next')).toBe('1');
    // Без этой проверки мок мог бы терять заголовки запроса, и реализация,
    // забывшая передать их в getSession, тоже прошла бы тест.
    // returnHeaders здесь не деталь вызова, а условие: без него Better Auth
    // отдаёт одну сессию и продлённая кука до прокси не доходит вовсе.
    expect(getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      returnHeaders: true,
    });
  });

  it('доносит до браузера куку, продлённую скольжением сессии', async () => {
    // getSession по истечении updateAge продлевает строку сессии в базе и
    // кладёт свежую куку в свои заголовки. NextResponse.next() их не
    // наследует: не перенеси мы куку — срок в браузере остался бы тем, что
    // выдан при входе, и сессия умирала бы через 30 дней после входа,
    // а не после последнего визита. Молча: пользователь просто однажды
    // оказался бы на странице входа.
    getSession.mockResolvedValue(
      sessionResult({ user: { id: 'zz-user' } }, [
        'zz.session_token=fresh; Path=/; Max-Age=2592000; HttpOnly',
        'zz.session_data=cache; Path=/; Max-Age=300; HttpOnly',
      ]),
    );
    const response = await proxy(new NextRequest('https://example.test/'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    // Именно getSetCookie и весь список: кук бывает несколько, и реализация,
    // переносящая первую попавшуюся через set, потеряла бы остальные.
    expect(response.headers.getSetCookie()).toEqual([
      'zz.session_token=fresh; Path=/; Max-Age=2592000; HttpOnly',
      'zz.session_data=cache; Path=/; Max-Age=300; HttpOnly',
    ]);
  });

  it('отвечает 401 на api без сессии, а не редиректом', async () => {
    // Редирект на /login в ответ на fetch превратился бы для клиента
    // в HTML вместо JSON — и в невнятную ошибку разбора на экране.
    getSession.mockResolvedValue(sessionResult(null));
    const response = await proxy(new NextRequest('https://example.test/api/week'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Не авторизован' });
  });

  it('доносит до ответа 401 очистку протухшей куки', async () => {
    // Просроченная сессия — это тоже result.response === null, но
    // getSession успевает до этого вызвать deleteSessionCookie и оставить
    // в result.headers команду на удаление куки. Не перенеси мы её сюда —
    // браузер держал бы мёртвую куку до собственного Max-Age (до 30 дней),
    // и каждый запрос заново бил бы в базу.
    getSession.mockResolvedValue(
      sessionResult(null, ['zz.session_token=; Path=/; Max-Age=0; HttpOnly']),
    );
    const response = await proxy(new NextRequest('https://example.test/api/week'));
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([
      'zz.session_token=; Path=/; Max-Age=0; HttpOnly',
    ]);
  });

  it('уводит страницу на вход без сессии', async () => {
    getSession.mockResolvedValue(sessionResult(null));
    const response = await proxy(new NextRequest('https://example.test/settings'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.test/login');
  });

  it('доносит до редиректа на вход очистку протухшей куки', async () => {
    // Та же причина, что и в ветке 401 выше, но для страниц.
    getSession.mockResolvedValue(
      sessionResult(null, ['zz.session_token=; Path=/; Max-Age=0; HttpOnly']),
    );
    const response = await proxy(new NextRequest('https://example.test/settings'));
    expect(response.status).toBe(307);
    expect(response.headers.getSetCookie()).toEqual([
      'zz.session_token=; Path=/; Max-Age=0; HttpOnly',
    ]);
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
