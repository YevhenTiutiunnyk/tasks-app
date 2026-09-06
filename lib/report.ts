import { parseOccurrenceId } from './recurrence';
import type { Task } from './types';

/** Запись снимка: всё, что нужно знать о задаче, которой может не стать. */
export interface PlannedTask {
  id: string;
  title: string;
}

export interface WeeklyReport {
  done: PlannedTask[];
  notDone: PlannedTask[];
  postponed: PlannedTask[];
  removed: PlannedTask[];
  extra: PlannedTask[];
  monthLeft: PlannedTask[];
}

function short(task: Task): PlannedTask {
  return { id: task.id, title: task.title };
}

/**
 * Снимок недели: что запланировано, в момент её начала.
 *
 * Кладём только идентификатор и название. Даты и флаги на момент отчёта
 * читаются из настоящих задач — снимок нужен не как копия состояния,
 * а как список «вот что я собирался сделать».
 */
export function planFromTasks(tasks: Task[]): PlannedTask[] {
  return tasks.map(short);
}

/**
 * Та ли это задача, что записана в снимке.
 *
 * Обычные сличаются по идентификатору. Вхождения повторов — нет, и это
 * самое тонкое место отчёта: в снимке лежит синтетический `occ:<правило>:<дата>`,
 * но стоит отметить занятие выполненным, как materializeOccurrence заводит
 * настоящую строку с новым uuid. Сличай по одному идентификатору — и одна
 * и та же тренировка попадёт разом в «убрана» и в «сделано сверх плана».
 */
function isSame(planned: PlannedTask, task: Task): boolean {
  const occurrence = parseOccurrenceId(planned.id);
  if (!occurrence) return task.id === planned.id;
  return (
    task.recurrenceId === occurrence.recurrenceId && task.recurrenceDate === occurrence.date
  );
}

/**
 * Сравнение снимка с тем, что стало.
 *
 * Чистая функция: ни базы, ни часов. Вызывающий собирает `current` — все
 * задачи, имеющие отношение к сравнению: те, что сейчас лежат в этой неделе,
 * и те, что нашлись по идентификаторам из снимка за её пределами. Без
 * вторых нельзя отличить «перенесена» от «убрана».
 */
export function buildReport(input: {
  planned: PlannedTask[];
  weekFrom: string;
  weekTo: string;
  current: Task[];
  monthLeft: Task[];
}): WeeklyReport {
  const { planned, weekFrom, weekTo, current, monthLeft } = input;
  const report: WeeklyReport = {
    done: [], notDone: [], postponed: [], removed: [], extra: [],
    monthLeft: monthLeft.map(short),
  };

  const matched = new Set<Task>();

  for (const entry of planned) {
    const task = current.find((candidate) => isSame(entry, candidate));
    if (!task) {
      report.removed.push(entry);
      continue;
    }
    matched.add(task);
    if (task.done) report.done.push(entry);
    else if (task.date >= weekFrom && task.date <= weekTo) report.notDone.push(entry);
    else report.postponed.push(entry);
  }

  for (const task of current) {
    // Только сделанное: иначе «сверх плана» превратилось бы в свалку всего,
    // что человек завёл посреди недели и не тронул.
    if (matched.has(task)) continue;
    if (task.done && task.date >= weekFrom && task.date <= weekTo) report.extra.push(short(task));
  }

  return report;
}

/**
 * Нечего сказать — молчим.
 *
 * Приложение, которое каждый понедельник сообщает «0 сделано, 0 не сделано»,
 * начинают игнорировать, и вместе с пустыми уведомлениями перестают замечать
 * непустые.
 */
export function isReportEmpty(report: WeeklyReport): boolean {
  return (
    report.done.length === 0 &&
    report.notDone.length === 0 &&
    report.postponed.length === 0 &&
    report.removed.length === 0 &&
    report.extra.length === 0 &&
    report.monthLeft.length === 0
  );
}

/**
 * Текст пуша с итогами недели: только непустые части, через « · ».
 *
 * Список частей здесь обязан покрывать те же шесть полей, что и
 * isReportEmpty. Раньше в пуш шли только done/postponed/notDone — и неделя,
 * где единственным содержанием была removed (задачу из снимка удалили) или
 * monthLeft (в месячном списке ещё есть дела), проходила проверку
 * isReportEmpty как непустая, но получала пустое тело пуша. К тому моменту
 * saveReport уже проставил reported_at — второго шанса на этот отчёт нет,
 * человек молча остаётся без него на всю неделю. Поэтому здесь те же шесть
 * полей, что и в isReportEmpty: непустой по isReportEmpty отчёт обязан дать
 * непустое тело.
 */
export function describeReport(report: WeeklyReport): { title: string; body: string } {
  const parts = [
    report.done.length > 0 ? `${report.done.length} сделано` : null,
    report.postponed.length > 0 ? `${report.postponed.length} перенесено` : null,
    report.notDone.length > 0 ? `${report.notDone.length} не сделано` : null,
    report.removed.length > 0 ? `${report.removed.length} убрано` : null,
    report.extra.length > 0 ? `${report.extra.length} сверх плана` : null,
    report.monthLeft.length > 0 ? `${report.monthLeft.length} осталось на месяц` : null,
  ].filter((part): part is string => part !== null);
  return { title: 'Итоги недели', body: parts.join(' · ') };
}
