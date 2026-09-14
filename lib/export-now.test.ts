import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { exportWindow } from './export';
import { exportNow } from './export-now';
import type { ExportDeps } from './export-run';

function fakeDeps(options: { enabled?: boolean } = {}) {
  const calls = { ranges: [] as [string, string][], clients: 0 };
  const deps: ExportDeps = {
    getExport: async () => (options.enabled === false ? null : {
      calendarId: 'zz-cal', enabled: true, syncedAt: null, reconciledAt: null, brokenAt: null,
    }),
    saveExportState: async () => {},
    getLinks: async () => [],
    saveLink: async () => {},
    deleteLink: async () => {},
    loadRange: async (_userId, from, to) => { calls.ranges.push([from, to]); return []; },
    getTimezone: async () => 'Europe/Amsterdam',
    getExportUsers: async () => [],
    clientFor: async () => { calls.clients += 1; throw new Error('ZZ-клиент здесь не нужен'); },
  };
  return { deps, calls };
}

describe('выгрузка сразу после правки', () => {
  // 22:30 по UTC 14 сентября — в Амстердаме уже 00:30 15-го. Толчок обязан
  // строить окно так же, как планировщик, от даты владельца: иначе задача
  // на край окна выгружалась бы толчком и снималась бы планировщиком.
  test('сегодня считается в поясе владельца, а не по UTC', async () => {
    const { deps, calls } = fakeDeps();
    await exportNow(deps, 'zz-user', () => Date.parse('2026-09-14T22:30:00Z'));
    const window = exportWindow('2026-09-15');
    expect(calls.ranges).toEqual([[window.from, window.to]]);
  });

  test('без включённой выгрузки в Google не ходит', async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    expect(await exportNow(deps, 'zz-user')).toEqual({ applied: 0, failed: 0 });
    expect(calls.clients).toBe(0);
    expect(calls.ranges).toEqual([]);
  });
});

// Толчок — ускорение, а не источник правды: забытый обработчик всё равно
// догонит пятиминутный проход. Но «сразу» тогда молча превратится в «через
// пять минут» ровно для одного пути правки. Сверяем по коду без комментариев:
// совпадение с пояснением уже дважды давало в этой ветке ложно-зелёный тест.
const ROUTES = [
  'app/api/command/route.ts',
  'app/api/clarify/route.ts',
  'app/api/task/route.ts',
  'app/api/undo/route.ts',
];

function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('каждый путь правки задач толкает выгрузку', () => {
  test.each(ROUTES)('%s', (path) => {
    const source = codeOf(path);
    const handlers = source.match(/export async function (POST|PATCH|PUT|DELETE)\(/g) ?? [];
    const pushes = source.match(/scheduleExport\(user\.userId\);/g) ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    expect(pushes.length).toBe(handlers.length);
    expect(source).toContain("import { scheduleExport } from '@/lib/export-now';");
  });
});
