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
    // Отдельный журнал похода в Google (получения клиента) — нужен, чтобы
    // «совпавший отпечаток не даёт ни одного обращения» проверялось прямо,
    // а не косвенно через пустоту inserted/patched/deleted: без своего
    // счётчика ранний (жадный) вызов clientFor остался бы незамеченным,
    // раз сам он ничего не пишет в эти три массива.
    touchedGoogle: [] as string[],
    // Общий порядок вызовов клиента вперемешку — remove/update/create
    // в тех же трёх массивах неразличимы по времени, а порядок «удаления,
    // правки, создания» это как раз про время, а не про итоговые суммы.
    calls: [] as string[],
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
    clientFor: async () => {
      state.touchedGoogle.push('clientFor');
      return {
        listCalendars: async () => [],
        listEvents: async () => ({ events: [], nextPageToken: null, nextSyncToken: null }),
        createCalendar: async () => 'cal-new',
        deleteCalendar: async () => {},
        insertEvent: async (_c, draft) => {
          state.inserted.push(draft.taskKey);
          state.calls.push(`create:${draft.taskKey}`);
          return `e-${draft.taskKey}`;
        },
        patchEvent: async (_c, eventId) => {
          state.patched.push(eventId);
          state.calls.push(`update:${eventId}`);
        },
        deleteEvent: async (_c, eventId) => {
          state.deleted.push(eventId);
          state.calls.push(`remove:${eventId}`);
        },
        ...options.client,
      };
    },
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
  // Прямая проверка, а не только по пустоте трёх массивов выше: жадный
  // clientFor (например, ради предзагрузки токена) ничего в них не пишет
  // сам по себе и остался бы незамечен без этого счётчика.
  expect(state.touchedGoogle).toEqual([]);
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
  // Весь журнал записей, а не только последняя: `.at(-1)!.brokenAt` зелен
  // и тогда, когда brokenAt вовсе не передан (undefined `not.toBeNull()`
  // проходит) — например, если фатальную ветку случайно поменять с `return`
  // на `break` и финальный `{syncedAt:true}` затрёт собой пометку поломки,
  // оставшись последней записью. Полное сравнение ловит и это: тогда
  // в журнале окажется два вызова вместо одного, и toEqual покраснеет.
  expect(state.saved).toEqual([{ syncedAt: true, brokenAt: expect.any(String) }]);
  expect(state.inserted).toEqual([]);
});

// Календарь удалён человеком, а не просто одно событие в нём: 404 ловится
// именно на СОЗДАНИИ, где событие в принципе не могло существовать раньше —
// единственное объяснение 404 здесь это «пропал сам календарь». Пересоздавать
// его молча нельзя: приложение, упрямо возвращающее выкинутое, ведёт себя
// хамски. Правку и удаление та же ошибка не ломает — см. тесты ниже.
test('исчезнувший при создании календарь помечает связь сломанной и прекращает проход', async () => {
  const { deps, state } = setup({
    tasks: [task(), task({ id: 't2' })],
    client: { insertEvent: async () => { throw new CalendarGone(); } },
  });
  const result = await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.saved).toEqual([{ syncedAt: true, brokenAt: expect.any(String) }]);
  expect(state.inserted).toEqual([]);
  expect(result.applied).toBe(0);
});

// Пропавшее при ПРАВКЕ событие — это не пропавший календарь, а событие,
// которое человек удалил руками в Google. Штатный случай, а не поломка:
// связку снимаем и идём дальше по остальным операциям прохода, следующий
// проход создаст событие заново через create.
test('исчезнувшее при правке событие снимает связку и не прерывает проход', async () => {
  const changed = task({ id: 'u1', title: 'Новое название' });
  const created = task({ id: 'c1' });
  const { deps, state } = setup({
    tasks: [changed, created],
    links: [{ taskKey: 'u1', eventId: 'e-old', fingerprint: 'устаревший-отпечаток' }],
    client: { patchEvent: async () => { throw new CalendarGone(); } },
  });
  const result = await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.deletedLinks).toEqual(['u1']);
  // Дошли и до следующей операции — создания c1 — а не остановились.
  expect(state.inserted).toEqual(['c1']);
  // Связь не сломана: 410/404 на правку не значит потерю доступа.
  expect(state.saved).toEqual([{ syncedAt: true }]);
  // Сама правка в этот проход в Google не отражена (applied — только c1),
  // но и отказом это не считается.
  expect(result).toEqual({ applied: 1, failed: 0 });
});

// Пропавшее при УДАЛЕНИИ событие — операция уже добилась своей цели:
// события и так не должно было быть. Связку снимаем, проход продолжается.
test('исчезнувшее при удалении событие снимает связку и засчитывается применённым', async () => {
  const created = task({ id: 'c1' });
  const { deps, state } = setup({
    tasks: [created],
    links: [{ taskKey: 'gone', eventId: 'e-gone', fingerprint: 'что-то' }],
    client: { deleteEvent: async () => { throw new CalendarGone(); } },
  });
  const result = await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.deletedLinks).toEqual(['gone']);
  expect(state.inserted).toEqual(['c1']);
  expect(state.saved).toEqual([{ syncedAt: true }]);
  // Удаление (цель достигнута) и создание — обе операции применены.
  expect(result).toEqual({ applied: 2, failed: 0 });
});

test('операции идут строго в порядке «удаления, правки, создания»', async () => {
  const created = task({ id: 'c1' });
  const { deps, state } = setup({
    tasks: [created],
    links: [{ taskKey: 'gone', eventId: 'e-gone', fingerprint: 'что-то' }],
  });
  await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(state.calls).toEqual(['remove:e-gone', 'create:c1']);
});

test('бюджет уже истёк до первой операции — ничего не делаем, но проход отмечаем', async () => {
  const many = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}` }));
  const { deps, state } = setup({ tasks: many });
  // Срок уже истёк: ни одной операции сделать не успеваем.
  await exportUser(deps, 'zz-user', TODAY, Date.now() - 1);
  expect(state.inserted).toEqual([]);
  // Отметка о проходе всё равно ставится: иначе владелец, у которого бюджет
  // кончается каждый раз, вечно опрашивался бы на каждом тике.
  expect(state.saved.at(-1)!.syncedAt).toBe(true);
});

// Проверка «бюджет истёк ДО первой операции» (тест выше) зелена и тогда,
// когда проверка бюджета вынесена из цикла и стоит один раз на весь проход:
// в обоих случаях ни одна операция не выполнится. Единственный способ
// отличить «перед каждой» от «раз на проход» — истощить бюджет ПОСЕРЕДИНЕ
// списка операций управляемым секундомером и убедиться, что первые
// успевшие операции применились, а последующие — нет.
test('бюджет обрывает проход после второй операции, не потеряв уже сделанного', async () => {
  const many = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}` }));
  const { deps, state } = setup({ tasks: many });
  let checks = 0;
  // Первые две проверки бюджета (перед 1-й и 2-й операцией) укладываются,
  // третья (перед 3-й операцией) уже нет — секундомер управляемый, гонки
  // с настоящим временем нет.
  const clock = () => { checks += 1; return checks >= 3 ? 1000 : 0; };
  const result = await exportUser(deps, 'zz-user', TODAY, 500, clock);
  expect(state.inserted).toEqual(['t0', 't1']);
  expect(result.applied).toBe(2);
  // Уже сделанное не потеряно: связки первых двух задач записаны.
  expect(state.savedLinks.map((link) => link.taskKey)).toEqual(['t0', 't1']);
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
