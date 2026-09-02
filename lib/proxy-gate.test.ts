import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Сессию подделываем: поднимать настоящий вход через Google ради проверки
// замка незачем, а форма ответа getSession известна — { headers, response }.
const session = vi.hoisted(() => ({
  value: null as null | { user: { id: string; email: string } },
  headers: new Headers(),
  throws: false,
}));
vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => {
        if (session.throws) throw new Error('ZZ-обрыв связи с базой');
        return { headers: session.headers, response: session.value };
      },
    },
  },
}));

// isEmailAllowed и revokeSessions оборачиваются, а не подменяются целиком:
// обе обязаны остаться настоящими там, где свой флаг не выставлен, иначе
// утверждения «сессии исчезли» / «адрес найден» ничего не проверяют.
// throwOnCheck нужен ровно одному тесту — про обрыв базы при проверке
// допуска. throwOnRevoke — ровно одному про обрыв при зачистке сессий.
const gate = vi.hoisted(() => ({ throwOnCheck: false, throwOnRevoke: false }));
vi.mock('@/lib/allowed-emails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./allowed-emails')>();
  return {
    ...actual,
    isEmailAllowed: async (email: string) => {
      if (gate.throwOnCheck) throw new Error('ZZ-имитация обрыва базы');
      return actual.isEmailAllowed(email);
    },
    revokeSessions: async (userId: string) => {
      if (gate.throwOnRevoke) throw new Error('ZZ-имитация обрыва базы при отзыве');
      return actual.revokeSessions(userId);
    },
  };
});

import { sql } from './db';
import { proxy } from '@/proxy';

const run = process.env.DATABASE_URL ? describe : describe.skip;

// Личность и адрес разведены намеренно: в бою id Better Auth — случайный
// токен, а не адрес. Совпадай они текстуально, тест не отличил бы верную
// проверку isEmailAllowed(user.email) от испорченной isEmailAllowed(user.id)
// — а такая опечатка отозвала бы сессии вообще всем вошедшим на следующем
// же запросе, и весь набор остался бы зелёным.
const ALLOWED_ID = 'zz-gate-allowed-id';
const ALLOWED_EMAIL = 'zz-gate-allowed@example.invalid';
const REVOKED_ID = 'zz-gate-revoked-id';
const REVOKED_EMAIL = 'zz-gate-revoked@example.invalid';

async function countSessions(userId: string) {
  const rows = await sql`select 1 from session where "userId" = ${userId}`;
  return rows.length;
}

async function makeSession(userId: string, token: string) {
  await sql`
    insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
    values (${token}, now() + interval '30 days', ${token}, now(), now(), ${userId})
    on conflict (id) do nothing
  `;
}

