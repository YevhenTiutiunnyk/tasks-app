import { expect, test } from 'vitest';
import { CalendarAccessLost, CalendarGone, type CalendarClient } from './google-api';
import { exportManyUsers, exportUser, type ExportDeps } from './export-run';
import { fingerprintOf } from './export';
import type { ExportLink, ExportRow } from './db';
import type { Task } from './types';

const TODAY = '2026-09-10';
const FOREVER = Number.MAX_SAFE_INTEGER;

function task(patch: Partial<Task> = {}): Task {
  return {
    id: 't1', title: 'ZZ-тренировка', date: '2026-09-10', startMinute: 600,
    durationMinutes: 60, allDay: false, categoryId: null, done: false,
    horizon: 'day', recurrenceId: null, recurrenceDate: null, ...patch,
  };
}

function setup(options: {
  row?: Partial<ExportRow>;
  tasks?: Task[];
  links?: ExportLink[];
  client?: Partial<CalendarClient>;
}) {
  const state = {
    inserted: [] as string[], patched: [] as string[], deleted: [] as string[],
    savedLinks: [] as ExportLink[], deletedLinks: [] as string[],
    saved: [] as Parameters<ExportDeps['saveExportState']>[1][],
  };
  const deps: ExportDeps = {
    getExport: async () => ({
      calendarId: 'cal-1', enabled: true, syncedAt: null, reconciledAt: null,
      brokenAt: null, ...options.row,
    }),
    saveExportState: async (_u, patch) => { state.saved.push(patch); },
    getLinks: async () => options.links ?? [],
    saveLink: async (_u, link) => { state.savedLinks.push(link); },
    deleteLink: async (_u, key) => { state.deletedLinks.push(key); },
    loadRange: async () => options.tasks ?? [],
    getTimezone: async () => 'Europe/Amsterdam',
    clientFor: async () => ({
      listCalendars: async () => [],
      listEvents: async () => ({ events: [], nextPageToken: null, nextSyncToken: null }),
      createCalendar: async () => 'cal-new',
      deleteCalendar: async () => {},
      insertEvent: async (_c, draft) => { state.inserted.push(draft.taskKey); return `e-${draft.taskKey}`; },
      patchEvent: async (_c, eventId) => { state.patched.push(eventId); },
      deleteEvent: async (_c, eventId) => { state.deleted.push(eventId); },
      ...options.client,
    }),
  };
  return { deps, state };
}

test('новая задача создаёт событие и связку', async () => {
  const { deps, state } = setup({ tasks: [task()] });
  await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.inserted).toEqual(['t1']);
  expect(state.savedLinks).toEqual([
    { taskKey: 't1', eventId: 'e-t1', fingerprint: fingerprintOf(task()) },
  ]);
});

test('совпавший отпечаток не даёт ни одного обращения к Google', async () => {
  const current = task();
  const { deps, state } = setup({
    tasks: [current],
    links: [{ taskKey: 't1', eventId: 'e1', fingerprint: fingerprintOf(current) }],
  });
  await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.inserted).toEqual([]);
  expect(state.patched).toEqual([]);
  expect(state.deleted).toEqual([]);
});

test('исчезнувшая задача удаляет и событие, и связку', async () => {
  const { deps, state } = setup({
    tasks: [],
    links: [{ taskKey: 't-ушла', eventId: 'e-ушла', fingerprint: 'что-то' }],
  });
  await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.deleted).toEqual(['e-ушла']);
  expect(state.deletedLinks).toEqual(['t-ушла']);
});

// Отпечаток, обновлённый до ответа Google, навсегда прячет расхождение:
// следующий проход разницы уже не увидит.
test('сорвавшаяся запись не обновляет отпечаток', async () => {
  const { deps, state } = setup({
    tasks: [task()],
    client: { insertEvent: async () => { throw new Error('Google ответил 500'); } },
  });
  const result = await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.savedLinks).toEqual([]);
  expect(result.failed).toBe(1);
});

test('выключенная выгрузка не делает ничего', async () => {
  const { deps, state } = setup({ row: { enabled: false }, tasks: [task()] });
  await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.inserted).toEqual([]);
});

test('сломанная связь не дёргает Google до починки человеком', async () => {
  const { deps, state } = setup({ row: { brokenAt: '2026-09-10T10:00:00.000Z' }, tasks: [task()] });
  await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.inserted).toEqual([]);
});

test('потеря доступа помечает связь сломанной и прекращает проход', async () => {
  const { deps, state } = setup({
    tasks: [task(), task({ id: 't2' })],
    client: { insertEvent: async () => { throw new CalendarAccessLost(); } },
  });
  await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.saved.at(-1)!.brokenAt).not.toBeNull();
  expect(state.inserted).toEqual([]);
});

// Календарь удалён человеком. Пересоздавать молча нельзя: приложение,
// упрямо возвращающее выкинутое, ведёт себя хамски.
test('исчезнувший календарь помечает связь сломанной', async () => {
  const { deps, state } = setup({
    tasks: [task()],
    client: { insertEvent: async () => { throw new CalendarGone(); } },
  });
  await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.saved.at(-1)!.brokenAt).not.toBeNull();
});

