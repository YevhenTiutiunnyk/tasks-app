import 'server-only';
import postgres from 'postgres';
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

export async function getTasksBetween(from: string, to: string): Promise<Task[]> {
  const rows = await sql`
    select * from tasks where date >= ${from} and date <= ${to} order by date, start_minute nulls first
  `;
  return rows.map(rowToTask);
}

export async function getRecurrences(): Promise<Recurrence[]> {
  const rows = await sql`select * from recurrences`;
  return rows.map(rowToRecurrence);
}

export async function getExceptions(): Promise<RecurrenceException[]> {
  const rows = await sql`select * from recurrence_exceptions`;
  return rows.map((row) => ({ recurrenceId: row.recurrence_id, date: toIsoDate(row.date) }));
}

export async function getSettings(): Promise<Settings> {
  const [row] = await sql`select * from settings where id = 1`;
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
export async function getTimezone(): Promise<string> {
  const [row] = await sql`select timezone from settings where id = 1`;
  return row.timezone;
}

export async function saveTimezone(timezone: string): Promise<void> {
  // Условие в самом запросе: команда идёт с телефона по несколько раз в день,
  // а пояс меняется раз в поездку. Без него это лишняя запись на каждую фразу.
  await sql`
    update settings set timezone = ${timezone}
    where id = 1 and timezone is distinct from ${timezone}
  `;
}

// sql.json()'s parameter type (postgres.JSONValue) requires an index
// signature on its object variant. Category is a plain-JSON-safe interface
// declared without one, so TS rejects the structural match; cast through
// unknown rather than loosen the Category type just to satisfy the driver.
export async function saveSettings(settings: Settings): Promise<void> {
  await sql`
    update settings set
      work_start_minute = ${settings.workStartMinute},
      work_end_minute   = ${settings.workEndMinute},
      about_me          = ${settings.aboutMe},
      categories        = ${sql.json(settings.categories as unknown as postgres.JSONValue)},
      notify_before_minutes = ${settings.notifyBeforeMinutes}
    where id = 1
  `;
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function getSubscriptions(): Promise<PushSubscriptionRow[]> {
  const rows = await sql`select endpoint, p256dh, auth from push_subscriptions`;
  return rows.map((row) => ({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }));
}

export async function addSubscription(subscription: PushSubscriptionRow): Promise<void> {
  // Повторное нажатие кнопки в настройках не должно быть ошибкой: браузер
  // отдаёт ту же самую подписку, пока разрешение не отозвано.
  await sql`
    insert into push_subscriptions (endpoint, p256dh, auth)
    values (${subscription.endpoint}, ${subscription.p256dh}, ${subscription.auth})
    on conflict (endpoint) do nothing
  `;
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await sql`delete from push_subscriptions where endpoint = ${endpoint}`;
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
