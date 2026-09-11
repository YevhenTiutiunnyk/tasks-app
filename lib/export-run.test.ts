import { expect, test } from 'vitest';
import {
  CalendarAccessLost, CalendarGone, googleClient, type CalendarClient,
} from './google-api';
import { exportManyUsers, exportUser, reconcileLinks, type ExportDeps } from './export-run';
import { addDays } from './dates';
import { eventIdFor, exportWindow, fingerprintOf } from './export';
import type { ExportLink, ExportRow } from './db';
import type { Task } from './types';
import type { GoogleEvent } from './calendar';

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
    getExportUsers: async () => [],
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
        calendarId: 'cal-1', enabled: true, syncedAt: null,
        // Свежая по умолчанию: большинству тестов из этого блока полная
        // суточная сверка безразлична, и без свежей отметки каждый из них
        // получил бы лишнее обращение к Google от reconcileLinks поверх
        // того, что он на самом деле проверяет. Тесты про саму сверку ниже
        // переопределяют reconciledAt явно.
        reconciledAt: '2026-09-10T00:00:00.000Z',
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
    // По умолчанию список из базы пуст: тесты про бюджет, свежесть и сверку
    // работают ровно с теми владельцами, которых им передали. Тесты про сам
    // список ниже переопределяют это явно.
    getExportUsers: async () => [],
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

// Тест выше ловит отказ ВНУТРИ exportUser (loadRange), а этот — отказ
// самого getExport в цикле exportManyUsers, ДО exportUser. Разница важна:
// getExport стоял вне try до правки этой задачи, и его отказ ронял бы
// exportManyUsers целиком — ни 'ok' не выгрузился бы, ни исключение не
// добралось бы дальше catch на уровне владельца, а поднялось бы в роут
// и там задело бы всё, что идёт ПОСЛЕ выгрузки (например, purgeOldSent),
// то есть ту самую дыру I3, ради которой стадия вынесена отдельным
// проходом после напоминаний и отчёта.
test('exportManyUsers не останавливается, если у одного владельца падает само чтение строки экспорта', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const users = [{ userId: 'broken', today: TODAY }, { userId: 'ok', today: TODAY }];
  const { deps, state } = setupMany(
    { ok: {} },
    { tasks: { ok: [task({ id: 'ok1' })] } },
  );
  const originalGetExport = deps.getExport;
  deps.getExport = async (userId) => {
    if (userId === 'broken') throw new Error('пул соединений исчерпан');
    return originalGetExport(userId);
  };
  const result = await exportManyUsers(deps, users, now, FOREVER);
  expect(result.failed).toBe(1);
  expect(state.touchedGoogle).toEqual(['ok']);
});

/* ---------- reconcileLinks: полная сверка раз в сутки ---------- */

// Брифом просилось verbatim с `patch: any` — здесь заменено на
// Partial<GoogleEvent>, как заведено в остальных тестах проекта
// (lib/calendar.test.ts), чтобы пройти правило no-explicit-any.
function googleEvent(patch: Partial<GoogleEvent> = {}) {
  return {
    id: 'e1',
    updated: '2026-09-10T10:00:00.000Z',
    summary: 'ZZ-тренировка',
    start: { dateTime: '2026-09-10T10:00:00+02:00' },
    end: { dateTime: '2026-09-10T11:00:00+02:00' },
    extendedProperties: { private: { taskKey: 't1' } },
    ...patch,
  };
}

// Событие удалили руками в Google. Быстрый проход этого не видит: у него
// отпечаток совпадает. Связку надо убрать, чтобы разбор разницы создал
// событие заново.
test('связка без события в Google убирается', async () => {
  const { deps, state } = setup({
    links: [{ taskKey: 't1', eventId: 'e1', fingerprint: 'какой-то' }],
    client: {
      listEvents: async () => ({ events: [], nextPageToken: null, nextSyncToken: null }),
    },
  });
  const fixed = await reconcileLinks(deps, 'zz-user', TODAY);
  expect(state.deletedLinks).toEqual(['t1']);
  expect(fixed).toBe(1);
});

