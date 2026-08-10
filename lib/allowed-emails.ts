import 'server-only';
import { sql } from './db';

/**
 * Кто вообще может войти.
 *
 * Регистр приводится здесь, а в таблице закреплён check-ограничением: адрес
 * от Google и адрес, вбитый руками в SQL-редакторе, должны совпасть, а
 * text primary key сравнивается с учётом регистра.
 */
export async function isEmailAllowed(email: string): Promise<boolean> {
  if (!email) return false;
  const rows = await sql`select 1 from allowed_emails where email = ${email.toLowerCase()}`;
  return rows.length > 0;
}

/**
 * Адрес по идентификатору пользователя Better Auth.
 *
 * Таблица называется user — зарезервированное слово Postgres, отсюда кавычки.
 * Это единственное место, где мы читаем чужую таблицу напрямую: хук допуска
 * получает только userId, а решение принимается по адресу.
 */
export async function getUserEmailById(userId: string): Promise<string | null> {
  const rows = await sql`select email from "user" where id = ${userId}`;
  return rows.length > 0 ? (rows[0].email as string) : null;
}