test('бюджет времени обрывает проход, не потеряв уже сделанного', async () => {
  const many = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}` }));
  const { deps, state } = setup({ tasks: many });
  // Срок уже истёк: ни одной операции сделать не успеваем.
  await exportUser(deps, 'zz-user', TODAY, Date.now() - 1);
  expect(state.inserted).toEqual([]);
  // Отметка о проходе всё равно ставится: иначе владелец, у которого бюджет
  // кончается каждый раз, вечно опрашивался бы на каждом тике.
  expect(state.saved.at(-1)!.syncedAt).toBe(true);
});

/* ---------- exportManyUsers: обход многих владельцев ---------- */

/**
 * Поддельные зависимости на нескольких владельцев сразу — с журналом того,
 * КОГО реально коснулись (getExport) и КОГО реально коснулся Google
 * (clientFor). Первого списка мало: exportManyUsers обязан спрашивать
 * getExport даже у пропущенного по бюджету — нет, ровно наоборот, он
 * обязан НЕ спрашивать getExport у того, до кого бюджет не дотянул, —
 * а вот свежего по synced_at он спрашивает, просто не идёт дальше в Google.
 * Без раздельных списков «дошли ли до владельца» и «дошли ли до Google»
 * пропуск по свежести и пропуск по бюджету неотличимы одной суммой.
 */
function setupMany(
  rows: Record<string, Partial<ExportRow>>,
  options: {
    tasks?: Record<string, Task[]>;
    loadRangeOverrides?: Record<string, () => Promise<Task[]>>;
  } = {},
) {
  const state = {
    visited: [] as string[],
    touchedGoogle: [] as string[],
    inserted: [] as { userId: string; taskKey: string }[],
    saved: [] as { userId: string; patch: Parameters<ExportDeps['saveExportState']>[1] }[],
  };
  const deps: ExportDeps = {
    getExport: async (userId) => {
      state.visited.push(userId);
      return {
        calendarId: 'cal-1', enabled: true, syncedAt: null, reconciledAt: null,
        brokenAt: null, ...rows[userId],
      };
    },
    saveExportState: async (userId, patch) => { state.saved.push({ userId, patch }); },
    getLinks: async () => [],
    saveLink: async () => {},
    deleteLink: async () => {},
    loadRange: async (userId) => {
      const override = options.loadRangeOverrides?.[userId];
      if (override) return override();
      return options.tasks?.[userId] ?? [];
    },
    getTimezone: async () => 'Europe/Amsterdam',
    clientFor: async (userId) => {
      state.touchedGoogle.push(userId);
      return {
        listCalendars: async () => [],
        listEvents: async () => ({ events: [], nextPageToken: null, nextSyncToken: null }),
        createCalendar: async () => 'cal-new',
        deleteCalendar: async () => {},
        insertEvent: async (_c, draft) => {
          state.inserted.push({ userId, taskKey: draft.taskKey });
          return `e-${draft.taskKey}`;
        },
        patchEvent: async () => {},
        deleteEvent: async () => {},
      };
    },
  };
  return { deps, state };
}

test('exportManyUsers пропускает владельца со свежим synced_at, не трогая Google', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const { deps, state } = setupMany(
    // Две минуты назад — меньше пятиминутного интервала.
    { fresh: { syncedAt: '2026-09-10T11:58:00.000Z' } },
    { tasks: { fresh: [task()] } },
  );
  const result = await exportManyUsers(deps, [{ userId: 'fresh', today: TODAY }], now, FOREVER);
  expect(state.touchedGoogle).toEqual([]);
  expect(result).toEqual({ applied: 0, failed: 0 });
});

test('exportManyUsers обрабатывает владельца с устаревшим или пустым synced_at', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const { deps, state } = setupMany(
    {
      // Час назад — больше пятиминутного интервала.
      stale: { syncedAt: '2026-09-10T11:00:00.000Z' },
      never: { syncedAt: null },
    },
    { tasks: { stale: [task({ id: 's1' })], never: [task({ id: 'n1' })] } },
  );
  const users = [{ userId: 'stale', today: TODAY }, { userId: 'never', today: TODAY }];
  const result = await exportManyUsers(deps, users, now, FOREVER);
  expect(state.touchedGoogle.slice().sort()).toEqual(['never', 'stale']);
  expect(result.applied).toBe(2);
});

test('exportManyUsers останавливается по общему бюджету раньше, чем доходит до всех владельцев', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  // Поддельный секундомер: каждый реальный поход в Google «стоит» 6 единиц
  // бюджета — как в syncManyUsers, часы управляемые, а не настоящие.
  let clock = 0;
  const users = [
    { userId: 'u1', today: TODAY }, { userId: 'u2', today: TODAY }, { userId: 'u3', today: TODAY },
  ];
  const { deps, state } = setupMany(
    { u1: {}, u2: {}, u3: {} },
    { tasks: { u1: [task({ id: 'a' })], u2: [task({ id: 'b' })], u3: [task({ id: 'c' })] } },
  );
  const originalClientFor = deps.clientFor;
  deps.clientFor = async (userId) => { clock += 6; return originalClientFor(userId); };
  // Бюджет 10: первый укладывается (0 < 10), второй тоже успевает начаться
  // (6 < 10), а после него набегает 12 — третий владелец бюджет уже не
  // застаёт и до него дело не доходит вовсе.
  const result = await exportManyUsers(deps, users, now, 10, () => clock);
  expect(state.touchedGoogle).toEqual(['u1', 'u2']);
  // До третьего владельца цикл не доходит вовсе — даже getExport для него
  // не вызывается.
  expect(state.visited).not.toContain('u3');
  expect(result.applied).toBe(2);
});

test('exportManyUsers не останавливается, если один владелец обрывается ошибкой', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const users = [{ userId: 'broken', today: TODAY }, { userId: 'ok', today: TODAY }];
  const { deps, state } = setupMany(
    { broken: {}, ok: {} },
    {
      tasks: { ok: [task({ id: 'ok1' })] },
      loadRangeOverrides: { broken: async () => { throw new Error('база недоступна'); } },
    },
  );
  const result = await exportManyUsers(deps, users, now, FOREVER);
  expect(result.failed).toBe(1);
  expect(state.touchedGoogle).toEqual(['ok']);
});
