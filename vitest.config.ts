import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Тесты lib/db.test.ts и lib/apply.test.ts ходят в настоящий Supabase
    // во Франкфурте: пятнадцать тестов applyOperations идут около сорока
    // секунд, в среднем по три на тест, и каждый делает несколько запросов
    // подряд внутри транзакции. Стандартных пяти секунд им хватало впритык,
    // и самый тяжёлый из них периодически падал по таймауту — не по логике.
    // Двадцать секунд дают запас на медленную сеть и при этом не прячут
    // настоящее зависание. Тесты чистых функций от этого не замедляются:
    // лимит — потолок, а не задержка.
    testTimeout: 20000,
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
