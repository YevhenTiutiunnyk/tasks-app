import { beforeEach, describe, expect, it, vi } from 'vitest';

// lib/auth.ts заводит настоящий пул Postgres и требует секреты Google при
// самом импорте — подменяем модуль целиком, чтобы проверить только
// ветвление внутри getCalendarClient, без всякой инфраструктуры.
const authMock = vi.hoisted(() => ({
  behavior: 'success' as 'success' | 'no-token' | 'api-rejection' | 'raw-failure',
  accounts: [] as { id: string; providerId: string }[],
  lastBody: undefined as unknown,
}));
vi.mock('./auth', () => ({
  auth: {
    $context: Promise.resolve({
      internalAdapter: {
        findAccounts: async () => authMock.accounts,
      },
    }),
    api: {
      getAccessToken: async ({ body }: { body: unknown }) => {
        authMock.lastBody = body;
        if (authMock.behavior === 'success') return { accessToken: 'ya29.zz-token' };
        if (authMock.behavior === 'no-token') return {};
        if (authMock.behavior === 'api-rejection') {
          // Форма APIError из Better Auth: код статуса в отдельном поле,
          // а не то, что можно вычитать из message. Секрет в message —
          // намеренно: тест ниже проверяет, что он никуда не просачивается.
          const error = new Error('ZZ-секрет-которого-не-должно-быть-в-новой-ошибке');
          Object.assign(error, { status: 'BAD_REQUEST', statusCode: 400 });
          throw error;
        }
        // Сырой сбой без формы структурного отказа — например, оборвалась
        // сеть при самом запросе за токеном. У такого исключения нет ни
        // status, ни statusCode.
        throw new TypeError('ZZ-сеть-упала-это-не-значит-что-доступа-нет');
      },
    },
  },
}));

import { CalendarAccessLost } from './google-api';
import { getCalendarClient } from './google-token';

describe('getCalendarClient', () => {
  beforeEach(() => {
    authMock.accounts = [
      { id: 'zz-credential-account', providerId: 'credential' },
      { id: 'zz-google-account', providerId: 'google' },
    ];
    authMock.lastBody = undefined;
  });

  // С Better Auth 1.7 getAccessToken принимает строго { accountId } — строку
  // таблицы account, а не providerId: тело проверяется z.strictObject,
  // и прежний { providerId: 'google' } отбивался бы 400 на каждом вызове.
  it('спрашивает токен по accountId Google-аккаунта владельца', async () => {
    authMock.behavior = 'success';
    await getCalendarClient('zz-user');
    expect(authMock.lastBody).toEqual({ accountId: 'zz-google-account', userId: 'zz-user' });
  });

  it('у владельца нет Google-аккаунта — доступа нет, токен не спрашивается', async () => {
    authMock.behavior = 'success';
    authMock.accounts = [{ id: 'zz-credential-account', providerId: 'credential' }];
    await expect(getCalendarClient('zz-user')).rejects.toBeInstanceOf(CalendarAccessLost);
    expect(authMock.lastBody).toBeUndefined();
  });

  it('успешный ответ с токеном — отдаёт клиент', async () => {
    authMock.behavior = 'success';
    await expect(getCalendarClient('zz-user')).resolves.toBeDefined();
  });

  it('успешный ответ без токена — доступа нет', async () => {
    authMock.behavior = 'no-token';
    await expect(getCalendarClient('zz-user')).rejects.toBeInstanceOf(CalendarAccessLost);
  });

  it('структурный отказ auth-слоя (есть код статуса) — доступа нет', async () => {
    authMock.behavior = 'api-rejection';
    await expect(getCalendarClient('zz-user')).rejects.toBeInstanceOf(CalendarAccessLost);
  });

  // Находка 1 второго круга финального ревью: раньше ЛЮБОЙ пойманный отказ,
  // включая сетевой сбой при самом запросе за токеном, превращался
  // в CalendarAccessLost — и роут вокруг календаря ставил ложную пометку
  // «связь сломана», хотя доступ никто не отзывал.
  it('сырой сбой без формы структурного отказа — НЕ доступа нет', async () => {
    authMock.behavior = 'raw-failure';
    const error: unknown = await getCalendarClient('zz-user').catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(CalendarAccessLost);
    expect(error).toBeInstanceOf(Error);
  });

  it('содержимое пойманного исключения не попадает в текст новой ошибки', async () => {
    authMock.behavior = 'raw-failure';
    const rawError: unknown = await getCalendarClient('zz-user').catch((e: unknown) => e);
    expect(String((rawError as Error).message)).not.toContain('ZZ-сеть-упала');

    authMock.behavior = 'api-rejection';
    const apiError: unknown = await getCalendarClient('zz-user').catch((e: unknown) => e);
    expect(String((apiError as Error).message)).not.toContain('ZZ-секрет-которого-не-должно-быть');
  });
});
