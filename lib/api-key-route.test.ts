import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Владельца в роутах даёт сессия better-auth. Поднимать её ради проверки
// роутов незачем — подменяем помощника, как в lib/ownership.test.ts.
const session = vi.hoisted(() => ({ userId: 'zz-key-route-user' }));
vi.mock('@/lib/require-user', () => ({
  requireUser: async () => ({ userId: session.userId }),
}));

// Проверка ключа ходит в Anthropic и стоит денег. Подменяем модуль целиком
// и задаём исход из теста.
const verdict = vi.hoisted(() => ({
  next: { kind: 'ok' } as
    | { kind: 'ok' }
    | { kind: 'rejected'; status: number; message: string }
    | { kind: 'refused'; status: number; message: string },
  calls: 0,
}));
vi.mock('@/lib/verify-key', () => ({
  verifyApiKey: async () => {
    verdict.calls += 1;
    return verdict.next;
  },
}));

import { sql } from '@/lib/db';
import { DELETE, GET, PUT } from '@/app/api/key/route';

const run = process.env.DATABASE_URL ? describe : describe.skip;

const USER_ID = 'zz-key-route-user';
const GOOD_KEY = 'sk-ant-zz-достаточно-длинный-ненастоящий-ключ';

function put(key: unknown) {
  return PUT(
    new Request('http://localhost/api/key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    }),
  );
}

run('/api/key', () => {
  beforeEach(async () => {
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${USER_ID}, 'ZZ-роут', 'zz-key-route@example.invalid', false, now(), now())
      on conflict (id) do nothing
    `;
    await sql`delete from user_api_keys where user_id = ${USER_ID}`;
    verdict.calls = 0;
    verdict.next = { kind: 'ok' };
  });

  afterAll(async () => {
    await sql`delete from user_api_keys where user_id = ${USER_ID}`;
    await sql`delete from "user" where id = ${USER_ID}`;
  });

  it('GET без ключа — present false и ни байта материала', async () => {
    const body = await (await GET(new Request('http://localhost/api/key'))).json();
    expect(body).toEqual({ present: false, keySetAt: null, lockedUntil: null });
  });

  it('PUT с рабочим ключом сохраняет его', async () => {
    expect((await put(GOOD_KEY)).status).toBe(200);
    const body = await (await GET(new Request('http://localhost/api/key'))).json();
    expect(body.present).toBe(true);
    expect(typeof body.keySetAt).toBe('string');
  });

  it('GET никогда не отдаёт материал ключа', async () => {
    await put(GOOD_KEY);
    const text = await (await GET(new Request('http://localhost/api/key'))).text();
    // Утверждение на весь ответ целиком, а не на отсутствие конкретного поля:
    // так его не обойдёт новое поле, добавленное позже.
    expect(text).not.toContain(GOOD_KEY);
    expect(text).not.toContain('sk-ant');
  });

  it('слишком короткий ключ до Anthropic не доходит', async () => {
    const response = await put('sk-ant-1');
    expect(response.status).toBe(400);
    expect(verdict.calls).toBe(0);
  });

  it('ключ с пробелом внутри до Anthropic не доходит', async () => {
    const response = await put('sk-ant-zz достаточно длинный ключ с пробелами');
    expect(response.status).toBe(400);
    expect(verdict.calls).toBe(0);
  });

  it('пятая подряд 401 запирает на час', async () => {
    verdict.next = { kind: 'rejected', status: 400, message: 'ZZ-не принят' };
    for (let i = 0; i < 4; i += 1) {
      expect((await put(GOOD_KEY)).status).toBe(400);
    }
    const fifth = await put(GOOD_KEY);
    expect(fifth.status).toBe(400);
    expect((await fifth.json()).lockedUntil).toBeTruthy();

    // Шестая попытка уже не доходит до Anthropic.
    const callsBefore = verdict.calls;
    const sixth = await put(GOOD_KEY);
    expect(sixth.status).toBe(429);
    expect(verdict.calls).toBe(callsBefore);
  });

  it('пять подряд 403 не запирают', async () => {
    verdict.next = { kind: 'refused', status: 400, message: 'ZZ-нет средств' };
    for (let i = 0; i < 5; i += 1) {
      expect((await put(GOOD_KEY)).status).toBe(400);
    }
    const [row] = await sql`select * from user_api_keys where user_id = ${USER_ID}`;
    expect(row?.failed_attempts ?? 0).toBe(0);
    expect(row?.locked_until ?? null).toBeNull();
  });

  it('DELETE убирает ключ, но не счётчик', async () => {
    verdict.next = { kind: 'rejected', status: 400, message: 'ZZ-не принят' };
    await put(GOOD_KEY);
    await put(GOOD_KEY);
    verdict.next = { kind: 'ok' };
    await put(GOOD_KEY);
    await sql`update user_api_keys set failed_attempts = 3 where user_id = ${USER_ID}`;

    expect((await DELETE(new Request('http://localhost/api/key', { method: 'DELETE' }))).status)
      .toBe(200);

    const [row] = await sql`select * from user_api_keys where user_id = ${USER_ID}`;
    expect(row.key_ciphertext).toBeNull();
    // Исчезни счётчик вместе со строкой — «убрать ключ» стало бы лазейкой
    // из часовой паузы.
    expect(row.failed_attempts).toBe(3);
  });
});
