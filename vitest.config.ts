import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: { environment: 'node', include: ['**/*.test.ts'] },
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
