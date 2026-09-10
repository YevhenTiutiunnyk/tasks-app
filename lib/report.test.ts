import { describe, expect, it } from 'vitest';
import { buildReport, describeReport, isReportEmpty, planFromEvents, planFromTasks } from './report';
import type { Task } from './types';

const FROM = '2026-09-07';   // понедельник
const TO = '2026-09-13';

function task(over: Partial<Task> & { id: string; title: string; date: string }): Task {
  return {
    startMinute: null, durationMinutes: null, allDay: true, categoryId: null,
    done: false, horizon: 'day', recurrenceId: null, recurrenceDate: null,
    ...over,
  };
}

describe('planFromTasks', () => {
  it('берёт только идентификатор и название', () => {
    // Больше в снимке ничего не нужно: даты и флаги на момент отчёта
    // читаются из настоящих задач, а не из снимка.
    expect(planFromTasks([task({ id: 'a', title: 'Кран', date: FROM })]))
      .toEqual([{ id: 'a', title: 'Кран' }]);
  });
});

describe('buildReport', () => {
  const base = { planned: [], weekFrom: FROM, weekTo: TO, current: [], monthLeft: [] };

  it('выполненная задача попадает в «выполнено»', () => {
    const report = buildReport({
      ...base,
      planned: [{ id: 'a', title: 'Кран' }],
      current: [task({ id: 'a', title: 'Кран', date: FROM, done: true })],
    });
    expect(report.done).toEqual([{ id: 'a', title: 'Кран' }]);
    expect(report.notDone).toEqual([]);
  });

  it('невыполненная задача своей недели попадает в «не выполнено»', () => {
    const report = buildReport({
      ...base,
      planned: [{ id: 'a', title: 'Кран' }],
      current: [task({ id: 'a', title: 'Кран', date: TO })],
    });
    expect(report.notDone).toEqual([{ id: 'a', title: 'Кран' }]);
  });

  it('уехавшая за пределы недели попадает в «перенесено»', () => {
    const report = buildReport({
      ...base,
      planned: [{ id: 'a', title: 'Кран' }],
      current: [task({ id: 'a', title: 'Кран', date: '2026-09-14' })],
    });
    expect(report.postponed).toEqual([{ id: 'a', title: 'Кран' }]);
    expect(report.notDone).toEqual([]);
  });

  it('выполненная и уехавшая за пределы недели — всё равно «выполнено», а не «перенесено»', () => {
    // Порядок проверок в buildReport важен: task.done проверяется раньше
    // диапазона дат, и задача, которую сделали и после этого перенесли на
    // другую неделю, обязана остаться «выполненной». Это решение спеки
    // (её таблица перечисляет done первым), но ничего в типах его не
    // защищает — сам тест и есть защита от будущей перестановки веток.
    const report = buildReport({
      ...base,
      planned: [{ id: 'a', title: 'Кран' }],
      current: [task({ id: 'a', title: 'Кран', date: '2026-09-20', done: true })],
    });
    expect(report.done).toEqual([{ id: 'a', title: 'Кран' }]);
    expect(report.postponed).toEqual([]);
  });

  it('сдвиг ВНУТРИ недели переносом не считается', () => {
    // Главное решение спеки. Задача стояла на понедельник, уехала на среду
    // и сделана — это «выполнено», а не «перенесено». Без этого теста
    // решение держалось бы на словах.
    const report = buildReport({
      ...base,
      planned: [{ id: 'a', title: 'Кран' }],
      current: [task({ id: 'a', title: 'Кран', date: '2026-09-09', done: true })],
    });
    expect(report.done).toEqual([{ id: 'a', title: 'Кран' }]);
    expect(report.postponed).toEqual([]);
  });

  it('исчезнувшая задача попадает в «убрана», с названием из снимка', () => {
    const report = buildReport({ ...base, planned: [{ id: 'a', title: 'Кран' }] });
    expect(report.removed).toEqual([{ id: 'a', title: 'Кран' }]);
  });

  it('сделанное сверх плана видно отдельно', () => {
    const report = buildReport({
      ...base,
      current: [task({ id: 'b', title: 'Внеплановое', date: FROM, done: true })],
    });
    expect(report.extra).toEqual([{ id: 'b', title: 'Внеплановое' }]);
  });

  it('несделанное сверх плана в отчёт не идёт', () => {
    // Иначе «сверх плана» превратилось бы в свалку всего, что человек
    // завёл посреди недели и не тронул.
    const report = buildReport({
      ...base,
      current: [task({ id: 'b', title: 'Внеплановое', date: FROM })],
    });
    expect(report.extra).toEqual([]);
  });

  it('вхождение повтора, отмеченное выполненным, попадает в «выполнено», а не в «убрана» и «сверх плана» разом', () => {
    // Самый тонкий случай всего отчёта. В снимке лежит синтетический
    // идентификатор нераскрытого вхождения; стоит отметить занятие
    // выполненным, как оно материализуется настоящей строкой с новым uuid.
    // Сличай по одному id — и одна тренировка попадёт сразу в два списка.
    const RULE = '11111111-1111-4111-8111-111111111111';
    const report = buildReport({
      ...base,
      planned: [{ id: `occ:${RULE}:2026-09-09`, title: 'Спортзал' }],
      current: [
        task({
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Спортзал', date: '2026-09-09', done: true,
          recurrenceId: RULE, recurrenceDate: '2026-09-09',
        }),
      ],
    });
    expect(report.done).toEqual([{ id: `occ:${RULE}:2026-09-09`, title: 'Спортзал' }]);
    expect(report.removed).toEqual([]);
    expect(report.extra).toEqual([]);
  });

  it('нераскрытое вхождение сличается по своему идентификатору', () => {
    const RULE = '11111111-1111-4111-8111-111111111111';
    const id = `occ:${RULE}:2026-09-09`;
    const report = buildReport({
      ...base,
      planned: [{ id, title: 'Спортзал' }],
      current: [task({ id, title: 'Спортзал', date: '2026-09-09', recurrenceId: RULE, recurrenceDate: '2026-09-09' })],
    });
    expect(report.notDone).toEqual([{ id, title: 'Спортзал' }]);
    expect(report.removed).toEqual([]);
  });

  it('месячные передаются отдельным списком и в недельный счёт не входят', () => {
    const report = buildReport({
      ...base,
      monthLeft: [task({ id: 'm', title: 'Отчёт', date: '2026-09-01', horizon: 'month' })],
    });
    expect(report.monthLeft).toEqual([{ id: 'm', title: 'Отчёт' }]);
    expect(report.notDone).toEqual([]);
  });
});

