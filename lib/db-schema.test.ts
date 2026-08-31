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
