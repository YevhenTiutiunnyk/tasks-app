import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Подменяет DATABASE_URL на TEST_DATABASE_URL до импорта lib/db.ts —
    // см. комментарий в самом файле про то, почему это обязано случиться
    // именно в setupFiles, а не внутри тестов.
    setupFiles: ['./vitest.setup.ts'],
    // Тесты lib/db.test.ts и lib/apply.test.ts ходят в настоящий Supabase
    // во Франкфурте: пятнадцать тестов applyOperations идут около сорока
    // секунд, в среднем по три на тест, и каждый делает несколько запросов
    // подряд внутри транзакции. Стандартных пяти секунд им хватало впритык,
    // и самый тяжёлый из них периодически падал по таймауту — не по логике.
    // Двадцать секунд дают запас на медленную сеть и при этом не прячут
    // настоящее зависание. Тесты чистых функций от этого не замедляются:
    // лимит — потолок, а не задержка.
    testTimeout: 20000,
    // Файлы, ходящие в базу (db.test.ts, apply.test.ts, ownership.test.ts),
    // делят один и тот же живой Postgres — раньше это была огромная боевая
    // база, где столкновение между файлами тонуло в шуме. На маленькой
    // тестовой базе оно уже не тонет: apply.test.ts чистит command_log
    // без всяких условий (`delete from command_log`), а ownership.test.ts
    // считает в нём чужие строки до и после — параллельный файл, вставляющий
    // или стирающий строки в тот же момент, сбивает этот счёт. Раньше это
    // было не видно: ownership.test.ts на боевой базе останавливался
    // предохранителем в beforeAll раньше, чем дело доходило до параллелизма.
    // Отключение параллелизма файлов — не подгонка под тест, а честное
    // признание того, что несколько файлов не могут безопасно делить одну
    // живую базу без транзакционной изоляции между собой.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': import.meta.dirname,
      // Next.js resolves this marker package to its no-op build via the
      // "react-server" export condition, which Vitest doesn't set. Point it
      // at that same no-op file directly (its package "exports" map hides
      // the subpath from plain node/import resolution) so `import
      // 'server-only'` is a safe no-op under the test runner instead of
      // throwing on every import.
      'server-only': fileURLToPath(
        new URL('./node_modules/server-only/empty.js', import.meta.url),
      ),
    },
  },
});