describe('isReportEmpty', () => {
  it('пустой отчёт — когда пусты все списки', () => {
    expect(isReportEmpty(buildReport({
      planned: [], weekFrom: FROM, weekTo: TO, current: [], monthLeft: [],
    }))).toBe(true);
  });

  it('неделя, где всё провалено, пустой НЕ считается', () => {
    // «5 не сделано» — это ровно тот отчёт, ради которого всё затевалось,
    // и промолчать про него было бы худшей из возможных ошибок.
    const report = buildReport({
      planned: [{ id: 'a', title: 'Кран' }], weekFrom: FROM, weekTo: TO,
      current: [task({ id: 'a', title: 'Кран', date: FROM })], monthLeft: [],
    });
    expect(isReportEmpty(report)).toBe(false);
  });

  it('одни только месячные напоминания пустым отчётом не считаются', () => {
    const report = buildReport({
      planned: [], weekFrom: FROM, weekTo: TO, current: [],
      monthLeft: [task({ id: 'm', title: 'Отчёт', date: '2026-09-01', horizon: 'month' })],
    });
    expect(isReportEmpty(report)).toBe(false);
  });
});

describe('describeReport', () => {
  it('обычный случай — «сделано · перенесено · не сделано»', () => {
    const report = buildReport({
      planned: [
        { id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' },
      ],
      weekFrom: FROM, weekTo: TO, monthLeft: [],
      current: [
        task({ id: 'a', title: 'A', date: FROM, done: true }),
        task({ id: 'b', title: 'B', date: '2026-09-20' }),
        task({ id: 'c', title: 'C', date: TO }),
      ],
    });
    expect(describeReport(report)).toEqual({
      title: 'Итоги недели',
      body: '1 сделано · 1 перенесено · 1 не сделано',
    });
  });

  it('отчёт из одной только «убрано» даёт непустое тело', () => {
    // Раньше в тело шли только done/postponed/notDone: неделя, где
    // единственным содержанием была удалённая из снимка задача, проходила
    // isReportEmpty как непустая, но получала пустой текст пуша.
    const report = buildReport({
      planned: [{ id: 'a', title: 'Кран' }], weekFrom: FROM, weekTo: TO,
      current: [], monthLeft: [],
    });
    expect(isReportEmpty(report)).toBe(false);
    expect(describeReport(report).body).toBe('1 убрано');
  });

  it('отчёт из одного только «сверх плана» даёт непустое тело', () => {
    const report = buildReport({
      planned: [], weekFrom: FROM, weekTo: TO, monthLeft: [],
      current: [task({ id: 'b', title: 'Внеплановое', date: FROM, done: true })],
    });
    expect(isReportEmpty(report)).toBe(false);
    expect(describeReport(report).body).toBe('1 сверх плана');
  });

  it('отчёт из одних только месячных даёт непустое тело', () => {
    // Самый частый случай пустой недели: ничего не планировали, но в
    // месячном списке есть дела. Раньше это был ровно тот отчёт, что
    // отмечался отправленным и уходил с пустым текстом.
    const report = buildReport({
      planned: [], weekFrom: FROM, weekTo: TO, current: [],
      monthLeft: [task({ id: 'm', title: 'Отчёт', date: '2026-09-01', horizon: 'month' })],
    });
    expect(isReportEmpty(report)).toBe(false);
    expect(describeReport(report).body).toBe('1 осталось на месяц');
  });
});

describe('встречи в отчёте', () => {
  it('снимок помечает встречи видом и принадлежностью', () => {
    const planned = planFromEvents([{
      calendarId: 'primary', eventId: 'e1', title: 'ZZ-созвон', date: '2026-09-09',
      startMinute: 600, durationMinutes: 60, allDay: false, mine: false,
    }], 'zz-owner');
    expect(planned).toEqual([{ id: 'gcal:zz-owner:primary:e1', title: 'ZZ-созвон', kind: 'event', mine: false }]);
  });

  it('многодневная и полуночная встреча схлопывается в одну запись снимка', () => {
    // Раскладка по дням даёт несколько кусков с ОДНИМ и тем же eventKey:
    // отпуск на три дня — три куска, созвон через полночь — два. Без
    // схлопывания это читалось бы как «3 встречи» и «2 встречи» вместо
    // одной каждая (находка I1 финального ревью).
    const trip = ['2026-09-07', '2026-09-08', '2026-09-09'].map((date) => ({
      calendarId: 'primary', eventId: 'trip', title: 'ZZ-отпуск', date,
      startMinute: null, durationMinutes: null, allDay: true, mine: true,
    }));
    const overnight = [
      { calendarId: 'primary', eventId: 'call', title: 'ZZ-полуночный-созвон', date: '2026-09-09', startMinute: 1380, durationMinutes: 60, allDay: false, mine: false },
      { calendarId: 'primary', eventId: 'call', title: 'ZZ-полуночный-созвон', date: '2026-09-10', startMinute: 0, durationMinutes: 60, allDay: false, mine: false },
    ];
    const planned = planFromEvents([...trip, ...overnight], 'zz-owner');
    expect(planned).toHaveLength(2);
    expect(planned.map((entry) => entry.id).sort()).toEqual(
      ['gcal:zz-owner:primary:call', 'gcal:zz-owner:primary:trip'].sort(),
    );
  });

  it('встреча состоялась, уехала и отменилась', () => {
    const planned = [
      { id: 'gcal:zz-owner:primary:held', title: 'ZZ-состоялась', kind: 'event' as const, mine: true },
      { id: 'gcal:zz-owner:primary:moved', title: 'ZZ-уехала', kind: 'event' as const, mine: false },
      { id: 'gcal:zz-owner:primary:gone', title: 'ZZ-отменена', kind: 'event' as const, mine: false },
    ];
    const report = buildReport({
      planned, weekFrom: '2026-09-07', weekTo: '2026-09-13', current: [], monthLeft: [], userId: 'zz-owner',
      currentEvents: [
        { calendarId: 'primary', eventId: 'held', title: 'ZZ-состоялась', date: '2026-09-09', startMinute: 600, durationMinutes: 60, allDay: false, mine: true },
        { calendarId: 'primary', eventId: 'moved', title: 'ZZ-уехала', date: '2026-09-20', startMinute: 600, durationMinutes: 60, allDay: false, mine: false },
      ],
    });
    expect(report.eventsHeld.map((entry) => entry.id)).toEqual(['gcal:zz-owner:primary:held']);
    expect(report.eventsMoved.map((entry) => entry.id)).toEqual(['gcal:zz-owner:primary:moved']);
    expect(report.eventsCancelled.map((entry) => entry.id)).toEqual(['gcal:zz-owner:primary:gone']);
  });

  it('старый снимок без kind читается как задачи', () => {
    // Гарантия совместимости: снимки, записанные до появления календаря,
    // не несут ни kind, ни mine. Их отсутствие в бою — а не в тесте —
    // означает «это задача», иначе первый же понедельник после выкладки
    // уронит отчёт на снимке прошлой недели.
    const report = buildReport({
      planned: [{ id: 'task-1', title: 'ZZ-задача' }],
      weekFrom: '2026-09-07', weekTo: '2026-09-13', current: [], monthLeft: [], currentEvents: [],
    });
    expect(report.removed.map((entry) => entry.id)).toEqual(['task-1']);
    expect(report.eventsCancelled).toEqual([]);
  });

  it('текст пуша называет встречи и чужие переносы', () => {
    const report = buildReport({
      planned: [
        { id: 'gcal:zz-owner:primary:a', title: 'ZZ-1', kind: 'event' as const, mine: true },
        { id: 'gcal:zz-owner:primary:b', title: 'ZZ-2', kind: 'event' as const, mine: false },
      ],
      weekFrom: '2026-09-07', weekTo: '2026-09-13', current: [], monthLeft: [], userId: 'zz-owner',
      currentEvents: [
        { calendarId: 'primary', eventId: 'a', title: 'ZZ-1', date: '2026-09-09', startMinute: 600, durationMinutes: 60, allDay: false, mine: true },
      ],
    });
    expect(isReportEmpty(report)).toBe(false);
    expect(describeReport(report).body).toBe('2 встречи, из них 1 изменили без вас');
  });
});