// Таблица связок потерялась, календарь остался. Без метки в событии
// сверка создала бы всё заново и получились бы дубли.
test('событие с нашей меткой без связки — связка восстанавливается', async () => {
  const { deps, state } = setup({
    links: [],
    client: {
      listEvents: async () => ({ events: [googleEvent()], nextPageToken: null, nextSyncToken: null }),
    },
  });
  await reconcileLinks(deps, 'zz-user', TODAY);
  expect(state.savedLinks).toEqual([
    { taskKey: 't1', eventId: 'e1', fingerprint: '' },
  ]);
});

// Пустой отпечаток у восстановленной связки — не небрежность: он обязан
// разойтись с любым настоящим, чтобы разбор разницы на этом же проходе
// привёл событие к задаче.
test('восстановленная связка получает заведомо несовпадающий отпечаток', async () => {
  const { deps, state } = setup({
    links: [],
    client: {
      listEvents: async () => ({ events: [googleEvent()], nextPageToken: null, nextSyncToken: null }),
    },
  });
  await reconcileLinks(deps, 'zz-user', TODAY);
  expect(state.savedLinks[0].fingerprint).not.toBe(fingerprintOf(task()));
  // Точное значение, а не только «не настоящий»: `.not.toBe(fingerprintOf(...))`
  // одинаково зелен и для пустой строки, и для любой другой заведомо
  // отличающейся строки — сам по себе он не отличает мутацию, подменившую
  // '' на что-то ещё заведомо несовпадающее. Пустая строка — конкретное
  // обязательство брифа, и её надо пиновать напрямую.
  expect(state.savedLinks[0].fingerprint).toBe('');
});

test('чужое событие без нашей метки не трогается, а своё рядом остаётся нетронутым', async () => {
  const { deps, state } = setup({
    // Своя, уже совпавшая связка рядом — иначе «не трогается» проверяется
    // только на пустых savedLinks/deletedLinks, что было бы верно и для
    // кода, который вообще ничего не читает из Google.
    links: [{ taskKey: 't1', eventId: 'e1', fingerprint: 'какой-то' }],
    client: {
      listEvents: async () => ({
        events: [googleEvent(), googleEvent({ id: 'e-чужое', extendedProperties: undefined })],
        nextPageToken: null, nextSyncToken: null,
      }),
    },
  });
  const fixed = await reconcileLinks(deps, 'zz-user', TODAY);
  expect(state.savedLinks).toEqual([]);
  expect(state.deletedLinks).toEqual([]);
  expect(fixed).toBe(0);
});

test('совпавшая связка не трогается', async () => {
  const { deps, state } = setup({
    links: [{ taskKey: 't1', eventId: 'e1', fingerprint: 'какой-то' }],
    client: {
      listEvents: async () => ({ events: [googleEvent()], nextPageToken: null, nextSyncToken: null }),
    },
  });
  expect(await reconcileLinks(deps, 'zz-user', TODAY)).toBe(0);
  expect(state.savedLinks).toEqual([]);
  expect(state.deletedLinks).toEqual([]);
});

// Ловушка: eventsUrl в lib/google-api.ts всегда просит showDeleted=true,
// и Google присылает отменённые события — тени удалённых вручную встреч,
// не живые события. Тень с нашей меткой нельзя принять за живое: иначе
// связка на руками удалённое событие пережила бы ту самую сверку, ради
// починки которой эта функция и существует.
test('отменённое в Google событие с нашей меткой считается отсутствующим', async () => {
  const { deps, state } = setup({
    links: [{ taskKey: 't1', eventId: 'e1', fingerprint: 'какой-то' }],
    client: {
      listEvents: async () => ({
        events: [googleEvent({ status: 'cancelled' })],
        nextPageToken: null, nextSyncToken: null,
      }),
    },
  });
  const fixed = await reconcileLinks(deps, 'zz-user', TODAY);
  expect(state.deletedLinks).toEqual(['t1']);
  expect(fixed).toBe(1);
});

