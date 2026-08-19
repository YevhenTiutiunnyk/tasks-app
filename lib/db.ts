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
  if (!row) return DEFAULT_SETTINGS;
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

/**
 * Временная опора: до задачи 5 планировщик работает на одном владельце.
 * Задача 5 заменяет это на getUsersWithSubscriptions.
 */
export async function getSoleUserId(): Promise<string | null> {
  const rows = await sql`select id from "user" limit 2`;
  return rows.length === 1 ? (rows[0].id as string) : null;
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
