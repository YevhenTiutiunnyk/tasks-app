import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Откатывает vi.stubEnv после каждого теста автоматически. Без этого
    // упавший expect в тесте с подменённой переменной пропускал бы
    // vi.unstubAllEnvs() в конце файла, и следующий тест стартовал бы
    // с чужой подменой окружения — первопричина тонула бы во втором падении.
    // Снимает класс целиком, не только для lib/user-key.test.ts, где найден,
    // но и для lib/key-client.test.ts, устроенного так же.
    unstubEnvs: true,
    // Подменяет DATABASE_URL на TEST_DATABASE_URL до импорта lib/db.ts —
    // см. комментарий в самом файле про то, почему это обязано случиться
    // именно в setupFiles, а не внутри тестов.
    setupFiles: ['./vitest.setup.ts'],
    // Тесты, ходящие в базу (db.test.ts, apply.test.ts, ownership.test.ts,
    // allowed-emails.test.ts), с задачи 3B работают не с боевым Supabase, а
    // с локальным контейнером tasks-test-db (scripts/test-db.sh): запросы
    // никуда по сети не идут, и весь прогон устойчиво занимает 2,4–2,5 секунды
    // (из них около секунды — не тесты, а трансформация и импорт модулей).
    // Стандартных пяти секунд на тест хватило бы с запасом — поднятый лимит
    // остаётся как дешёвый запас на холодный контейнер и занятую машину.
    // Прогон он не замедляет: лимит — потолок, а не задержка. Двадцать
    // секунд при этом всё ещё не прячут настоящее зависание.
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