// Окно чтения обязано совпасть с окном выгрузки С ЗАПАСОМ на каждом краю.
// Задача хранится местной датой и минутой, событие в Google — тоже местным
// временем, а границы здесь UTC-полночь: без суточного запаса задача на
// краю окна, начатая вечером по местному времени восточнее Гринвича, в UTC
// уже за timeMax, и listEvents её не вернёт — сверка снимет живую связку,
// а обычный разбор разницы заведёт для неё ВТОРОЕ событие тем же проходом,
// оставив первое сиротой навсегда (см. комментарий в reconcileLinks).
test('сверка запрашивает окно с суточным запасом на каждом краю', async () => {
  let seenParams: { timeMin?: string; timeMax?: string } | undefined;
  const { deps } = setup({
    links: [],
    client: {
      listEvents: async (_calendarId, params) => {
        seenParams = params;
        return { events: [], nextPageToken: null, nextSyncToken: null };
      },
    },
  });
  await reconcileLinks(deps, 'zz-user', TODAY);
  const window = exportWindow(TODAY);
  expect(seenParams?.timeMin).toBe(`${addDays(window.from, -1)}T00:00:00.000Z`);
  expect(seenParams?.timeMax).toBe(`${addDays(window.to, 2)}T00:00:00.000Z`);
});

// Мок должен реально отдать вторую страницу, иначе мутация «читать только
// первую» осталась бы незамеченной — а её цена та же, что у неверного
// окна: событие со второй страницы выглядело бы отсутствующим.
test('сверка проходит все страницы обхода, а не только первую', async () => {
  const { deps, state } = setup({
    links: [],
    client: {
      listEvents: async (_calendarId, params) => {
        if (!params.pageToken) {
          return {
            events: [googleEvent({ id: 'e1', extendedProperties: { private: { taskKey: 't1' } } })],
            nextPageToken: 'page-2', nextSyncToken: null,
          };
        }
        return {
          events: [googleEvent({ id: 'e2', extendedProperties: { private: { taskKey: 't2' } } })],
          nextPageToken: null, nextSyncToken: null,
        };
      },
    },
  });
  await reconcileLinks(deps, 'zz-user', TODAY);
  expect(state.savedLinks.map((link) => link.taskKey).sort()).toEqual(['t1', 't2']);
});

// Тихий выход (break вместо throw) довёл бы обход до обычного «успешного»
// пути с усечённым списком событий — оборванный обход не считается успехом
// (та же дыра, что ступень A ловила при замене копии целиком).
test('повторяющийся pageToken при сверке обрывает обход ошибкой', async () => {
  const { deps } = setup({
    links: [],
    client: {
      listEvents: async () => ({ events: [], nextPageToken: 'застрял', nextSyncToken: null }),
    },
  });
  await expect(reconcileLinks(deps, 'zz-user', TODAY)).rejects.toThrow();
});

// Связка на t1 указывает на событие, которое человек удалил в Google
// руками, — но раньше уже случался сбой на самой записи (см. exportUser:
// связка пишется ТОЛЬКО после ответа Google), событие создалось, а связка
// не сохранилась. В календаре осталось ЖИВОЕ, но НЕСВЯЗАННОЕ событие с той
// же меткой. Сняв мёртвую связку, сверка обязана тут же увидеть это второе
// событие как кандидата на восстановление — если решение «уже связан»
// принимается по снимку СВЯЗОК ДО удаления, второе событие останется
// сиротой, а обычный разбор разницы заведёт для t1 ТРЕТЬЕ событие.
test('снятие мёртвой связки не мешает восстановить связку по другому событию с той же меткой', async () => {
  const { deps, state } = setup({
    links: [{ taskKey: 't1', eventId: 'e-удалено-руками', fingerprint: 'старый' }],
    client: {
      listEvents: async () => ({
        events: [googleEvent({ id: 'e-осиротевшее' })],
        nextPageToken: null, nextSyncToken: null,
      }),
    },
  });
  const fixed = await reconcileLinks(deps, 'zz-user', TODAY);
  expect(state.deletedLinks).toEqual(['t1']);
  expect(state.savedLinks).toEqual([
    { taskKey: 't1', eventId: 'e-осиротевшее', fingerprint: '' },
  ]);
  expect(fixed).toBe(2);
});

