import { describe, expect, it, vi } from 'vitest';
import { runWeeklyReport, type ReportDeps } from './report-run';
import type { Task } from './types';

const MONDAY = '2026-09-14';
const PREV = '2026-09-07';

function task(id: string, title: string, date: string, done = false): Task {
  return {
    id, title, date, startMinute: null, durationMinutes: null, allDay: true,
    categoryId: null, done, horizon: 'day', recurrenceId: null, recurrenceDate: null,
  };
}

function deps(over: Partial<ReportDeps> = {}): ReportDeps {
  return {
    getWeekSnapshot: async () => null,
    saveWeekSnapshot: async () => {},
    saveReport: async () => {},
    loadRange: async () => [],
    getTasksByIds: async () => [],
    getChecklistTasks: async () => [],
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
    const saveReport = vi.fn();
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
    const saveReport = vi.fn();
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
