import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { Pool } from 'pg';
import { getUserEmailById, isEmailAllowed } from './allowed-emails';
import { EMAIL_NOT_ALLOWED_ERROR_CODE } from './auth-error-codes';

const encoder = new TextEncoder();

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Buffer.from(sig).toString('base64url');
}

/**
 * Сколько живёт сессия. Одно значение и для maxAge куки, и для проверки метки
 * в токене: разъедься они, кука либо переживала бы собственный токен, либо
 * умирала бы раньше него.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Токен вида "<время выдачи>.<подпись>". */
export async function signSession(secret: string): Promise<string> {
  const payload = String(Date.now());
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifySession(token: string, secret: string): Promise<boolean> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const expected = await hmac(payload, secret);
  if (given.length !== expected.length) return false;
  // Сравнение за постоянное время: не даём подобрать подпись по времени ответа.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return false;

  // Метку времени читаем только после проверки подписи: до неё содержимое
  // токена ничем не подтверждено. Без этой проверки метка клалась в токен
  // впустую, и утёкшую куку нельзя было отозвать ничем, кроме смены секрета.
  const issuedAt = Number(payload);
  if (!Number.isFinite(issuedAt)) return false;
  return Date.now() - issuedAt <= SESSION_MAX_AGE_SECONDS * 1000;
}

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