/* ---------- exportManyUsers: суточная сверка перед обычным проходом ---------- */

test('exportManyUsers не запускает полную сверку у владельца со свежей отметкой', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  // Шесть часов назад — меньше суток.
  const { deps, state } = setupMany(
    { fresh: { reconciledAt: '2026-09-10T06:00:00.000Z', syncedAt: null } },
    { tasks: { fresh: [] } },
  );
  await exportManyUsers(deps, [{ userId: 'fresh', today: TODAY }], now, FOREVER);
  // Пустые задачи и пустые связки не дают обычному проходу самому тронуть
  // Google (клиент берётся лениво) — если бы полная сверка всё же
  // запустилась, единственным источником обращения был бы именно она.
  expect(state.touchedGoogle).toEqual([]);
  expect(state.saved.filter((s) => s.userId === 'fresh' && s.patch.reconciledAt)).toEqual([]);
});

test('exportManyUsers запускает полную сверку у владельца со старой отметкой', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  // Двое суток назад — больше суток.
  const { deps, state } = setupMany(
    { stale: { reconciledAt: '2026-09-08T06:00:00.000Z', syncedAt: null } },
    { tasks: { stale: [] } },
  );
  await exportManyUsers(deps, [{ userId: 'stale', today: TODAY }], now, FOREVER);
  expect(state.touchedGoogle).toEqual(['stale']);
  expect(state.saved.filter((s) => s.userId === 'stale' && s.patch.reconciledAt)).toEqual([
    { userId: 'stale', patch: { reconciledAt: true } },
  ]);
});

// Даже с устаревшей отметкой сверка не запускается у владельца, для
// которого она заведомо не может пройти (связь сломана, выгрузка выключена,
// календаря нет) — иначе reconciledAt проставился бы владельцу, у которого
// реальная сверка не состоялась, и первая настоящая попытка после починки
// доступа отложилась бы ещё на сутки — именно в тот момент, когда она
// нужнее всего.
test('exportManyUsers не запускает полную сверку у сломанной связи, даже с устаревшей отметкой', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const { deps, state } = setupMany(
    {
      broken: {
        reconciledAt: '2026-09-01T00:00:00.000Z', syncedAt: null,
        brokenAt: '2026-09-01T00:00:00.000Z',
      },
    },
    { tasks: { broken: [] } },
  );
  await exportManyUsers(deps, [{ userId: 'broken', today: TODAY }], now, FOREVER);
  expect(state.touchedGoogle).toEqual([]);
  expect(state.saved.some((s) => s.userId === 'broken' && s.patch.reconciledAt)).toBe(false);
});

// Однострочник финального ревью: не-access отказ сверки (сеть, квота, 500
// у Google — сюда же попадают оба громких предохранителя reconcileLinks,
// MAX_RECONCILE_PAGES и повторяющийся pageToken) тонул без счётчика. Оба
// предохранителя бросают исключение именно такого рода, и без failed += 1
// они были бы ненаблюдаемы в бою — единственный сигнал наружу у стадии
// это счётчик failed (см. лог в app/api/notify/route.ts).
test('exportManyUsers считает не-access отказ сверки в failed', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const { deps, state } = setupMany(
    { stale: { reconciledAt: '2026-09-08T00:00:00.000Z', syncedAt: null } },
    { tasks: { stale: [] } },
  );
  deps.clientFor = async (userId) => {
    state.touchedGoogle.push(userId);
    return {
      listCalendars: async () => [],
      listEvents: async () => { throw new Error('ZZ-обрыв середины обхода'); },
      createCalendar: async () => 'cal-new',
      deleteCalendar: async () => {},
      insertEvent: async () => 'e-x',
      patchEvent: async () => {},
      deleteEvent: async () => {},
    };
  };

  const result = await exportManyUsers(deps, [{ userId: 'stale', today: TODAY }], now, FOREVER);

  expect(result.failed).toBe(1);
  // reconciledAt не проставлен — отказ не был успехом; и не broken_at:
  // это не потеря доступа, а погода, обычный проход не должен глохнуть.
  expect(state.saved.some((s) => s.userId === 'stale' && s.patch.reconciledAt)).toBe(false);
  expect(state.saved.some((s) => s.userId === 'stale' && s.patch.brokenAt !== undefined)).toBe(false);
});

