import 'server-only';
import { addDays, startOfWeek, weekdayOf } from './dates';
import type { WeekSnapshot } from './db';
import { parseOccurrenceId } from './recurrence';
import {
  buildReport,
  isReportEmpty,
  planFromTasks,
  type PlannedTask,
  type WeeklyReport,
} from './report';
import type { Horizon } from './horizons';
import type { Task } from './types';

/**
 * Всё, чем модуль ходит наружу, — параметром.
 *
 * Не ради «чистоты», а ради проверяемости: с зависимостями объектом весь
 * порядок шагов — когда пора, что читать, что писать, что вернуть —
 * проверяется без базы, без часов и без сети. Внутри планировщика этот
 * порядок иначе пришлось бы ловить настоящим понедельником.
 */
export interface ReportDeps {
  getWeekSnapshot(userId: string, weekStart: string): Promise<WeekSnapshot | null>;
  saveWeekSnapshot(userId: string, weekStart: string, planned: PlannedTask[]): Promise<void>;
  saveReport(userId: string, weekStart: string, report: WeeklyReport): Promise<void>;
  loadRange(userId: string, from: string, to: string): Promise<Task[]>;
  getTasksByIds(userId: string, ids: string[]): Promise<Task[]>;
  getChecklistTasks(userId: string, horizon: Horizon, anchor: string): Promise<Task[]>;
}

/**
 * Что человек запланировал на неделю: дневные задачи и недельные пункты
 * чеклиста.
 *
 * Оба источника обязательны. loadRange отдаёт ТОЛЬКО дневной горизонт —
 * это предохранитель прошлого подпроекта, — поэтому одним им снимок собрать
 * нельзя: недельные дела, ради которых чеклист и заводился, не попали бы
 * в отчёт вовсе.
 */
async function planFor(deps: ReportDeps, userId: string, weekStart: string) {
  const [days, weekly] = await Promise.all([
    deps.loadRange(userId, weekStart, addDays(weekStart, 6)),
    deps.getChecklistTasks(userId, 'week', weekStart),
  ]);
  return planFromTasks([...days, ...weekly]);
}

/** Задачи без повторов по идентификатору: списки ниже пересекаются. */
function unique(tasks: Task[]): Task[] {
  return [...new Map(tasks.map((task) => [task.id, task])).values()];
}

/**
 * Понедельничная работа для одного человека.
 *
 * Возвращает отчёт, который надо отправить, либо null. Сама ничего
 * не отправляет: доставка — забота роута, у которого уже есть подписки
 * и клиент web-push.
 */
export async function runWeeklyReport(
  deps: ReportDeps,
  userId: string,
  today: string,
  nowMinute: number,
  workStartMinute: number,
): Promise<WeeklyReport | null> {
  if (weekdayOf(today) !== 1) return null;
  // Именно «уже наступило», а не «ровно сейчас». Планировщик может пропустить
  // конкретную минуту — сбой, задержка, холодный старт, — и равенство
  // оставило бы человека без отчёта до следующей недели, причём молча.
  if (nowMinute < workStartMinute) return null;

  const thisWeek = startOfWeek(today);
  const prevWeek = addDays(thisWeek, -7);

  let toSend: WeeklyReport | null = null;
  try {
    const snapshot = await deps.getWeekSnapshot(userId, prevWeek);
    // Снимка нет — человек начал пользоваться приложением на этой неделе,
    // сравнивать не с чем. reportedAt заполнен — уже отправляли.
    if (snapshot && snapshot.reportedAt === null) {
      const prevTo = addDays(prevWeek, 6);
      // Вхождения повторов в базу по id не ищутся: их идентификаторы
      // синтетические. Они придут из loadRange той недели.
      const realIds = snapshot.planned
        .map((entry) => entry.id)
        .filter((id) => parseOccurrenceId(id) === null);

      const [inWeek, weekly, byId, month] = await Promise.all([
        deps.loadRange(userId, prevWeek, prevTo),
        deps.getChecklistTasks(userId, 'week', prevWeek),
        deps.getTasksByIds(userId, realIds),
        deps.getChecklistTasks(userId, 'month', today),
      ]);

      const report = buildReport({
        planned: snapshot.planned,
        weekFrom: prevWeek,
        weekTo: prevTo,
        // byId нужен, чтобы отличить «перенесена» от «убрана»: задача,
        // уехавшая из недели, в inWeek уже не попадёт.
        current: unique([...inWeek, ...weekly, ...byId]),
        monthLeft: month.filter((task) => !task.done),
      });

      // Сохраняем всегда, даже пустой: иначе запуск раз в минуту будет
      // вычислять ту же пустоту весь понедельник.
      await deps.saveReport(userId, prevWeek, report);
      if (!isReportEmpty(report)) toSend = report;
    }
  } finally {
    // Снимок новой недели — в finally: беда с прошлой неделей не должна
    // оставить без данных следующую, иначе одна ошибка тихо съедает два
    // отчёта подряд. Исходное исключение при этом не глотается — оно
    // продолжает лететь наружу после этой строки.
    await deps.saveWeekSnapshot(userId, thisWeek, await planFor(deps, userId, thisWeek));
  }
  return toSend;
}
