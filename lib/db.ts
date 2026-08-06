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
  };
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
      categories        = ${sql.json(settings.categories as unknown as postgres.JSONValue)}
    where id = 1
  `;
}
