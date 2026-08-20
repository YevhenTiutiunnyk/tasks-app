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
    // Файлы, ходящие в базу (db.test.ts, apply.test.ts, ownership.test.ts,
    // allowed-emails.test.ts), делят один и тот же тестовый Postgres.
    //
    // Задача 6 перевела чистку command_log в apply.test.ts на адресную
    // (по user_id владельца zz-apply@example.invalid) и проверила: флаг всё
    // равно нельзя снять. Причина уже не в самой чистке, а в предохранителе
    // ownership.test.ts (см. его beforeAll) — тот сканирует ВСЮ таблицу
    // command_log на чужие строки (user_id not in idA/idB/idC), а не только
    // свои. Пока apply.test.ts работает параллельно, его собственные строки
    // (владелец zz-apply) для этого предохранителя тоже «чужие» — и если файлы
    // выполняются в одном временном окне, беглый прогон ловит их посередине:
    // beforeAll ownership.test.ts стартует и видит строку zz-apply, которую
    // apply.test.ts ещё не успел убрать своим clean(). Проверено: без флага
    // из трёх подряд прогонов один упал именно на этом счётчике
    // («В command_log 1 чужих записей»), два прошли. Предохранитель — часть
    // задачи 5, специально придуман падать громко на любой чужой строке;
    // сузить его до «чужой, и не от apply.test.ts» значило бы ослаблять
    // защиту от боевой базы ради параллелизма тестов — того не стоит.
    // Значит общая на файлы сущность всё ещё есть: сама таблица command_log,
    // и снятие флага остаётся будущей работой, а не этой задачей.
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
