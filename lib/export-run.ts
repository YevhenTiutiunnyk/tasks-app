import 'server-only';
import { diffExport, draftFor, exportableTasks, exportWindow, fingerprintOf } from './export';
import { CalendarAccessLost, CalendarGone, type CalendarClient } from './google-api';
import {
  deleteLink, getExport, getLinks, getTimezone, saveExportState, saveLink,
  type ExportLink, type ExportRow,
} from './db';
import { getCalendarClient } from './google-token';
import { loadRange } from './week';
import type { Task } from './types';

/** Пять минут между проходами сверщика у одного владельца — как у синхронизации. */
const EXPORT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Всё, чем модуль ходит наружу, — параметром: тот же приём, что
 * в lib/calendar-run.ts и lib/report-run.ts. Порядок шагов — что читаем,
 * что пишем в Google, когда обновляем связку — проверяется без базы,
 * без часов и без сети.
 */
export interface ExportDeps {
  getExport(userId: string): Promise<ExportRow | null>;
  saveExportState(
    userId: string,
    state: { syncedAt?: boolean; reconciledAt?: boolean; brokenAt?: string | null },
  ): Promise<void>;
  getLinks(userId: string): Promise<ExportLink[]>;
  saveLink(userId: string, link: ExportLink): Promise<void>;
  deleteLink(userId: string, taskKey: string): Promise<void>;
  loadRange(userId: string, from: string, to: string): Promise<Task[]>;
  getTimezone(userId: string): Promise<string>;
  clientFor(userId: string): Promise<CalendarClient>;
}

/**
 * Одна операция в Google. Разница раскладывается в плоский список заранее,
 * чтобы порядок «удаления, правки, создания» был виден одной строкой,
 * а проверка бюджета и обработка отказов жили в одном месте, а не были
 * переписаны трижды по разу на каждый вид операции.
 */
type ExportOp =
  | { kind: 'remove'; link: ExportLink }
  | { kind: 'update'; task: Task; eventId: string }
  | { kind: 'create'; task: Task };

/**
 * Один проход выгрузки для одного владельца.
 *
 * `deadline` — момент в тех же единицах, что и `clock()`: обычно
 * `Date.now()` плюс бюджет. Не «сколько осталось», а именно срок: бюджет
 * общий на всех владельцев тика, и каждому следующему остаётся то, что
 * не съели предыдущие.
 *
 * `clock` параметром, а не Date.now() внутри тела, — по образцу
 * syncManyUsers: тесту нужен предсказуемый поддельный секундомер, а не
 * гонка с настоящими часами. Умолчание делает параметр невидимым для
 * обычного вызова.
 *
 * Ничего не логирует: сообщение об ошибке принесло бы в лог название
 * задачи или адрес владельца. Вызывающий получит счётчики и решит сам.
 */
