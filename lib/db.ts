import 'server-only';
import postgres from 'postgres';
import { DEFAULT_SETTINGS, DEFAULT_TIMEZONE } from './settings-defaults';
import type { Category, Recurrence, RecurrenceException, Settings, Task } from './types';

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
  const rows = await sql`
    select * from tasks
    where user_id = ${userId} and date >= ${from} and date <= ${to}
    order by date, start_minute nulls first
  `;
  return rows.map(rowToTask);
}

export async function getRecurrences(userId: string): Promise<Recurrence[]> {
  const rows = await sql`select * from recurrences where user_id = ${userId}`;
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
 * Владельцы, которым есть что слать. Список берётся из подписок, а не из
 * "user": рассылать нечего тем, кто уведомления не включал, а в "user"
 * попадают строки от отвергнутых белым списком попыток входа.
 */
export async function getUsersWithSubscriptions(): Promise<string[]> {
  const rows = await sql`select distinct user_id from push_subscriptions where user_id is not null`;
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
