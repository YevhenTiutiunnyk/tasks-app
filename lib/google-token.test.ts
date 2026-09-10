import { describe, expect, it, vi } from 'vitest';

// lib/auth.ts заводит настоящий пул Postgres и требует секреты Google при
// самом импорте — подменяем модуль целиком, чтобы проверить только
// ветвление внутри getCalendarClient, без всякой инфраструктуры.
const authMock = vi.hoisted(() => ({
  behavior: 'success' as 'success' | 'no-token' | 'api-rejection' | 'raw-failure',
}));
vi.mock('./auth', () => ({
  auth: {
    api: {
      getAccessToken: async () => {
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
