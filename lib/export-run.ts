import 'server-only';
import type { GoogleEvent } from './calendar';
import { addDays } from './dates';
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

/** Раз в сутки между полными сверками у одного владельца. */
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Запас страниц на один обход полной сверки — тот же приём и то же число,
 * что MAX_PAGES в lib/calendar-run.ts: ошибка на стороне Google или в моке
 * теста не должна закрутить цикл навечно и съесть весь запуск планировщика.
 */
const MAX_RECONCILE_PAGES = 100;

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
 * Полная сверка таблицы связок с тем, что реально лежит в календаре.
 *
 * Быстрый проход exportUser сравнивает задачи с НАШЕЙ ЖЕ таблицей связок
 * и не видит правки, сделанные руками прямо в Google: событие, которое
 * человек удалил или подвинул через интерфейс Google, для него неотличимо
 * от нетронутого — отпечаток совпадает, разницы нет. Эта функция —
 * единственное место, которое сверяется с действительностью, а не
 * с собственной записью о ней.
 *
 * Чинит ТОЛЬКО связки, никогда не события: заводить второй механизм,
 * который тоже «приводит календарь в порядок», нельзя — рано или поздно
 * он разошёлся бы с обычным разбором разницы в том, что считать порядком.
 * Почин связок здесь ровно на то и рассчитан: обычный diffExport на этом
 * же проходе (exportManyUsers) увидит починенное и доведёт дело до конца —
 * создаст событие заново или поправит его под задачу.
 *
 * Отметку `reconciledAt` не ставит — она в других единицах (часы), про
 * которые эта функция ничего не знает, и ставит её вызывающий.
 */