export async function exportUser(
  deps: ExportDeps,
  userId: string,
  today: string,
  deadline: number,
  clock: () => number = Date.now,
): Promise<{ applied: number; failed: number }> {
  const row = await deps.getExport(userId);
  // Выгрузки нет, она выключена, или календарь ещё не заведён — трогать
  // нечего. Сломанную связь не дёргаем тем более: доступ вернёт человек
  // кнопкой в настройках, а не наши повторы каждые пять минут.
  if (row === null || !row.enabled || row.brokenAt !== null || row.calendarId === null) {
    return { applied: 0, failed: 0 };
  }
  const calendarId = row.calendarId;

  const window = exportWindow(today);
  const [tasks, links, timeZone] = await Promise.all([
    deps.loadRange(userId, window.from, window.to),
    deps.getLinks(userId),
    deps.getTimezone(userId),
  ]);
  // loadRange уже раскрыл повторы во вхождения с синтетическими ключами —
  // сверщику остаётся сравнить два списка.
  const diff = diffExport(exportableTasks(tasks), links);

  // Удаления первыми: при исчерпании бюджета лучше остаться без лишних
  // событий, чем с ними — чужой календарь не должен показывать дело,
  // которого уже нет.
  const ops: ExportOp[] = [
    ...diff.remove.map((link): ExportOp => ({ kind: 'remove', link })),
    ...diff.update.map(({ task, eventId }): ExportOp => ({ kind: 'update', task, eventId })),
    ...diff.create.map((task): ExportOp => ({ kind: 'create', task })),
  ];

  async function apply(client: CalendarClient, op: ExportOp): Promise<void> {
    if (op.kind === 'remove') {
      await client.deleteEvent(calendarId, op.link.eventId);
      await deps.deleteLink(userId, op.link.taskKey);
      return;
    }
    const draft = draftFor(op.task, timeZone);
    // Связка пишется ТОЛЬКО после ответа Google. Отпечаток, обновлённый
    // до вызова, навсегда прячет расхождение: следующий проход разницы
    // уже не увидит и чинить будет нечего.
    if (op.kind === 'update') {
      await client.patchEvent(calendarId, op.eventId, draft);
      await deps.saveLink(userId, {
        taskKey: op.task.id, eventId: op.eventId, fingerprint: fingerprintOf(op.task),
      });
      return;
    }
    const eventId = await client.insertEvent(calendarId, draft);
    await deps.saveLink(userId, {
      taskKey: op.task.id, eventId, fingerprint: fingerprintOf(op.task),
    });
  }

  /**
   * Пометка «связь сломана» и отметка о проходе — одной записью.
   *
   * Вместе, а не двумя вызовами подряд: отдельный завершающий
   * `{ syncedAt: true }` затёр бы смысл предыдущей записи для всякого, кто
   * смотрит на последний вызов, и превратил бы проверку в тесте в пустую.
   * Смысл обеих отметок при этом сохраняется: связь помечена сломанной,
   * а проход состоялся и владельца не надо опрашивать снова через минуту.
   */
  async function markBroken(): Promise<void> {
    await deps.saveExportState(userId, { syncedAt: true, brokenAt: new Date().toISOString() });
  }

  let applied = 0;
  let failed = 0;
  // Клиент берётся лениво: совпавший отпечаток обязан не стоить ни одного
  // обращения к Google, а получение клиента — это обновление токена,
  // то есть поход к Google.
  let client: CalendarClient | null = null;

  for (const op of ops) {
    // Бюджет проверяется перед КАЖДОЙ операцией, а не раз на проход:
    // не успели — доделаем следующим проходом, разница ведь считается
    // заново каждый раз и ничего не теряется.
    if (clock() > deadline) break;
    try {
      // clientFor бросает CalendarAccessLost ровно тогда, когда доступ
      // отозван на стороне Google, — потому и внутри try, вместе с самой
      // операцией: снаружи этот отказ улетел бы мимо пометки (находка C2
      // ревью ступени A, там же в lib/calendar-run.ts).
      client ??= await deps.clientFor(userId);
      await apply(client, op);
      applied += 1;
    } catch (error) {
      if (error instanceof CalendarAccessLost) {
        // Доступ отозван на стороне Google — дальше идти бессмысленно,
        // проход прекращается вне зависимости от того, на какой операции
        // это вскрылось.
        await markBroken();
        return { applied, failed };
      }
      if (error instanceof CalendarGone) {
        if (op.kind === 'create') {
          // 404 на СОЗДАНИИ не может значить «события больше нет» — оно
          // ещё не существовало. Остаётся только «пропал сам календарь»:
          // человек удалил его руками в Google. Пересоздавать молча
          // нельзя — приложение, упрямо возвращающее выкинутое, ведёт себя
          // хамски, — поэтому проход прекращается, как и при потере доступа.
          await markBroken();
          return { applied, failed };
        }
        // На правке и на удалении 404 значит другое: пропал не календарь,
        // а конкретное СОБЫТИЕ — человек удалил его руками в Google. Это
        // штатный случай, который чинит сама сверка, а не поломка выгрузки:
        // связка на несуществующее событие иначе тянула бы один и тот же
        // отказ каждые пять минут вечно. Снимаем связку и идём дальше.
        const taskKey = op.kind === 'remove' ? op.link.taskKey : op.task.id;
        await deps.deleteLink(userId, taskKey);
        // Удаление своей цели уже добилось: события и так не должно было
        // быть в Google — применённой операцией её и считаем. Правку
        // в applied не пишем: задача в этот проход в Google НЕ отражена
        // (старое событие пропало, новое ещё не создано) — но и в failed
        // не пишем, это не отказ: следующий проход создаст событие заново
        // через create, раз связки на него больше нет.
        if (op.kind === 'remove') applied += 1;
        continue;
      }
      // Прочие отказы — погода, а не беда: сорвавшееся событие подхватится
      // следующим проходом, потому что отпечаток не обновлён. Остальные
      // операции этого прохода они не отменяют.
      failed += 1;
    }
  }

  // Отметка о проходе ставится всегда, даже когда не сделано ничего: иначе
  // владелец, у которого бюджет кончается каждый раз, опрашивался бы на
  // каждом минутном тике планировщика вместо раза в пять минут.
  await deps.saveExportState(userId, { syncedAt: true });
  return { applied, failed };
}

