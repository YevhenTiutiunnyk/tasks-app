import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from './db';
import { getSettings, getTasksBetween, saveSettings } from './db';
import { DEFAULT_SETTINGS } from './settings-defaults';

// Тестовые пользователи заводятся в БОЕВОЙ таблице "user" — другой базы нет.
// Домен .invalid зарезервирован стандартом и не может принадлежать человеку.
const A = 'zz-owner-a@example.invalid';
const B = 'zz-owner-b@example.invalid';
// Диапазон 2030 года — как в lib/apply.test.ts, чтобы не пересечься с живыми.
const DATE = '2030-03-04';

let idA = '';
let idB = '';

beforeAll(async () => {
  for (const email of [A, B]) {
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${email}, ${email}, ${email}, false, now(), now())
      on conflict (id) do nothing
    `;
  }
  idA = A;
  idB = B;
  await sql`
    insert into tasks (title, date, all_day, user_id)
    values ('ZZ-задача A', ${DATE}, true, ${idA}), ('ZZ-задача B', ${DATE}, true, ${idB})
  `;
});

afterAll(async () => {
  // Только свои строки. delete без условий здесь стоил бы владельцу расписания.
  await sql`delete from tasks where user_id in (${idA}, ${idB})`;
  await sql`delete from user_settings where user_id in (${idA}, ${idB})`;
  await sql`delete from "user" where email in (${A}, ${B})`;
  await sql.end();
});

describe('изоляция чтения', () => {
  it('задачи одного не видны другому', async () => {
    const forA = await getTasksBetween(idA, DATE, DATE);
    expect(forA.map((t) => t.title)).toEqual(['ZZ-задача A']);
    const forB = await getTasksBetween(idB, DATE, DATE);
    expect(forB.map((t) => t.title)).toEqual(['ZZ-задача B']);
  });

  it('у нового человека настройки — умолчания, а не чужие', async () => {
    expect(await getSettings(idA)).toEqual(DEFAULT_SETTINGS);
  });

  it('сохранённые настройки не протекают к другому', async () => {
    await saveSettings(idA, { ...DEFAULT_SETTINGS, aboutMe: 'ZZ-только для A' });
    expect((await getSettings(idA)).aboutMe).toBe('ZZ-только для A');
    expect((await getSettings(idB)).aboutMe).toBe(DEFAULT_SETTINGS.aboutMe);
  });
});