// tasks: [] в тестах выше не отличает «сверка идёт до exportUser» от «после
// него или вовсе не идёт» — оба случая молчат одинаково. Здесь связка
// указывает на событие, которого Google не вернёт (setupMany по умолчанию
// отдаёт пустой listEvents — как будто человек удалил событие руками):
// сверка обязана снять мёртвую связку и отдать дело exportUser ТЕМ ЖЕ
// проходом, а не следующим пятиминутным циклом.
test('exportManyUsers применяет починенную сверкой связку тем же проходом, а не следующим', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const t = task({ id: 't1' });
  const { deps, state } = setupMany(
    { stale: { reconciledAt: '2026-09-08T00:00:00.000Z', syncedAt: null } },
    { tasks: { stale: [t] } },
  );
  // Живой стенд связок: снятие и восстановление должны быть видны ПОЗЖЕ
  // в том же вызове, а не только зафиксированы в журнале savedLinks/
  // deletedLinks — статический возврат [] из setupMany этого не даёт.
  let links: ExportLink[] = [
    { taskKey: 't1', eventId: 'e-удалено-руками', fingerprint: fingerprintOf(t) },
  ];
  deps.getLinks = async () => links;
  deps.deleteLink = async (_u, key) => { links = links.filter((l) => l.taskKey !== key); };
  deps.saveLink = async (_u, link) => {
    links = [...links.filter((l) => l.taskKey !== link.taskKey), link];
  };
  await exportManyUsers(deps, [{ userId: 'stale', today: TODAY }], now, FOREVER);
  // Если бы сверка шла ПОСЛЕ exportUser (или не шла вовсе), diffExport
  // увидел бы совпавший отпечаток старой связки и не создал бы ничего —
  // задача осталась бы без события ещё один пятиминутный цикл.
  expect(state.inserted).toEqual([{ userId: 'stale', taskKey: 't1' }]);
});

/* ---------- exportManyUsers: сверка не должна ломать обычный проход ---------- */

// clientFor бросает CalendarAccessLost ровно тогда, когда доступ отозван
// на стороне Google (см. getCalendarClient), и reconcileLinks вызывает его
// первым делом — тот же отказ, что и обычный проход, и ему положено то же
// лечение (находка C2 ревью ступени A, см. markBroken в exportUser). Без
// него отказ на сверке считался бы «просто ошибкой одного владельца»,
// syncedAt не обновлялся бы, а владелец опрашивался бы на каждом тике
// планировщика вечно вместо раза в пять минут.
test('потеря доступа во время сверки помечает связь сломанной и не запускает обычный проход', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const { deps, state } = setupMany(
    { user: { reconciledAt: '2026-09-08T00:00:00.000Z', syncedAt: null } },
    { tasks: { user: [task()] } },
  );
  const originalClientFor = deps.clientFor;
  deps.clientFor = async (userId) => {
    const client = await originalClientFor(userId);
    return { ...client, listEvents: async () => { throw new CalendarAccessLost(); } };
  };
  await exportManyUsers(deps, [{ userId: 'user', today: TODAY }], now, FOREVER);
  expect(state.saved).toEqual([
    { userId: 'user', patch: { syncedAt: true, brokenAt: expect.any(String) } },
  ]);
  expect(state.inserted).toEqual([]);
});

