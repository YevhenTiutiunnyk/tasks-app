import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { getSettings, getTasksBetween, saveSettings, sql } from './db';

const run = process.env.DATABASE_URL ? describe : describe.skip;

// Свой пользователь, а не владелец расписания: настройки теперь у каждого
// свои, и тест, который сохраняет и восстанавливает, работал бы на живой
// строке — при падении посередине она осталась бы с тестовым «про меня».
// Домен .invalid зарезервирован стандартом и не может принадлежать человеку.
const EMAIL = 'zz-settings@example.invalid';
// 2030 год — как в остальных файлах с базой, чтобы не пересечься с живыми
// датами, даже окажись строка подключения не той.
const DATE = '2030-05-06';

// Один внешний блок на весь файл: `sql` — это пул уровня модуля, общий на все
// тесты здесь, и закрыть его нужно ровно один раз после всех. Заведи второй
// describe верхнего уровня — его первый запрос пришёл бы уже в закрытый пул.
run('lib/db', () => {
  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${EMAIL}, ${EMAIL}, ${EMAIL}, false, now(), now())
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    // Только свои строки, и всё, что ссылается на пользователя, — раньше
    // самого пользователя: ссылки стоят с on delete restrict.
    await sql`delete from tasks where user_id = ${EMAIL}`;
    await sql`delete from user_settings where user_id = ${EMAIL}`;
    await sql`delete from "user" where email = ${EMAIL}`;
    await sql.end();
  });

  describe('настройки', () => {
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

  describe('порядок выдачи задач', () => {
    it('две задачи на одно время идут в устойчивом порядке, а не в порядке кучи', async () => {
      // Свойство, которое здесь проверяется: у getTasksBetween полный
      // порядок. (Дата, минута) его не задаёт — две встречи на 9:00 это
      // обычное дело, — и без тай-брейка их взаимный порядок определяется
      // физическим расположением строк в куче. loadRange сортирует поверх
      // устойчиво, то есть этот порядок доходит до экрана как есть: соседки
      // на одно время менялись бы местами после любой правки одной из них.
      const rows = await sql`
        insert into tasks (title, date, start_minute, duration_minutes, all_day, user_id)
        values ('ZZ-девять ноль-ноль А', ${DATE}, 540, 30, false, ${EMAIL}),
               ('ZZ-девять ноль-ноль Б', ${DATE}, 540, 30, false, ${EMAIL})
        returning id
      `;
      try {
        const sorted = rows.map((row) => row.id as string).sort();

        // Физический порядок разводится с порядком id намеренно, иначе тест
        // проверял бы везение: у только что вставленных строк он совпадает
        // с порядком вставки, и совпасть с порядком id может сам по себе,
        // с вероятностью примерно в половину (id — случайные uuid).
        //
        // Правка двигает строку в конец: Postgres на update пишет НОВУЮ
        // версию строки, а старая остаётся мёртвой на прежнем месте.
        // Обновляем ту, что меньше по id, — после этого физический порядок
        // гарантированно обратен порядку id, и совпадение исключено.
        // updated_at, а не title: видимых полей это не трогает.
        await sql`update tasks set updated_at = now() where id = ${sorted[0]}`;

        expect((await getTasksBetween(EMAIL, DATE, DATE)).map((t) => t.id)).toEqual(sorted);
      } finally {
        await sql`delete from tasks where user_id = ${EMAIL} and date = ${DATE}`;
      }
    });
  });
});
