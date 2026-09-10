import { describe, expect, it, vi } from 'vitest';
import { runWeeklyReport, type ReportDeps } from './report-run';
import type { EventDay, Task } from './types';

const MONDAY = '2026-09-14';
const PREV = '2026-09-07';

function task(id: string, title: string, date: string, done = false): Task {
  return {
    id, title, date, startMinute: null, durationMinutes: null, allDay: true,
    categoryId: null, done, horizon: 'day', recurrenceId: null, recurrenceDate: null,
  };
}

function event(over: Partial<EventDay> & { eventId: string; title: string; date: string }): EventDay {
  return {
    calendarId: 'primary', startMinute: 600, durationMinutes: 60, allDay: false, mine: true,
    ...over,
  };
}

function deps(over: Partial<ReportDeps> = {}): ReportDeps {
  return {
    getWeekSnapshot: async () => null,
    saveWeekSnapshot: async () => {},
    saveReport: async () => true,
    loadRange: async () => [],
    getTasksByIds: async () => [],
    getChecklistTasks: async () => [],
    getWeekEvents: async () => [],
    getEventsAround: async () => [],
    ...over,
  };
}

describe('runWeeklyReport', () => {
  it('до наступления часа ничего не делает', async () => {
    const saveWeekSnapshot = vi.fn();
    const report = await runWeeklyReport(deps({ saveWeekSnapshot }), 'u', MONDAY, 480, 540);
    expect(report).toBeNull();
    expect(saveWeekSnapshot).not.toHaveBeenCalled();
  });

  it('не в понедельник ничего не делает', async () => {
    const saveWeekSnapshot = vi.fn();
    const report = await runWeeklyReport(deps({ saveWeekSnapshot }), 'u', '2026-09-15', 600, 540);
    expect(report).toBeNull();
    expect(saveWeekSnapshot).not.toHaveBeenCalled();
  });

  it('час уже прошёл — всё равно срабатывает', async () => {
    // Планировщик может пропустить конкретную минуту: сбой, задержка,
    // холодный старт. Условие «ровно workStartMinute» этого не переживёт,
    // и человек остался бы без отчёта до следующей недели.
    const saveWeekSnapshot = vi.fn();
    await runWeeklyReport(deps({ saveWeekSnapshot }), 'u', MONDAY, 900, 540);
    expect(saveWeekSnapshot).toHaveBeenCalled();
  });

  it('снимок новой недели создаётся даже без снимка прошлой', async () => {
    const saveWeekSnapshot = vi.fn();
    const report = await runWeeklyReport(
      deps({ saveWeekSnapshot, loadRange: async () => [task('a', 'Кран', MONDAY)] }),
      'u', MONDAY, 600, 540,
    );
    expect(report).toBeNull();
    expect(saveWeekSnapshot).toHaveBeenCalledWith('u', MONDAY, [{ id: 'a', title: 'Кран' }]);
  });

  it('уже отправленный отчёт второй раз не отправляется', async () => {
    const saveReport = vi.fn();
    const report = await runWeeklyReport(
      deps({
        getWeekSnapshot: async (_u, week) =>
          week === PREV
            ? { weekStart: PREV, planned: [{ id: 'a', title: 'Кран' }], report: null, reportedAt: new Date() }
            : null,
        saveReport,
      }),
      'u', MONDAY, 600, 540,
    );
    expect(report).toBeNull();
    expect(saveReport).not.toHaveBeenCalled();
  });

  it('собирает отчёт, сохраняет его и возвращает для отправки', async () => {
    const saveReport = vi.fn(async () => true);
    const report = await runWeeklyReport(
      deps({
        getWeekSnapshot: async (_u, week) =>
          week === PREV
            ? { weekStart: PREV, planned: [{ id: 'a', title: 'Кран' }], report: null, reportedAt: null }
            : null,
        getTasksByIds: async () => [task('a', 'Кран', PREV, true)],
        saveReport,
      }),
      'u', MONDAY, 600, 540,
    );
    expect(report?.done).toEqual([{ id: 'a', title: 'Кран' }]);
    expect(saveReport).toHaveBeenCalled();
  });

  it('пустой отчёт отмечается отправленным, но не возвращается', async () => {
    // Иначе запуск раз в минуту будет вычислять ту же пустоту весь
    // понедельник, а пуша всё равно не будет.
    const saveReport = vi.fn(async () => true);
    const report = await runWeeklyReport(
      deps({
        getWeekSnapshot: async (_u, week) =>
          week === PREV ? { weekStart: PREV, planned: [], report: null, reportedAt: null } : null,
        saveReport,
      }),
      'u', MONDAY, 600, 540,
    );
    expect(report).toBeNull();
    expect(saveReport).toHaveBeenCalled();
  });

  it('проигравший гонку двух запусков планировщика ничего не отправляет', async () => {
    // saveReport пишет только когда reported_at ещё null (предикат в самом
    // UPDATE) и возвращает, записала ли именно эта попытка. Два пересёкшихся
    // запуска /api/notify оба могут дойти сюда с непустым отчётом, но только
    // один из них реально запишет строку — второй обязан промолчать, а не
    // продублировать пуш поверх того, что уже ушёл от победителя.
    const saveReport = vi.fn(async () => false);
    const report = await runWeeklyReport(
      deps({
        getWeekSnapshot: async (_u, week) =>
          week === PREV
            ? { weekStart: PREV, planned: [{ id: 'a', title: 'Кран' }], report: null, reportedAt: null }
            : null,
        getTasksByIds: async () => [task('a', 'Кран', PREV, true)],
        saveReport,
      }),
      'u', MONDAY, 600, 540,
    );
    expect(saveReport).toHaveBeenCalled();
    expect(report).toBeNull();
  });

  it('снимок недели включает встречи наравне с задачами', async () => {
    const saveWeekSnapshot = vi.fn();
    await runWeeklyReport(
      deps({
        saveWeekSnapshot,
        loadRange: async () => [task('a', 'Кран', MONDAY)],
        getWeekEvents: async () => [event({ eventId: 'e1', title: 'ZZ-созвон', date: MONDAY })],
      }),
      'u', MONDAY, 600, 540,
    );
    expect(saveWeekSnapshot).toHaveBeenCalledWith('u', MONDAY, [
      { id: 'a', title: 'Кран' },
      { id: 'gcal:u:primary:e1', title: 'ZZ-созвон', kind: 'event', mine: true },
    ]);
  });

  it('отчёт видит встречи прошлой недели через getEventsAround', async () => {
    const saveReport = vi.fn(async () => true);
    const report = await runWeeklyReport(
      deps({
        getWeekSnapshot: async (_u, week) =>
          week === PREV
            ? {
                weekStart: PREV,
                planned: [{ id: 'gcal:u:primary:e1', title: 'ZZ-созвон', kind: 'event', mine: false }],
                report: null,
                reportedAt: null,
              }
            : null,
        getEventsAround: async (_u, week) =>
          week === PREV ? [event({ eventId: 'e1', title: 'ZZ-созвон', date: PREV })] : [],
        saveReport,
      }),
      'u', MONDAY, 600, 540,
    );
    expect(report?.eventsHeld).toEqual([{ id: 'gcal:u:primary:e1', title: 'ZZ-созвон', kind: 'event', mine: false }]);
  });

  it('встреча, уехавшая в другую неделю, — «перенесена», а не «отменена»', async () => {
    // Ровно тот случай, что терял getWeekEvents: раскладка там обрезана по
    // границам недели снимка, и встреча с датой за её пределами не могла
    // найтись вовсе. getEventsAround ищет по всему окну хранимой копии,
    // так что найденная-но-не-в-своей-неделе встреча обязана попасть
    // в «перенесена».
    const saveReport = vi.fn(async () => true);
    const report = await runWeeklyReport(
      deps({
        getWeekSnapshot: async (_u, week) =>
          week === PREV
            ? {
                weekStart: PREV,
                planned: [{ id: 'gcal:u:primary:e1', title: 'ZZ-уехала', kind: 'event', mine: false }],
                report: null,
                reportedAt: null,
              }
            : null,
        // Та же встреча всё ещё существует, но теперь её дата — через месяц,
        // далеко за пределами прошлой недели.
        getEventsAround: async () => [event({ eventId: 'e1', title: 'ZZ-уехала', date: '2026-10-05' })],
        saveReport,
      }),
      'u', MONDAY, 600, 540,
    );
    expect(report?.eventsMoved).toEqual([{ id: 'gcal:u:primary:e1', title: 'ZZ-уехала', kind: 'event', mine: false }]);
    expect(report?.eventsCancelled).toEqual([]);
  });

  it('встречи, которой в базе больше нет вовсе, — «отменена»', async () => {
    // Отличается от предыдущего теста только тем, что getEventsAround вообще
    // не возвращает строку с этим id: два случая легко перепутать местами,
    // раз оба дают report.eventsCancelled/eventsMoved на пустом входе.
    const saveReport = vi.fn(async () => true);
    const report = await runWeeklyReport(
      deps({
        getWeekSnapshot: async (_u, week) =>
          week === PREV
            ? {
                weekStart: PREV,
                planned: [{ id: 'gcal:u:primary:e1', title: 'ZZ-отменена', kind: 'event', mine: false }],
                report: null,
                reportedAt: null,
              }
            : null,
        getEventsAround: async () => [],
        saveReport,
      }),
      'u', MONDAY, 600, 540,
    );
    expect(report?.eventsCancelled).toEqual([{ id: 'gcal:u:primary:e1', title: 'ZZ-отменена', kind: 'event', mine: false }]);
    expect(report?.eventsMoved).toEqual([]);
  });

  it('снимок новой недели создаётся, даже если сборка отчёта упала', async () => {
    // Порядок из спеки: беда с прошлой неделей не должна оставить без данных
    // следующую.
    const saveWeekSnapshot = vi.fn();
    await expect(
      runWeeklyReport(
        deps({
          saveWeekSnapshot,
          getWeekSnapshot: async (_u, week) =>
            week === PREV ? { weekStart: PREV, planned: [{ id: 'a', title: 'К' }], report: null, reportedAt: null } : null,
          getTasksByIds: async () => { throw new Error('ZZ-обрыв'); },
        }),
        'u', MONDAY, 600, 540,
      ),
    ).rejects.toThrow('ZZ-обрыв');
    expect(saveWeekSnapshot).toHaveBeenCalled();
  });
});