// Отказ сверки, который НЕ значит «доступ отозван» (сеть, квота, 500 у
// Google), — погода, а не беда: не должен ни ломать связь, ни морить
// владельца голодом по обычной пятиминутной выгрузке до следующей суточной
// попытки. reconciledAt при этом не проставляется — следующий тик
// попробует сверку заново, а не будет ждать ещё сутки.
test('сбой сети во время сверки не мешает обычному проходу и не отмечает сверку выполненной', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const t = task({ id: 't1' });
  const { deps, state } = setupMany(
    { user: { reconciledAt: '2026-09-08T00:00:00.000Z', syncedAt: null } },
    { tasks: { user: [t] } },
  );
  const originalClientFor = deps.clientFor;
  deps.clientFor = async (userId) => {
    const client = await originalClientFor(userId);
    return { ...client, listEvents: async () => { throw new Error('Google ответил 500'); } };
  };
  await exportManyUsers(deps, [{ userId: 'user', today: TODAY }], now, FOREVER);
  expect(state.inserted).toEqual([{ userId: 'user', taskKey: 't1' }]);
  expect(state.saved.some((s) => s.userId === 'user' && s.patch.reconciledAt)).toBe(false);
});

/* ---------- шов «Google записал, база не записала» ---------- */

/**
 * Поддельный Google, хранящий события по идентификатору, — и настоящий
 * googleClient поверх него.
 *
 * Почему не подделка CalendarClient, как во всех тестах выше: проверяется
 * ровно то, что идентификатор события задаём МЫ и выводим его из ключа
 * задачи. Подделка клиента получает уже готовый draft и об идентификаторе
 * ничего не знает — ей пришлось бы вывести его самой, то есть повторить
 * проверяемое. Тогда мутация «убрать `id` из тела запроса» (это и значит
 * «сделать создание снова неидемпотентным») осталась бы незамеченной.
 * Здесь тело запроса разбирается так же, как его разобрал бы Google:
 * нет `id` — идентификатор выдаётся случайный, и второе создание заводит
 * ВТОРОЕ событие вместо ответа 409.
 */
function fakeCalendar() {
  const events = new Map<string, Record<string, unknown>>();
  let generated = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
    const path = new URL(url).pathname;
    const eventId = decodeURIComponent(path.split('/events/')[1] ?? '');

    if (method === 'POST') {
      generated += 1;
      const id = typeof body.id === 'string' ? body.id : `случайный-${generated}`;
      if (events.has(id)) return new Response('{}', { status: 409 });
      events.set(id, { ...body, id });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    if (method === 'PATCH') {
      const existing = events.get(eventId);
      if (!existing) return new Response('{}', { status: 404 });
      events.set(eventId, { ...existing, ...body, id: eventId });
      return new Response(JSON.stringify({ id: eventId }), { status: 200 });
    }
    if (method === 'DELETE') {
      if (!events.delete(eventId)) return new Response('{}', { status: 404 });
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ items: [...events.values()] }), { status: 200 });
  };
  return { events, fetcher };
}

/**
 * Зависимости с ЖИВОЙ таблицей связок и настоящим клиентом Google поверх
 * поддельной сети. Живая таблица здесь несущая: весь смысл проверки в том,
 * что второй проход видит последствия первого (или не видит — когда запись
 * связки сорвалась).
 */
function liveDeps(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  tasks: Task[],
) {
  const state = { links: [] as ExportLink[], saveLinkFails: false };
  const deps: ExportDeps = {
    getExport: async () => ({
      calendarId: 'cal-1', enabled: true, syncedAt: null, reconciledAt: null, brokenAt: null,
    }),
    saveExportState: async () => {},
    getLinks: async () => state.links,
    saveLink: async (_u, link) => {
      if (state.saveLinkFails) throw new Error('пул соединений исчерпан');
      state.links = [...state.links.filter((l) => l.taskKey !== link.taskKey), link];
    },
    deleteLink: async (_u, key) => {
      state.links = state.links.filter((l) => l.taskKey !== key);
    },
    loadRange: async () => tasks,
    getTimezone: async () => 'Europe/Amsterdam',
    getExportUsers: async () => [],
    clientFor: async () => googleClient('zz-token', fetcher),
  };
  return { deps, state };
}

