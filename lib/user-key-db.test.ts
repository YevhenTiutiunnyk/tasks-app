import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from './db';
import { encryptApiKey } from './user-key';
import {
  clearUserKey,
  getUserKey,
  hasUserKey,
  registerKeyFailure,
  saveUserKey,
} from './db';

// Файл ходит в базу. Без DATABASE_URL в окружении (обычный `npx vitest run`)
// пропускаем — тот же приём, что в db.test.ts и ownership.test.ts.
const run = process.env.DATABASE_URL ? describe : describe.skip;

const USER_ID = 'zz-key-db-user';
const EMAIL = 'zz-key-db@example.invalid';

run('user_api_keys', () => {
  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${USER_ID}, 'ZZ-ключи', ${EMAIL}, false, now(), now())
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    // Адресно, по своему владельцу. Никаких delete без условий.
    await sql`delete from user_api_keys where user_id = ${USER_ID}`;
    await sql`delete from "user" where id = ${USER_ID}`;
  });

  it('не даёт записать полустрочку: шифротекст есть, вектора нет', async () => {
    await expect(
      sql`
        insert into user_api_keys (user_id, key_ciphertext, failed_attempts)
        values (${USER_ID}, ${Buffer.from('ZZ-шифротекст')}, 0)
      `,
    ).rejects.toThrow();
  });

  it('принимает строку вообще без ключа — счётчику попыток это и нужно', async () => {
    await sql`
      insert into user_api_keys (user_id, failed_attempts)
      values (${USER_ID}, 3)
      on conflict (user_id) do update set failed_attempts = 3
    `;
    const [row] = await sql`select * from user_api_keys where user_id = ${USER_ID}`;
    expect(row.failed_attempts).toBe(3);
    expect(row.key_ciphertext).toBeNull();
    expect(row.key_set_at).toBeNull();
  });

  it('сохраняет, читает и убирает ключ', async () => {
    const secret = 'sk-ant-zz-ключ-для-теста-базы';
    await saveUserKey(USER_ID, encryptApiKey(USER_ID, secret));

    const row = await getUserKey(USER_ID);
    expect(row?.present).toBe(true);
    expect(row?.keySetAt).toBeInstanceOf(Date);
    expect(await hasUserKey(USER_ID)).toBe(true);

    await clearUserKey(USER_ID);
    const cleared = await getUserKey(USER_ID);
    expect(cleared?.present).toBe(false);
    expect(cleared?.keySetAt).toBeNull();
    expect(await hasUserKey(USER_ID)).toBe(false);
  });

  it('DELETE не сбрасывает счётчик — иначе это лазейка из паузы', async () => {
    await sql`
      update user_api_keys set failed_attempts = 4 where user_id = ${USER_ID}
    `;
    await saveUserKey(USER_ID, encryptApiKey(USER_ID, 'sk-ant-zz-ещё-один'));
    await clearUserKey(USER_ID);
    const row = await getUserKey(USER_ID);
    // saveUserKey счётчик обнуляет (успех), clearUserKey — не трогает.
    expect(row?.failedAttempts).toBe(0);

    await sql`update user_api_keys set failed_attempts = 4 where user_id = ${USER_ID}`;
    await clearUserKey(USER_ID);
    expect((await getUserKey(USER_ID))?.failedAttempts).toBe(4);
  });

  it('успешное сохранение обнуляет счётчик и снимает паузу', async () => {
    await sql`
      update user_api_keys
      set failed_attempts = 5, locked_until = now() + interval '1 hour'
      where user_id = ${USER_ID}
    `;
    await saveUserKey(USER_ID, encryptApiKey(USER_ID, 'sk-ant-zz-третий'));
    const row = await getUserKey(USER_ID);
    expect(row?.failedAttempts).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });

  it('пятая неудача подряд запирает на час', async () => {
    await sql`delete from user_api_keys where user_id = ${USER_ID}`;
    let last = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < 5; i += 1) {
      last = await registerKeyFailure(USER_ID, 5, 3600);
    }
    expect(last.failedAttempts).toBe(5);
    expect(last.lockedUntil).toBeInstanceOf(Date);
    expect(last.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('четвёртая неудача ещё не запирает', async () => {
    await sql`delete from user_api_keys where user_id = ${USER_ID}`;
    let last = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < 4; i += 1) {
      last = await registerKeyFailure(USER_ID, 5, 3600);
    }
    expect(last.failedAttempts).toBe(4);
    expect(last.lockedUntil).toBeNull();
  });

  it('истёкшая пауза начинает новую серию, а не запирает сразу', async () => {
    // Без сброса счётчик рос бы дальше пяти, и первый же промах после
    // окончания паузы запирал бы снова — то есть пауза стала бы вечной.
    await sql`delete from user_api_keys where user_id = ${USER_ID}`;
    await sql`
      insert into user_api_keys (user_id, failed_attempts, locked_until)
      values (${USER_ID}, 5, now() - interval '1 minute')
    `;
    const after = await registerKeyFailure(USER_ID, 5, 3600);
    expect(after.failedAttempts).toBe(1);
    expect(after.lockedUntil).toBeNull();
  });
});
