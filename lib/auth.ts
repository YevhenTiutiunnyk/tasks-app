import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { Pool } from 'pg';
import { getUserEmailById, isEmailAllowed } from './allowed-emails';
import { EMAIL_NOT_ALLOWED_ERROR_CODE } from './auth-error-codes';

/**
 * Отдельный пул на драйвере pg — так требует Better Auth: он ходит в Postgres
 * через Kysely, а наш postgres.js ему не подходит. Пул приложения в lib/db.ts
 * этим не затрагивается.
 *
 * Именованные подготовленные выражения транзакционный пулер Supabase (порт
 * 6543) не поддерживает; node-postgres по умолчанию их не использует.
 */
export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  // 30 дней со скольжением: продлевается не чаще раза в сутки, чтобы каждое
  // открытие приложения не писало в базу.
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  /**
   * Белый список. Проверка стоит до создания сессии, а не после: чужой не
   * должен получить сессию даже на секунду.
   *
   * Хук именно на сессии, а не на создании пользователя: создание срабатывает
   * один раз, и адрес, убранный из списка позже, продолжал бы пускать.
   *
   * Отказ без подробностей о том, кто допущен: сообщение общее, а `code`
   * нужен не для текста (текст по коду подбирает страница входа), а чтобы
   * штатный обработчик колбэка вообще сделал редирект, а не отдал сырой
   * JSON — он смотрит именно на `e.body?.code`
   * (node_modules/better-auth/dist/api/routes/callback.mjs).
   */
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const email = await getUserEmailById(session.userId);
          if (!email || !(await isEmailAllowed(email))) {
            throw new APIError('FORBIDDEN', {
              code: EMAIL_NOT_ALLOWED_ERROR_CODE,
              message: 'Вход не разрешён',
            });
          }
        },
      },
    },
  },
  /**
   * Без этого редирект после отказа шёл бы на `${baseURL}/error`
   * (node_modules/better-auth/dist/api/routes/callback.mjs:32) — а такой
   * страницы в приложении нет, и человек вместо причины отказа увидел бы
   * 404 Next.js. Ведём туда же, откуда пришли: страница входа сама умеет
   * читать ?error= и показывать текст.
   */
  onAPIError: {
    errorURL: '/login',
  },
});