// Находка I1 финального ревью, и тот самый шов, который до сих пор не был
// закрыт ни одним тестом: запись в Google удалась, запись в базу — нет.
// Событие уже лежит в календаре с нашей меткой, связки на него нет, и через
// пять минут разбор разницы снова не видит связки. Пока идентификатор
// назначал Google, здесь заводилось ВТОРОЕ событие — навсегда: разбор
// разницы убирает только СВЯЗАННЫЕ лишние события, а суточная сверка чинит
// только связки и мимо этого дубля проходит (связка на ключ уже есть).
test('сбой записи связки после удачного создания не плодит второе событие', async () => {
  const google = fakeCalendar();
  const tasks = [task()];
  const { deps, state } = liveDeps(google.fetcher, tasks);

  state.saveLinkFails = true;
  const first = await exportUser(deps, 'zz-user', TODAY, FOREVER);
  expect(first.failed).toBe(1);
  expect(google.events.size).toBe(1);
  expect(state.links).toEqual([]);

  // Следующий проход. Задача успела поменяться — заодно видно, что 409
  // не просто проглочен, а событие доведено до текущего вида задачи.
  tasks[0] = task({ title: 'ZZ-другое название' });
  state.saveLinkFails = false;
  const second = await exportUser(deps, 'zz-user', TODAY, FOREVER);

  expect(google.events.size).toBe(1);
  expect(second).toEqual({ applied: 1, failed: 0 });
  expect(state.links).toEqual([
    { taskKey: 't1', eventId: eventIdFor('t1'), fingerprint: fingerprintOf(tasks[0]) },
  ]);
  expect([...google.events.values()][0]).toMatchObject({
    id: eventIdFor('t1'), summary: 'ZZ-другое название', status: 'confirmed',
  });
});

// Тот же дубль достижим вообще без сбоя базы: synced_at пишется в КОНЦЕ
// прохода, замка нет, и если один проход затянулся дольше минуты, следующий
// тик планировщика считает ту же разницу по той же пустой таблице связок.
test('наложившиеся проходы планировщика не плодят второе событие', async () => {
  const google = fakeCalendar();
  const { deps, state } = liveDeps(google.fetcher, [task()]);

  // Второй проход начался, пока первый ещё не дописал связку: таблица для
  // него та же, что была в начале первого.
  const stale: ExportLink[] = [];
  deps.getLinks = async () => stale;

  await exportUser(deps, 'zz-user', TODAY, FOREVER);
  const second = await exportUser(deps, 'zz-user', TODAY, FOREVER);

  expect(google.events.size).toBe(1);
  expect(second.failed).toBe(0);
  expect(state.links).toEqual([
    { taskKey: 't1', eventId: eventIdFor('t1'), fingerprint: fingerprintOf(task()) },
  ]);
});

/* ---------- кого вообще выгружаем ---------- */

// Находка I2 финального ревью. Список владельцев планировщик собирает
// из подписок на пуши — он нужен напоминаниям. Для выгрузки это правило
// чужое: человек нажал «Включить», ему завели «Расписание» в Google
// и пообещали держать в нём задачи, а уведомления он не включал — и стадия
// не доходила до него НИКОГДА, без единой ошибки где бы то ни было.
test('владелец с включённой выгрузкой и без подписки на пуши всё равно выгружается', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const { deps, state } = setupMany(
    { 'без-пушей': { syncedAt: null } },
    { tasks: { 'без-пушей': [task({ id: 'p1' })] } },
  );
  deps.getExportUsers = async () => ['без-пушей'];

  // Список от планировщика ПУСТ: подписки на пуши у человека нет.
  const result = await exportManyUsers(deps, [], now, FOREVER);

  expect(state.inserted).toEqual([{ userId: 'без-пушей', taskKey: 'p1' }]);
  expect(result.applied).toBe(1);
});