export async function reconcileLinks(
  deps: ExportDeps, userId: string, today: string,
): Promise<number> {
  const row = await deps.getExport(userId);
  // Тот же список причин «трогать нечего», что и в exportUser: выключенная
  // или ещё не заведённая выгрузка, сломанная связь — во всех случаях
  // сверяться не с чем или незачем.
  if (row === null || !row.enabled || row.brokenAt !== null || row.calendarId === null) {
    return 0;
  }
  const calendarId = row.calendarId;
  const client = await deps.clientFor(userId);

  // Окно то же самое, что у обычной выгрузки: связка на событие ЗА
  // пределами окна экспорта всё равно ушла бы обычным разбором разницы
  // как лишняя, а сверке про такие события знать незачем.
  //
  // С запасом в сутки на каждом краю — как loadWeek в lib/week.ts. Задача
  // хранится местной датой и местной минутой, а событие в Google уходит
  // тем же местным временем (стенные часы плюс имя пояса), но границы
  // здесь — UTC-полночь. Без запаса задача на последний день окна, начатая
  // вечером по местному времени восточнее Гринвича, окажется в UTC уже
  // ЗА timeMax, и Google её не вернёт. Цена ошибки — не «прочитали чуть
  // меньше»: связка на такое событие выглядит для сверки отсутствующей,
  // сверка её снимает, а обычный разбор разницы на этом же проходе создаёт
  // ВТОРОЕ событие взамен — первое остаётся в Google без связки навсегда,
  // потому что diffExport убирает только СВЯЗАННЫЕ лишние события, а сверка
  // чинит только связки, не события. Читать лишние сутки безопасно:
  // событие вне настоящего окна экспорта просто не найдёт себе задачи
  // и не тронет ничего.
  const window = exportWindow(today);
  const timeMin = `${addDays(window.from, -1)}T00:00:00.000Z`;
  const timeMax = `${addDays(window.to, 2)}T00:00:00.000Z`;

  // Постраничный обход — как syncCalendar в lib/calendar-run.ts. Обрыв
  // посередине НИКОГДА не считается успехом: на этом уже спотыкались
  // в ступени A, где усечённый обходом список уезжал в замену как будто
  // это была вся копия. Здесь цена обрыва та же по духу — неполный список
  // живых событий означал бы, что сверка снимает связки на события,
  // которые на самом деле есть, — поэтому при сбое посередине обхода
  // функция бросает исключение целиком, не чиня ничего наполовину.
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    pages += 1;
    if (pages > MAX_RECONCILE_PAGES) {
      throw new Error('Обход событий календаря при сверке не остановился в разумное число страниц');
    }
    const requestedPageToken = pageToken;
    const page = await client.listEvents(calendarId, { timeMin, timeMax, pageToken });
    events.push(...page.events);
    const nextPageToken = page.nextPageToken ?? undefined;
    if (nextPageToken !== undefined && nextPageToken === requestedPageToken) {
      throw new Error('Google не продвигается по страницам при сверке (повторяющийся pageToken)');
    }
    pageToken = nextPageToken;
  } while (pageToken);

  // Ловушка: адрес запроса в lib/google-api.ts всегда просит
  // showDeleted=true, и Google присылает отменённые события — тени
  // удалённых вручную встреч, а не живые события. Спутать тень с живым
  // событием значит не заметить именно то, ради чего затевалась вся
  // полная сверка: событие, удалённое руками, выглядело бы «присутствующим»,
  // и его связка пережила бы сверку нетронутой.
  const live = events.filter((event) => event.status !== 'cancelled');
  const byEventId = new Map(live.map((event) => [event.id, event]));
  const byTaskKey = new Map<string, GoogleEvent>();
  for (const event of live) {
    // Событие без нашей метки не трогается вовсе: это не наше — может быть
    // приглашением или встречей, заведённой руками прямо в этом календаре.
    const taskKey = event.extendedProperties?.private?.taskKey;
    if (taskKey === undefined) continue;
    // Две живых записи с одной и той же меткой в норме невозможны —
    // insertEvent заводит ровно одну на задачу, — но ручная правка в Google
    // может это нарушить. Сверка не решает, какая из двух «настоящая»: это
    // была бы уже правка события, а не связки, второй механизм, которого
    // мы сознательно не заводим. Берём ту, что попалась последней в обходе,
    // вторая тихо остаётся без связки — не хуже, чем было до сверки.
    byTaskKey.set(taskKey, event);
  }

  const links = await deps.getLinks(userId);
  let fixed = 0;

  // Связка, чьего события в календаре больше нет (ни живого, ни вовсе
  // никакого), — снимается. Обычный разбор разницы на этом же проходе
  // увидит задачу без связки и создаст событие заново.
  //
  // linkedTaskKeys собирается ДО цикла и правится тут же по ходу удаления,
  // а не строится заново из исходного `links` после него: `links` — это
  // снимок связок на момент чтения, снятие связки его не меняет. Без правки
  // на лету восстановление ниже могло бы решить, что метка уже связана,
  // хотя её связку только что сняли в этом же проходе, — и не восстановить
  // связку по другому, ещё живому событию с той же меткой (обычный разбор
  // разницы завёл бы для задачи ТРЕТЬЕ событие, не увидев связку вовсе).
  const linkedTaskKeys = new Set(links.map((link) => link.taskKey));
  for (const link of links) {
    if (!byEventId.has(link.eventId)) {
      await deps.deleteLink(userId, link.taskKey);
      linkedTaskKeys.delete(link.taskKey);
      fixed += 1;
    }
  }

  // Событие с нашей меткой, у которого нет связки, — связка восстанавливается
  // с ЗАВЕДОМО несовпадающим (пустым) отпечатком. Это не небрежность:
  // отпечаток обязан разойтись с любым настоящим, чтобы обычный разбор
  // разницы на этом же проходе счёл событие устаревшим и поправил его
  // под текущее состояние задачи — тем самым механизмом, а не вторым.
  for (const [taskKey, event] of byTaskKey) {
    if (linkedTaskKeys.has(taskKey)) continue;
    await deps.saveLink(userId, { taskKey, eventId: event.id, fingerprint: '' });
    fixed += 1;
  }

  return fixed;
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
      const dueForReconcile = row === null || row.reconciledAt === null
          || now.getTime() - new Date(row.reconciledAt).getTime() >= RECONCILE_INTERVAL_MS;
      // Тот же список причин «сверять нечего», что и первой строкой внутри
      // самой reconcileLinks (третье чтение той же строки — известный,
      // сознательно не устраняемый повтор, см. финальное ревью ступени B).
      // Проверяем его и здесь, а не только внутри reconcileLinks: без этого
      // saveExportState({reconciledAt:true}) ниже проставлялся бы даже
      // владельцу, для которого сверка заведомо не могла пройти (выключена,
      // сломана, календаря нет), — и первая НАСТОЯЩАЯ сверка после починки
      // доступа откладывалась бы ещё на сутки, хотя в этот момент она нужнее
      // всего.
      const canReconcile = row !== null && row.enabled && row.brokenAt === null
          && row.calendarId !== null;
      if (dueForReconcile && canReconcile) {
        try {
          // Раз в сутки — перед обычным проходом, а не вместо него: полная
          // сверка чинит только таблицу связок по тому, что реально лежит
          // в Google, и тут же отдаёт работу обычному exportUser этим же
          // вызовом ниже — он на свежепочиненных связках доведёт календарь
          // до задач в ТОТ ЖЕ проход, а не через сутки. Отметку ставим сами:
          // reconcileLinks не знает про часы. Бюджет общий: сверка тратит
          // его наравне с остальным, отдельного потолка для неё не заводим.
          await reconcileLinks(deps, userId, today);
          // Отметку ставим ТОЛЬКО когда сверка реально прошла до конца:
          // если её оборвал отказ ниже, reconciledAt обязан остаться
          // прежним, а не свежим, — иначе следующая (настоящая) попытка
          // отложится ещё на сутки.
          await deps.saveExportState(userId, { reconciledAt: true });
        } catch (error) {
          if (error instanceof CalendarAccessLost || error instanceof CalendarGone) {
            // clientFor и listEvents бросают эти же отказы, что и обычный
            // проход, — и они обязаны получить то же лечение (находка C2
            // ревью ступени A, см. комментарий у markBroken в exportUser):
            // связь помечается сломанной, а syncedAt обновляется той же
            // записью, иначе владелец опрашивался бы на каждом тике
            // планировщика вечно вместо раза в пять минут. Обычный проход
            // в этот раз не идёт вовсе: связь сломана, exportUser и сам
            // вернул бы нули, прочитав её заново.
            await deps.saveExportState(userId, { syncedAt: true, brokenAt: new Date().toISOString() });
            continue;
          }
          // Прочий отказ — погода, а не беда (сеть, квота, 500 у Google):
          // reconciledAt не трогаем, чтобы следующий тик попробовал сверку
          // заново, но и обычный проход этим не блокируем — он полезен
          // и тогда, когда список событий на секунду недоступен для чтения.
          // Без этого одна неудачная сверка морила бы владельца голодом
          // по обычной пятиминутной выгрузке до следующей суточной попытки.
        }
      }
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
