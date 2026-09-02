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
 * Этот модуль — единственное место, которое обращается к таблицам Better Auth
 * напрямую: хук допуска получает только userId, а решение принимается по адресу,
 * и revokeSessions удаляет сессии непосредственно.
 */
export async function getUserEmailById(userId: string): Promise<string | null> {
  const rows = await sql`select email from "user" where id = ${userId}`;
  return rows.length > 0 ? (rows[0].email as string) : null;
}

/**
 * Снять доступ: удалить все сессии владельца.
 *
 * Зовётся из proxy.ts, когда у вошедшего человека адреса больше нет в белом
 * списке. Отзыв по адресу, а не по браузеру, поэтому снимаются сессии со всех
 * устройств разом.
 *
 * Удаление адресное, по userId: правило проекта запрещает delete без условий,
 * и здесь условие единственное.
 *
 * Кавычки вокруг "userId" обязательны — Better Auth называет колонки
 * в camelCase, и без кавычек Postgres приведёт имя к нижнему регистру
 * и колонку не найдёт.
 *
 * Возвращает число снятых сессий: оно нужно не вызывающему, а логу прокси —
 * это единственный след события, которого больше нигде не остаётся.
 */
export async function revokeSessions(userId: string): Promise<number> {
  const rows = await sql`delete from session where "userId" = ${userId} returning id`;
  return rows.length;
}