// Тот же владелец не должен попасть в список дважды: второй проход
// по тому же человеку в том же тике — это лишний поход в Google и лишняя
// трата общего бюджета.
test('владелец, который есть и в подписках, и в выгрузке, обходится один раз', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const { deps, state } = setupMany({ оба: { syncedAt: null } }, { tasks: { оба: [task({ id: 'b1' })] } });
  deps.getExportUsers = async () => ['оба'];

  await exportManyUsers(deps, [{ userId: 'оба', today: TODAY }], now, FOREVER);

  // getExport читается дважды и на ОДНОМ верном проходе — сперва самим
  // exportManyUsers, потом exportUser внутри него (задокументированное,
  // принятое ревью тройное чтение той же строки). Дубль дедупликации
  // выглядел бы иначе: владелец обошёлся бы ПОЛНЫМ вторым проходом, и вот
  // это ловит insert — при сломанной дедупликации событие создалось бы
  // дважды.
  expect(state.visited).toEqual(['оба', 'оба']);
  expect(state.inserted).toEqual([{ userId: 'оба', taskKey: 'b1' }]);
});

// `today` дописанного владельца обязан считаться его собственным поясом,
// а не подставляться наугад: окно выгрузки отсчитывается от него, и ошибка
// на сутки означала бы выгруженный не тот день.
test('дописанному владельцу день считается его часовым поясом', async () => {
  // 23:30 UTC — в Амстердаме уже следующие сутки.
  const now = new Date('2026-09-10T23:30:00.000Z');
  const { deps } = setupMany({ поздний: { syncedAt: null } }, { tasks: { поздний: [] } });
  deps.getExportUsers = async () => ['поздний'];
  const seen: string[] = [];
  deps.loadRange = async (_u, from) => { seen.push(from); return []; };

  await exportManyUsers(deps, [], now, FOREVER);

  expect(seen).toEqual([exportWindow('2026-09-11').from]);
});

// Отказ на чтении списка не должен унести стадию целиком: те, кого
// планировщик уже собрал, выгружаются как прежде, а факт неудачи виден
// счётчиком — роут по нему пишет в лог стадию.
test('отказ чтения списка выгрузки не отменяет уже собранных владельцев', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const { deps, state } = setupMany({ известный: { syncedAt: null } },
    { tasks: { известный: [task({ id: 'k1' })] } });
  deps.getExportUsers = async () => { throw new Error('пул соединений исчерпан'); };

  const result = await exportManyUsers(deps, [{ userId: 'известный', today: TODAY }], now, FOREVER);

  expect(state.inserted).toEqual([{ userId: 'известный', taskKey: 'k1' }]);
  expect(result.failed).toBe(1);
});

// Пояс одного дописанного владельца прочитать не вышло — пропускаем его
// одного, а не всех: сосед по списку к его беде отношения не имеет.
test('отказ чтения пояса пропускает одного владельца, а не всю стадию', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const { deps, state } = setupMany(
    { кривой: { syncedAt: null }, целый: { syncedAt: null } },
    { tasks: { целый: [task({ id: 'c1' })] } },
  );
  deps.getExportUsers = async () => ['кривой', 'целый'];
  deps.getTimezone = async (userId) => {
    if (userId === 'кривой') throw new Error('пояс не читается');
    return 'Europe/Amsterdam';
  };

  const result = await exportManyUsers(deps, [], now, FOREVER);

  // Тот же принятый двойной getExport на один правильный проход, что и
  // в тесте про пересечение списков выше, — «кривой» в него не попадает
  // вовсе, его пояс не прочитался ДО первого чтения строки.
  expect(state.visited).toEqual(['целый', 'целый']);
  expect(state.inserted).toEqual([{ userId: 'целый', taskKey: 'c1' }]);
  expect(result.failed).toBe(1);
});
