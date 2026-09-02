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

// isEmailAllowed оборачивается, а не подменяется целиком: revokeSessions
// обязана остаться настоящей, иначе утверждения «сессии исчезли» ничего
// не проверяют. Флаг нужен ровно одному тесту — про обрыв базы.
const gate = vi.hoisted(() => ({ throwOnCheck: false }));
vi.mock('@/lib/allowed-emails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./allowed-emails')>();
  return {
    ...actual,
    isEmailAllowed: async (email: string) => {
      if (gate.throwOnCheck) throw new Error('ZZ-имитация обрыва базы');
      return actual.isEmailAllowed(email);
    },
  };
});

import { sql } from './db';
import { proxy } from '@/proxy';

const run = process.env.DATABASE_URL ? describe : describe.skip;

const ALLOWED = 'zz-gate-allowed@example.invalid';
const REVOKED = 'zz-gate-revoked@example.invalid';

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
    for (const id of [ALLOWED, REVOKED]) {
      await sql`
        insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${id}, ${id}, ${id}, false, now(), now())
        on conflict (id) do nothing
      `;
    }
    await sql`
      insert into allowed_emails (email) values (${ALLOWED}) on conflict (email) do nothing
    `;
  });

  afterAll(async () => {
    await sql`delete from session where "userId" in (${ALLOWED}, ${REVOKED})`;
    await sql`delete from allowed_emails where email = ${ALLOWED}`;
    await sql`delete from "user" where id in (${ALLOWED}, ${REVOKED})`;
  });

  beforeEach(async () => {
    session.throws = false;
    gate.throwOnCheck = false;
    session.headers = new Headers();
    await sql`delete from session where "userId" in (${ALLOWED}, ${REVOKED})`;
  });

  it('адрес в списке — пропускает и переносит куки', async () => {
    session.value = { user: { id: ALLOWED, email: ALLOWED } };
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
    session.value = { user: { id: REVOKED, email: REVOKED } };

    const response = await proxy(new NextRequest('http://localhost/settings'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('адреса нет, api — отвечает 401', async () => {
    session.value = { user: { id: REVOKED, email: REVOKED } };

    const response = await proxy(new NextRequest('http://localhost/api/week?date=2030-03-04'));

    expect(response.status).toBe(401);
  });

  it('адреса нет — сессии этого владельца сняты', async () => {
    await makeSession(REVOKED, 'zz-gate-token-1');
    await makeSession(REVOKED, 'zz-gate-token-2');
    session.value = { user: { id: REVOKED, email: REVOKED } };

    await proxy(new NextRequest('http://localhost/settings'));

    expect(await countSessions(REVOKED)).toBe(0);
  });

  it('адреса нет — сессии соседа целы', async () => {
    // Отзыв адресный. Без where по userId сосед лишился бы доступа заодно,
    // и это единственный тест, который такое поймает.
    await makeSession(ALLOWED, 'zz-gate-token-neighbour');
    await makeSession(REVOKED, 'zz-gate-token-3');
    session.value = { user: { id: REVOKED, email: REVOKED } };

    await proxy(new NextRequest('http://localhost/settings'));

    expect(await countSessions(ALLOWED)).toBe(1);
  });

  it('проверка бросила — 503, а не «пустить»', async () => {
    session.value = { user: { id: ALLOWED, email: ALLOWED } };
    gate.throwOnCheck = true;

    const response = await proxy(new NextRequest('http://localhost/settings'));

    expect(response.status).toBe(503);
  });

  it('проверка бросила — сессии НЕ сняты', async () => {
    // Обратная сторона того же случая. Моргнувшая база не должна ни пускать,
    // ни зачищать: «на всякий случай отозвать» вышибло бы всех разом.
    await makeSession(ALLOWED, 'zz-gate-token-4');
    session.value = { user: { id: ALLOWED, email: ALLOWED } };
    gate.throwOnCheck = true;

    await proxy(new NextRequest('http://localhost/settings'));

    expect(await countSessions(ALLOWED)).toBe(1);
  });
});
