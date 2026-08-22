import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from './db';

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
});