run('замок: белый список на каждом запросе', () => {
  beforeAll(async () => {
    for (const [id, email] of [
      [ALLOWED_ID, ALLOWED_EMAIL],
      [REVOKED_ID, REVOKED_EMAIL],
    ] as const) {
      await sql`
        insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${id}, ${id}, ${email}, false, now(), now())
        on conflict (id) do nothing
      `;
    }
    await sql`
      insert into allowed_emails (email) values (${ALLOWED_EMAIL}) on conflict (email) do nothing
    `;
  });

  afterAll(async () => {
    await sql`delete from session where "userId" in (${ALLOWED_ID}, ${REVOKED_ID})`;
    await sql`delete from allowed_emails where email = ${ALLOWED_EMAIL}`;
    await sql`delete from "user" where id in (${ALLOWED_ID}, ${REVOKED_ID})`;
  });

  beforeEach(async () => {
    session.throws = false;
    gate.throwOnCheck = false;
    gate.throwOnRevoke = false;
    session.headers = new Headers();
    await sql`delete from session where "userId" in (${ALLOWED_ID}, ${REVOKED_ID})`;
  });

  it('адрес в списке — пропускает и переносит куки', async () => {
    session.value = { user: { id: ALLOWED_ID, email: ALLOWED_EMAIL } };
    session.headers = new Headers({ 'set-cookie': 'zz-session=1; Path=/' });

    const response = await proxy(new NextRequest('http://localhost/settings'));

    // Утверждаем по существу, а не по коду ответа: NextResponse.next() —
    // деталь реализации Next, а нам важно, что человека НЕ увели на вход
    // и что свежая кука сессии до него доехала (на ней держится скольжение
    // срока — без переноса сессия умирала бы через 30 дней после входа,
    // а не после последнего визита).
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.getSetCookie()).toContain('zz-session=1; Path=/');
  });

  it('адреса нет, страница — уводит на вход', async () => {
    session.value = { user: { id: REVOKED_ID, email: REVOKED_EMAIL } };
    session.headers = new Headers({ 'set-cookie': 'zz-session=1; Path=/' });

    const response = await proxy(new NextRequest('http://localhost/settings'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
    // Ключ от снятого замка: свежую куку скольжения, которую getSession мог
    // положить в result.headers, сюда переносить нельзя — иначе человек,
    // у которого мы только что удалили сессию, получил бы новый ключ от неё.
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('адреса нет, api — отвечает 401', async () => {
    session.value = { user: { id: REVOKED_ID, email: REVOKED_EMAIL } };

    const response = await proxy(new NextRequest('http://localhost/api/week?date=2030-03-04'));

    expect(response.status).toBe(401);
  });

  it('адреса нет — сессии этого владельца сняты', async () => {
    await makeSession(REVOKED_ID, 'zz-gate-token-1');
    await makeSession(REVOKED_ID, 'zz-gate-token-2');
    session.value = { user: { id: REVOKED_ID, email: REVOKED_EMAIL } };

    await proxy(new NextRequest('http://localhost/settings'));

    expect(await countSessions(REVOKED_ID)).toBe(0);
  });

  it('адреса нет — сессии соседа целы', async () => {
    // Отзыв адресный. Без where по userId сосед лишился бы доступа заодно,
    // и это единственный тест, который такое поймает.
    await makeSession(ALLOWED_ID, 'zz-gate-token-neighbour');
    await makeSession(REVOKED_ID, 'zz-gate-token-3');
    session.value = { user: { id: REVOKED_ID, email: REVOKED_EMAIL } };

    await proxy(new NextRequest('http://localhost/settings'));

    expect(await countSessions(ALLOWED_ID)).toBe(1);
  });

  it('проверка бросила — 503, а не «пустить»', async () => {
    session.value = { user: { id: ALLOWED_ID, email: ALLOWED_EMAIL } };
    gate.throwOnCheck = true;

    const response = await proxy(new NextRequest('http://localhost/settings'));

    expect(response.status).toBe(503);
  });

  it('проверка бросила — сессии НЕ сняты', async () => {
    // Обратная сторона того же случая. Моргнувшая база не должна ни пускать,
    // ни зачищать: «на всякий случай отозвать» вышибло бы всех разом.
    await makeSession(ALLOWED_ID, 'zz-gate-token-4');
    session.value = { user: { id: ALLOWED_ID, email: ALLOWED_EMAIL } };
    gate.throwOnCheck = true;

    await proxy(new NextRequest('http://localhost/settings'));

    expect(await countSessions(ALLOWED_ID)).toBe(1);
  });

  it('отзыв бросил — всё равно отказ, а не необработанная ошибка', async () => {
    // Обрыв базы между решением «адреса нет» и попыткой снять сессии не
    // должен ни впустить человека (отказ уже решён), ни уронить прокси
    // 500-кой вместо честного 307/401 — тогда потерялась бы и запись
    // в логе, единственный след отзыва во всей системе.
    session.value = { user: { id: REVOKED_ID, email: REVOKED_EMAIL } };
    gate.throwOnRevoke = true;

    const page = await proxy(new NextRequest('http://localhost/settings'));
    expect(page.status).toBe(307);

    const api = await proxy(new NextRequest('http://localhost/api/week?date=2030-03-04'));
    expect(api.status).toBe(401);
  });
});
