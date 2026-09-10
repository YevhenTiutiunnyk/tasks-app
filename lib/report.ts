import { eventKey } from './notify';
import { parseOccurrenceId } from './recurrence';
import type { EventDay, Task } from './types';

/** Запись снимка: всё, что нужно знать о задаче или встрече, которой может не стать. */
export interface PlannedTask {
  id: string;
  title: string;
  /** Отсутствует у снимков, записанных до появления календаря, — это задача. */
  kind?: 'task' | 'event';
  /** Отсутствует — значит своё: у задач иначе не бывает. */
  mine?: boolean;
}

export interface WeeklyReport {
  done: PlannedTask[];
  notDone: PlannedTask[];
  postponed: PlannedTask[];
  removed: PlannedTask[];
  extra: PlannedTask[];
  monthLeft: PlannedTask[];
  eventsHeld: PlannedTask[];
  eventsMoved: PlannedTask[];
  eventsCancelled: PlannedTask[];
}

function short(task: Task): PlannedTask {
  return { id: task.id, title: task.title };
}

/**
 * Снимок недели для встреч: та же форма записи, что и у задач, но с
 * пометкой вида и принадлежности. `mine` кладём как есть — у встречи он
 * всегда есть, в отличие от задач, где отсутствие поля само по себе значит
 * «своё».
 *
 * Схлопывает по идентификатору встречи, а не мапит каждый вход как есть:
 * многодневное событие (отпуск на пять дней) и событие через полночь
 * приходят несколькими дневными кусками с ОДНИМ и тем же eventKey — без
 * схлопывания отпуск на пять дней превращался бы в «5 встреч» в отчёте,
 * а «/report» рисовал бы одну строку несколько раз с одинаковым React-ключом
 * (находка I1 финального ревью). Тот же приём, что unique() в
 * lib/report-run.ts для задач.
 */
export function planFromEvents(events: EventDay[], userId: string): PlannedTask[] {
  const byId = new Map<string, PlannedTask>();
  for (const event of events) {
    const id = eventKey(event, userId);
    if (!byId.has(id)) {
      byId.set(id, { id, title: event.title, kind: 'event', mine: event.mine });
    }
  }
  return [...byId.values()];
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
  /** Текущие встречи прошлой недели — по ним видно, что состоялось, а что нет. */
  currentEvents?: EventDay[];
  /**
   * Владелец — часть ключа встречи (см. eventKey), нужен только для
   * сравнения plannedEvents с currentEvents. Необязателен: снимок без
   * событий (в том числе снимки, записанные до появления календаря)
   * этим полем не пользуется вовсе.
   */
  userId?: string;
}): WeeklyReport {
  const { planned, weekFrom, weekTo, current, monthLeft, currentEvents = [], userId = '' } = input;
  const report: WeeklyReport = {
    done: [], notDone: [], postponed: [], removed: [], extra: [],
    monthLeft: monthLeft.map(short),
    eventsHeld: [], eventsMoved: [], eventsCancelled: [],
  };

  // Отсутствие kind — признак снимка, записанного до появления календаря:
  // весь он состоит из задач. Такое поведение обязано сохраниться навсегда,
  // иначе первый же понедельник после выкладки уронит отчёт на боевом
  // снимке прошлой недели.
  const plannedTasks = planned.filter((entry) => (entry.kind ?? 'task') === 'task');
  const plannedEvents = planned.filter((entry) => entry.kind === 'event');

  const matched = new Set<Task>();

  for (const entry of plannedTasks) {
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

  for (const entry of plannedEvents) {
    const event = currentEvents.find((candidate) => eventKey(candidate, userId) === entry.id);
    if (!event) {
      report.eventsCancelled.push(entry);
    } else if (event.date >= weekFrom && event.date <= weekTo) {
      report.eventsHeld.push(entry);
    } else {
      report.eventsMoved.push(entry);
    }
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
    report.monthLeft.length === 0 &&
    report.eventsHeld.length === 0 &&
    report.eventsMoved.length === 0 &&
    report.eventsCancelled.length === 0
  );
}

/** Склонение «встреча/встречи/встреч» для количества N. */
function meetingsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'встреча';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'встречи';
  return 'встреч';
}

/**
 * Текст пуша с итогами недели: только непустые части, через « · ».
 *
 * Список частей здесь обязан покрывать те же девять полей, что и
 * isReportEmpty. Раньше в пуш шли только done/postponed/notDone — и неделя,
 * где единственным содержанием была removed (задачу из снимка удалили) или
 * monthLeft (в месячном списке ещё есть дела), проходила проверку
 * isReportEmpty как непустая, но получала пустое тело пуша. К тому моменту
 * saveReport уже проставил reported_at — второго шанса на этот отчёт нет,
 * человек молча остаётся без него на всю неделю. Поэтому здесь те же девять
 * полей, что и в isReportEmpty: непустой по isReportEmpty отчёт обязан дать
 * непустое тело.
 *
 * Часть про встречи — не «N сделано · M отменено» по тем же словам, что
 * у задач: Google не сообщает, кто именно изменил событие, и различие
 * «моё/чужое» держится на организаторе. Поэтому одна общая цифра «N встреч»
 * и отдельная «из них M изменили без вас» — «изменили», а не «перенесли»,
 * потому что M считает и перенесённые, и отменённые, а отмена переносом
 * не является.
 */
export function describeReport(report: WeeklyReport): { title: string; body: string } {
  const eventsTotal = report.eventsHeld.length + report.eventsMoved.length + report.eventsCancelled.length;
  const changedWithoutMe = [...report.eventsMoved, ...report.eventsCancelled]
    .filter((entry) => entry.mine === false).length;

  // «Из них M изменили без вас» — не отдельная часть в общем списке через
  // « · », а хвост той же фразы про встречи через запятую: это одно
  // сообщение о встречах, а не два самостоятельных пункта.
  const eventsPart = eventsTotal > 0
    ? `${eventsTotal} ${meetingsWord(eventsTotal)}`
      + (changedWithoutMe > 0 ? `, из них ${changedWithoutMe} изменили без вас` : '')
    : null;

  const parts = [
    report.done.length > 0 ? `${report.done.length} сделано` : null,
    report.postponed.length > 0 ? `${report.postponed.length} перенесено` : null,
    report.notDone.length > 0 ? `${report.notDone.length} не сделано` : null,
    report.removed.length > 0 ? `${report.removed.length} убрано` : null,
    report.extra.length > 0 ? `${report.extra.length} сверх плана` : null,
    report.monthLeft.length > 0 ? `${report.monthLeft.length} осталось на месяц` : null,
    eventsPart,
  ].filter((part): part is string => part !== null);
  return { title: 'Итоги недели', body: parts.join(' · ') };
}
