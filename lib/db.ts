import 'server-only';
import postgres from 'postgres';
import { anchorFor, type Horizon } from './horizons';
import { DEFAULT_SETTINGS, DEFAULT_TIMEZONE } from './settings-defaults';
import type { Category, Recurrence, RecurrenceException, Settings, Task } from './types';
import type { SealedKey } from './user-key';
import type { PlannedTask, WeeklyReport } from './report';

// prepare: false — обязательно для транзакционного пулера Supabase (порт 6543).
export const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

/** Postgres отдаёт date как объект Date; нам нужна строка 'YYYY-MM-DD'. */
export function toIsoDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rowToTask(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    date: toIsoDate(row.date),
    startMinute: row.start_minute,
    durationMinutes: row.duration_minutes,
    allDay: row.all_day,
    categoryId: row.category_id,
    done: row.done,
    horizon: row.horizon,
    recurrenceId: row.recurrence_id,
    recurrenceDate: row.recurrence_date ? toIsoDate(row.recurrence_date) : null,
  };
}

export function rowToRecurrence(row: any): Recurrence {
  return {
    id: row.id,
    title: row.title,
    weekdays: row.weekdays,
    startMinute: row.start_minute,
    durationMinutes: row.duration_minutes,
    allDay: row.all_day,
    categoryId: row.category_id,
    startsOn: toIsoDate(row.starts_on),
    endsOn: row.ends_on ? toIsoDate(row.ends_on) : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getTasksBetween(userId: string, from: string, to: string): Promise<Task[]> {
  // id в хвосте — по той же причине, что и у getRecurrences ниже, и случай
  // тут куда более частый: две встречи на 9:00 — обычное дело, а два правила
  // повтора на одну минуту — редкость. Без тай-брейка равные по (дате,
  // минуте) строки остаются в физическом порядке кучи, а он меняется от
  // любой правки: update пишет новую версию строки в конец. То есть задача,
  // которую подвинули или переименовали, молча переезжала бы вниз соседки
  // на то же время — и обратно после VACUUM.
  //
  // Только дневные задачи. У недельной и месячной колонка date заполнена
  // якорем периода — понедельником или первым числом, — поэтому без этого
  // условия недельная задача встала бы в сетку понедельником, а месячная
  // первым числом, и выглядело бы это как «задача сама переехала».
  //
  // Фильтр стоит здесь, в одной функции, а не у каждого вызывающего: через
  // неё идут оба пути к задачам расписания — экран недели (loadWeek) и
  // планировщик уведомлений (loadRange напрямую). Кому нужны задачи всех
  // горизонтов, тот складывает списки явно; см. app/api/command/route.ts
  // (контекст модели для разбора фразы) и app/api/checklist/route.ts
  // (три секции чеклиста одним ответом).
  const rows = await sql`
    select * from tasks
    where user_id = ${userId} and date >= ${from} and date <= ${to}
      and horizon = 'day'
    order by date, start_minute nulls first, id
  `;
  return rows.map(rowToTask);
}

/**
 * Задачи владельца по списку идентификаторов.
 *
 * Нужен отчёту: чтобы отличить «перенесена» от «убрана», надо найти задачу
 * из снимка ГДЕ УГОДНО, а не только в той неделе, где её планировали.
 *
 * Синтетические идентификаторы вхождений (`occ:<правило>:<дата>`) сюда
 * передавать нельзя — они не uuid, и Postgres упадёт на приведении типа.
 * Отсеивает их вызывающий; сами вхождения приходят из loadRange.
 *
 * Пустой список — пустой результат без похода в базу: `in ()` синтаксически
 * неверен, а не «ничего не находит».
 */
export async function getTasksByIds(userId: string, ids: string[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  const rows = await sql`
    select * from tasks where user_id = ${userId} and id in ${sql(ids)}
  `;
  return rows.map(rowToTask);
}

/**
 * Задачи одного горизонта в одном периоде — то, что показывает чеклист.
 *
 * Якорь приводится здесь, а не в вызывающем: тот передаёт любую дату внутри
 * периода (обычно сегодняшнюю), и требовать от каждого экрана самому считать
 * понедельник значило бы завести три места, где эта арифметика может
 * разойтись.
 *
 * Отдельная функция, а не параметр у getTasksBetween: там фильтр по дневному
 * горизонту — предохранитель, и делать его необязательным значило бы вернуть
 * ровно ту мину, ради которой он поставлен.
 */
export async function getChecklistTasks(
  userId: string,
  horizon: Horizon,
  anchor: string,
): Promise<Task[]> {
  // По created_at, а не по date: внутри одного периода она у всех строк
  // одинакова — это якорь, а не когда задача заведена, — сортировать по ней
  // нечего. id в хвосте — тот же тай-брейк, что у соседних запросов: две
  // задачи, заведённые одной голосовой фразой, получают близкий created_at,
  // и без id их порядок в чеклисте дрожал бы между загрузками.
  const rows = await sql`
    select * from tasks
    where user_id = ${userId}
      and horizon = ${horizon}
      and date = ${anchorFor(horizon, anchor)}
    order by created_at, id
  `;
  return rows.map(rowToTask);
}

export async function getRecurrences(userId: string): Promise<Recurrence[]> {
  // order by — не для тестов, а против дрожания экрана. loadRange сливает
  // раскрытые вхождения с задачами и сортирует по (дате, «весь день», минуте
  // начала); сортировка в JS устойчивая, поэтому равные по этой тройке
  // вхождения сохраняют порядок правил — а он без order by физический,
  // то есть меняется после любого переиспользования освобождённого места
  // в куче. Два занятия на одно время менялись бы местами между двумя
  // одинаковыми загрузками недели. id в хвосте — чтобы порядок был полным,
  // а не «почти».
  const rows = await sql`
    select * from recurrences
    where user_id = ${userId}
    order by starts_on, start_minute nulls first, id
  `;
  return rows.map(rowToRecurrence);
}

export async function getExceptions(userId: string): Promise<RecurrenceException[]> {
  // У recurrence_exceptions нет своей колонки владельца: ключ (recurrence_id,
  // date) уже ведёт к правилу, а у правила владелец есть. Дублировать значило
  // бы завести второй источник правды, способный разъехаться.
  const rows = await sql`
    select e.recurrence_id, e.date
    from recurrence_exceptions e
    join recurrences r on r.id = e.recurrence_id
    where r.user_id = ${userId}
  `;
  return rows.map((row) => ({ recurrenceId: row.recurrence_id, date: toIsoDate(row.date) }));
}

export async function getSettings(userId: string): Promise<Settings> {
  const [row] = await sql`select * from user_settings where user_id = ${userId}`;
  // Копия, а не сама константа. DEFAULT_SETTINGS живёт на уровне модуля,
  // то есть одна на весь процесс сервера и на всех, у кого своей строки
  // ещё нет. Отдай её по ссылке — и первая же мутация у вызывающего
  // (хоть settings.categories.push, хоть правка поля перед сохранением)
  // станет умолчанием для следующего человека. structuredClone, а не
  // {...DEFAULT_SETTINGS}: categories — массив объектов, и поверхностная
  // копия оставила бы их общими.
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  return {
    workStartMinute: row.work_start_minute,
    workEndMinute: row.work_end_minute,
    aboutMe: row.about_me,
    categories: row.categories as Category[],
    notifyBeforeMinutes: row.notify_before_minutes,
  };
}

/**
 * Часовой пояс пользователя намеренно не входит в Settings.
 *
 * Settings целиком ездит на клиент и обратно через экран настроек, а пояс
 * там не редактируется — его сообщает телефон при отправке команды. Держать
 * его в том же объекте значило бы дать экрану настроек тихо затирать пояс
 * тем, что было при загрузке страницы.
 */
export async function getTimezone(userId: string): Promise<string> {
  const [row] = await sql`select timezone from user_settings where user_id = ${userId}`;
  return row ? row.timezone : DEFAULT_TIMEZONE;
}

export async function saveTimezone(userId: string, timezone: string): Promise<void> {
  // Строки может ещё не быть: настройки заводятся первым сохранением, а пояс
  // приходит с первой же командой — и обычно раньше. Остальные колонки при
  // такой вставке берут умолчания, чтобы не выдумывать их на месте.
  //
  // Условие в do update: команда идёт с телефона по несколько раз в день,
  // а пояс меняется раз в поездку. Без него это лишняя запись на каждую фразу.
  await sql`
    insert into user_settings (user_id, work_start_minute, work_end_minute, about_me,
                               categories, timezone, notify_before_minutes)
    values (${userId}, ${DEFAULT_SETTINGS.workStartMinute}, ${DEFAULT_SETTINGS.workEndMinute},
            ${DEFAULT_SETTINGS.aboutMe},
            ${sql.json(DEFAULT_SETTINGS.categories as unknown as postgres.JSONValue)},
            ${timezone}, ${DEFAULT_SETTINGS.notifyBeforeMinutes})
    on conflict (user_id) do update set timezone = excluded.timezone
    where user_settings.timezone is distinct from excluded.timezone
  `;
}

// sql.json()'s parameter type (postgres.JSONValue) requires an index
// signature on its object variant. Category is a plain-JSON-safe interface
// declared without one, so TS rejects the structural match; cast through
// unknown rather than loosen the Category type just to satisfy the driver.
export async function saveSettings(userId: string, settings: Settings): Promise<void> {
  // Пояс в do update не перечислен намеренно: экран настроек его не
  // редактирует, а Settings его не содержит — перечисли, и сохранение
  // настроек затирало бы пояс, присланный телефоном. DEFAULT_TIMEZONE
  // в values участвует только при первой вставке.
  await sql`
    insert into user_settings (user_id, work_start_minute, work_end_minute, about_me,
                               categories, timezone, notify_before_minutes)
    values (${userId}, ${settings.workStartMinute}, ${settings.workEndMinute},
            ${settings.aboutMe},
            ${sql.json(settings.categories as unknown as postgres.JSONValue)},
            ${DEFAULT_TIMEZONE}, ${settings.notifyBeforeMinutes})
    on conflict (user_id) do update set
      work_start_minute     = excluded.work_start_minute,
      work_end_minute       = excluded.work_end_minute,
      about_me              = excluded.about_me,
      categories            = excluded.categories,
      notify_before_minutes = excluded.notify_before_minutes
  `;
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function getSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
  const rows = await sql`
    select endpoint, p256dh, auth from push_subscriptions where user_id = ${userId}
  `;
  return rows.map((row) => ({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }));
}

export async function addSubscription(
  userId: string,
  subscription: PushSubscriptionRow,
): Promise<void> {
  // Повторное нажатие кнопки в настройках не должно быть ошибкой: браузер
  // отдаёт ту же подписку, пока разрешение не отозвано. Владельца обновляем
  // на случай, если устройством раньше пользовался другой человек — но
  // только когда это действительно тот же браузер: p256dh/auth в запросе
  // совпадают с уже сохранёнными.
  //
  // Ключи в push_subscriptions лежат открытым текстом и проходят через тело
  // POST /api/push — ни база, ни тело запроса их не прячут. Опора здесь не
  // на секретность, а на неугадываемость: p256dh и auth — это 65 и 16
  // случайных байт, подобрать их равносильно подбору пароля такой же длины.
  // Совпадение обоих в запросе — это то же самое устройство, а не человек,
  // которому чужой пароль просто не показали.
  //
  // where в do update — не про удобство, а про обе стороны угрозы:
  //   1) p256dh/auth сами по себе никогда не перезаписываются чужими —
  //      строка хранит ключи шифрования исходного устройства, и без этого
  //      условия узнавший чужой endpoint (а он не секрет — см.
  //      lib/ownership.test.ts) присвоил бы себе чужую подписку целиком;
  //   2) без where владелец сменился бы даже при чужих ключах в insert —
  //      тогда планировщик у нового «владельца» брал бы этот endpoint
  //      (getSubscriptions фильтрует по user_id, не по ключам) и слал бы
  //      ЕГО задачи, зашифрованные СТАРЫМИ ключами, на исходное устройство:
  //      оно расшифровало бы их своим приватным ключом и показало как свои.
  //      Условие разрешает смену владельца только тому, кто предъявил ключи
  //      самого устройства, — законный случай «на одном браузере сменился
  //      человек» продолжает работать, там ключи в insert и в строке совпадают.
  await sql`
    insert into push_subscriptions (endpoint, p256dh, auth, user_id)
    values (${subscription.endpoint}, ${subscription.p256dh}, ${subscription.auth}, ${userId})
    on conflict (endpoint) do update set user_id = excluded.user_id
    where push_subscriptions.p256dh = excluded.p256dh
      and push_subscriptions.auth   = excluded.auth
  `;
}

export async function removeSubscription(userId: string, endpoint: string): Promise<void> {
  // Владелец в условии обязателен: без него чужую подписку снимает любой,
  // кто знает её endpoint.
  await sql`delete from push_subscriptions where endpoint = ${endpoint} and user_id = ${userId}`;
}

/**
 * Кому вообще слать уведомления.
 *
 * Не «все владельцы подписок». Планировщик вынесен из-под прокси (исключён
 * в матчере, защищён NOTIFY_SECRET), поэтому проверка белого списка из
 * proxy.ts его не накрывает и накрыть не может — фильтр обязан стоять здесь.
 *
 * Без него отозванный человек не смог бы открыть приложение, но его телефон
 * продолжал бы получать напоминания с нашей инфраструктуры — и выключить их
 * он бы уже не смог, потому что не вошёл бы.
 *
 * lower(u.email): в allowed_emails регистр закреплён ограничением
 * check (email = lower(email)), а адрес от Google приходит каким угодно.
 * То же приведение делает isEmailAllowed. Без него отзыв работал бы, а
 * уведомления продолжали бы идти тому, у кого адрес записан с заглавной.
 *
 * Фильтр в запросе, а не в цикле роута: один запрос вместо одного на каждого.
 */
export async function getNotifiableUsers(): Promise<string[]> {
  const rows = await sql`
    select distinct p.user_id
    from push_subscriptions p
    join "user" u         on u.id = p.user_id
    join allowed_emails a on a.email = lower(u.email)
    where p.user_id is not null
  `;
  return rows.map((row) => row.user_id as string);
}

/** Ключи задач, о которых уже уведомляли. Ключ — это task.id. */
export async function getSentKeys(): Promise<Set<string>> {
  const rows = await sql`select key from notifications_sent`;
  return new Set(rows.map((row) => row.key as string));
}

export async function markSent(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  // do nothing на случай гонки двух запусков планировщика.
  await sql`
    insert into notifications_sent ${sql(keys.map((key) => ({ key })))}
    on conflict (key) do nothing
  `;
}

/** Иначе таблица отметок росла бы вечно. */
export async function purgeOldSent(): Promise<void> {
  await sql`delete from notifications_sent where sent_at < now() - interval '7 days'`;
}

/* ---------- ключи Anthropic ---------- */

export interface UserKeyRow {
  present: boolean;
  sealed: SealedKey | null;
  keySetAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
}

/** null — строки нет вовсе (человек ни разу не пробовал завести ключ). */
export async function getUserKey(userId: string): Promise<UserKeyRow | null> {
  const [row] = await sql`select * from user_api_keys where user_id = ${userId}`;
  if (!row) return null;
  // Признак «ключ заведён» — заполненный шифротекст, а не наличие строки:
  // строка создаётся и при первой неудачной попытке, ради счётчика.
  const present = row.key_ciphertext !== null;
  return {
    present,
    sealed: present
      ? { iv: row.key_iv, tag: row.key_tag, ciphertext: row.key_ciphertext }
      : null,
    keySetAt: row.key_set_at,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
  };
}

/**
 * Отдельный запрос, а не getUserKey(...)?.present: его зовёт загрузка недели,
 * и тащить оттуда байты шифротекста ради одного флажка незачем.
 */
export async function hasUserKey(userId: string): Promise<boolean> {
  const [row] = await sql`
    select 1 from user_api_keys
    where user_id = ${userId} and key_ciphertext is not null
  `;
  return row !== undefined;
}

/** Успешная проверка ключа: сохраняем и снимаем всё, что накопил счётчик. */
export async function saveUserKey(userId: string, sealed: SealedKey): Promise<void> {
  await sql`
    insert into user_api_keys
      (user_id, key_iv, key_tag, key_ciphertext, key_set_at, failed_attempts, locked_until)
    values
      (${userId}, ${sealed.iv}, ${sealed.tag}, ${sealed.ciphertext}, now(), 0, null)
    on conflict (user_id) do update set
      key_iv          = excluded.key_iv,
      key_tag         = excluded.key_tag,
      key_ciphertext  = excluded.key_ciphertext,
      key_set_at      = excluded.key_set_at,
      failed_attempts = 0,
      locked_until    = null
  `;
}

/**
 * Убирает ключ, но НЕ строку и НЕ счётчик.
 *
 * Удали строку целиком — и «убрать ключ» стало бы лазейкой из часовой паузы:
 * запертый человек убирает ключ, счётчик исчезает вместе со строкой, и пять
 * попыток выдаются заново.
 */
export async function clearUserKey(userId: string): Promise<void> {
  await sql`
    update user_api_keys set
      key_iv         = null,
      key_tag        = null,
      key_ciphertext = null,
      key_set_at     = null
    where user_id = ${userId}
  `;
}

/**
 * Неудачная попытка: +1 к счётчику, при достижении maxAttempts — пауза.
 *
 * Одним оператором, а не чтением с последующей записью: попытки могут идти
 * с двух экземпляров Vercel разом, и чтение-запись потеряло бы одну из них.
 */
export async function registerKeyFailure(
  userId: string,
  maxAttempts: number,
  lockSeconds: number,
): Promise<{ failedAttempts: number; lockedUntil: Date | null }> {
  const [row] = await sql`
    insert into user_api_keys (user_id, failed_attempts, locked_until)
    values (${userId}, 1, null)
    on conflict (user_id) do update set
      -- Истёкшая пауза начинает новую серию. Иначе счётчик рос бы дальше
      -- предела, и первый же промах после её окончания запирал бы снова —
      -- то есть часовая пауза стала бы вечной блокировкой.
      failed_attempts = case
        when user_api_keys.locked_until is not null
             and user_api_keys.locked_until <= now() then 1
        else user_api_keys.failed_attempts + 1
      end,
      locked_until = case
        when user_api_keys.locked_until is not null
             and user_api_keys.locked_until <= now() then null
        when user_api_keys.failed_attempts + 1 >= ${maxAttempts}
          then now() + make_interval(secs => ${lockSeconds})
        else user_api_keys.locked_until
      end
    returning failed_attempts, locked_until
  `;
  return { failedAttempts: row.failed_attempts, lockedUntil: row.locked_until };
}

/** Снимок недели вместе с отчётом, если он уже собран. */
export interface WeekSnapshot {
  weekStart: string;
  planned: PlannedTask[];
  report: WeeklyReport | null;
  reportedAt: Date | null;
}

export async function getWeekSnapshot(
  userId: string,
  weekStart: string,
): Promise<WeekSnapshot | null> {
  const rows = await sql`
    select week_start, planned, report, reported_at
    from week_snapshots
    where user_id = ${userId} and week_start = ${weekStart}
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    weekStart: toIsoDate(row.week_start),
    planned: row.planned as PlannedTask[],
    report: (row.report ?? null) as WeeklyReport | null,
    reportedAt: row.reported_at as Date | null,
  };
}

/**
 * Последний собранный отчёт — то, что показывает экран.
 *
 * Условие `report is not null` обязательно: снимок текущей недели существует
 * с понедельника, а отчёта у него не будет никогда — он про неё, а не о ней.
 * Без условия экран пустел бы каждый понедельник, как только появится снимок
 * новой недели.
 */
export async function getLatestReport(
  userId: string,
): Promise<{ weekStart: string; report: WeeklyReport } | null> {
  const rows = await sql`
    select week_start, report
    from week_snapshots
    where user_id = ${userId} and report is not null
    order by week_start desc
    limit 1
  `;
  if (rows.length === 0) return null;
  return {
    weekStart: toIsoDate(rows[0].week_start),
    report: rows[0].report as WeeklyReport,
  };
}

/**
 * Записать намерение на неделю.
 *
 * `do nothing` при конфликте, а не `do update`: планировщик стучится раз
 * в минуту, и второй вызов в тот же понедельник обязан быть безобидным.
 * Перезапись превращала бы «что я собирался сделать в понедельник»
 * в «что у меня осталось к вечеру вторника» — то есть уничтожала бы
 * ровно то, ради чего снимок и делается.
 */
export async function saveWeekSnapshot(
  userId: string,
  weekStart: string,
  planned: PlannedTask[],
): Promise<void> {
  // sql.json() требует индексную сигнатуру у объектного варианта JSONValue —
  // PlannedTask её не объявляет. Каст через unknown, а не ослабление типа
  // ради драйвера (см. аналогичный комментарий у saveSettings выше).
  await sql`
    insert into week_snapshots (user_id, week_start, planned)
    values (${userId}, ${weekStart}, ${sql.json(planned as unknown as postgres.JSONValue)})
    on conflict (user_id, week_start) do nothing
  `;
}

/**
 * Сохранить готовый отчёт и отметить, что он отправлен.
 *
 * Отметка и сам отчёт пишутся одной операцией намеренно: разними их —
 * и появится состояние «отчёт есть, но считается неотправленным», в котором
 * пуш уйдёт второй раз.
 *
 * `and reported_at is null` в предикате — не оптимизация, а сама защита от
 * дубля. Без неё два пересёкшихся запуска /api/notify (соседние минуты
 * планировщика, наложившиеся из-за задержки) оба читают reportedAt === null
 * ДО того, как кто-то из них запишет своё, и оба решают, что отправлять
 * можно. Общий tag 'weekly-report' схлопывает такой дубль в шторке
 * уведомлений, но это везение получателя, а не гарантия. С предикатом
 * «уже отмечен отправленным» проверяется той же командой, что делает
 * отметку, — атомарно на стороне базы, — и обновляет ровно ту строку,
 * которая всё ещё null, тем же приёмом, что и `on conflict do nothing`
 * у saveWeekSnapshot «на случай гонки двух запусков планировщика».
 * Возвращает, действительно ли эта попытка записала данные: тому, кто
 * проиграл гонку, отправлять уже нечего — за него это уже сделал победитель.
 */
export async function saveReport(
  userId: string,
  weekStart: string,
  report: WeeklyReport,
): Promise<boolean> {
  const rows = await sql`
    update week_snapshots
    set report = ${sql.json(report as unknown as postgres.JSONValue)}, reported_at = now()
    where user_id = ${userId} and week_start = ${weekStart} and reported_at is null
    returning user_id
  `;
  return rows.length > 0;
}
