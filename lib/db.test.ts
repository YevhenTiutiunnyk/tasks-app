import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { getSettings, saveSettings, sql } from './db';

const run = process.env.DATABASE_URL ? describe : describe.skip;

// Свой пользователь, а не владелец расписания: настройки теперь у каждого
// свои, и тест, который сохраняет и восстанавливает, работал бы на живой
// строке — при падении посередине она осталась бы с тестовым «про меня».
// Домен .invalid зарезервирован стандартом и не может принадлежать человеку.
const EMAIL = 'zz-settings@example.invalid';

run('settings', () => {
  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${EMAIL}, ${EMAIL}, ${EMAIL}, false, now(), now())
      on conflict (id) do nothing
    `;
  });

  // `sql` is a module-level connection pool shared by every test in this
  // file, so it must be closed exactly once after all of them finish —
  // closing it inside an individual test would kill the pool for whichever
  // test runs after it.
  afterAll(async () => {
    // Только свои строки, и настройки раньше пользователя: ссылка стоит
    // с on delete restrict.
    await sql`delete from user_settings where user_id = ${EMAIL}`;
    await sql`delete from "user" where email = ${EMAIL}`;
    await sql.end();
  });

  it('читает строку настроек с категориями по умолчанию', async () => {
    const settings = await getSettings(EMAIL);
    expect(settings.workStartMinute).toBe(540);
    expect(settings.workEndMinute).toBe(1080);
    expect(settings.categories.map((c) => c.id)).toContain('work');
  });

  it('сохраняет и читает обратно', async () => {
    const before = await getSettings(EMAIL);
    await saveSettings(EMAIL, { ...before, aboutMe: 'встаю в 7' });
    expect((await getSettings(EMAIL)).aboutMe).toBe('встаю в 7');
    await saveSettings(EMAIL, before);
  });
});