/**
 * Выгрузка для многих владельцев с общим бюджетом времени.
 *
 * Пятиминутный интервал живёт здесь, а не в exportUser: сверщик умеет
 * пройти по требованию (кнопка «выгрузить сейчас» в настройках), и
 * запрет «ещё рано» в нём самом такую кнопку бы и запретил.
 *
 * Бюджет — потолок на всю стадию: `/api/notify` тикает раз в минуту, и
 * несколько владельцев с большой разницей подряд не должны растянуть
 * стадию настолько, что платформа оборвёт саму функцию по таймауту.
 * Владельцы, до которых бюджет не дотянул, выгрузятся следующим тиком —
 * список тот же, минута следующая.
 */
export async function exportManyUsers(
  deps: ExportDeps,
  users: { userId: string; today: string }[],
  now: Date,
  budgetMs: number,
  clock: () => number = Date.now,
): Promise<{ applied: number; failed: number }> {
  const startedAt = clock();
  const deadline = startedAt + budgetMs;
  let applied = 0;
  let failed = 0;

  for (const { userId, today } of users) {
    // Секундомер идёт только вперёд, поэтому выйти можно сразу: до
    // следующих владельцев бюджет не дотянется тем более.
    if (clock() >= deadline) break;
    const row = await deps.getExport(userId);
    // Свежих пропускаем. Строки нет вовсе — не наше дело решать: пусть
    // exportUser прочитает её сам и вернёт нули, тогда правило «кого
    // трогаем» останется в одном месте.
    if (row !== null && row.syncedAt !== null
        && now.getTime() - new Date(row.syncedAt).getTime() < EXPORT_INTERVAL_MS) continue;
    try {
      const result = await exportUser(deps, userId, today, deadline, clock);
      applied += result.applied;
      failed += result.failed;
    } catch {
      // Сбой одного владельца не должен останавливать остальных: без этого
      // транзиентная ошибка на первом означала бы, что второй и третий
      // не выгружаются никогда.
      failed += 1;
    }
  }

  return { applied, failed };
}

/**
 * Боевые зависимости. Собраны здесь, а не в каждом вызывающем: планировщик
 * и ручная выгрузка из настроек — два разных вызывающих, и если бы каждый
 * собирал набор сам, они разошлись бы молча при следующей правке ExportDeps.
 */
export const exportDeps: ExportDeps = {
  getExport, saveExportState, getLinks, saveLink, deleteLink,
  loadRange, getTimezone,
  clientFor: getCalendarClient,
};
