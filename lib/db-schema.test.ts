import { describe, expect, it } from 'vitest';
import { sql } from './db';

const run = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Проверяется не поведение кода, а форма схемы — и это намеренно.
 *
 * Именно здесь тестовая база однажды разошлась с боевой. Фаза 3 миграции 0004
 * делает колонки владельца обязательными; её применили к бою вручную,
 * раскомментировав на время, а в файле она осталась закомментированной.
 * scripts/test-db.sh собирает схему настоящими файлами миграций — значит фазу 3
 * он не выполнял никогда. Итог: в бою user_id обязателен, в тестовом
 * контейнере нет.
 *
 * Расхождение этого вида опаснее обычного дефекта: вставка, забывшая владельца,
 * проходит в тестах зелёной и падает в бою. Тест закрывает именно это — он
 * покраснеет на контейнере, собранном без миграции 0006.
 */
run('схема: владелец обязателен', () => {
  it.each(['tasks', 'recurrences', 'command_log', 'push_subscriptions'])(
    'user_id в %s объявлен not null',
    async (table) => {
      const [row] = await sql`
        select is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = ${table}
          and column_name = 'user_id'
      `;
      // Пустой row означал бы, что колонки нет вовсе — это тоже провал,
      // и отличать его от «есть, но nullable» здесь незачем.
      expect(row?.is_nullable).toBe('NO');
    },
  );
});

/**
 * Та же защита от расхождения схем, что и у блока выше, но для колонки
 * горизонта. Тест покраснеет на контейнере, собранном без миграции 0007, —
 * то есть поймает ровно тот случай, когда тесты начинают проверять другую
 * базу, чем та, в которой работает приложение.
 */
run('схема: горизонт задачи', () => {
  it('horizon в tasks объявлен not null', async () => {
    const [row] = await sql`
      select is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'tasks'
        and column_name = 'horizon'
    `;
    expect(row?.is_nullable).toBe('NO');
  });

  // Миграция 0007 называет default 'day' мерой на окно между миграцией
  // и выкладкой — но это верно только для боевого перехода, а не навсегда.
  // materializeOccurrence (lib/apply.ts) и другие вставки без явного horizon
  // полагаются на него постоянно, и after-выкладки он несущий, а не
  // временный. Тест ловит будущую «уборку»: кто-то прочитает комментарий
  // миграции буквально, снимет default как отслуживший своё — и вставки,
  // которые не называют horizon явно, начнут падать на not null.
  it('у horizon в tasks остаётся default day и после окна выкладки', async () => {
    const [row] = await sql`
      select column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'tasks'
        and column_name = 'horizon'
    `;
    expect(row?.column_default).toBe("'day'::text");
  });
});
