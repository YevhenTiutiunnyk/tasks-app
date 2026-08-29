import { describe, expect, it, vi } from 'vitest';
import { anthropicFailure, clientForUser } from './key-client';
import { encryptApiKey } from './user-key';
import type { UserKeyRow } from './db';

const USER = 'zz-client-user';

function rowWithKey(userId: string, secret: string): UserKeyRow {
  return {
    present: true,
    sealed: encryptApiKey(userId, secret),
    keySetAt: new Date(),
    failedAttempts: 0,
    lockedUntil: null,
  };
}

describe('clientForUser', () => {
  it('строки нет — 409 no_key', async () => {
    const result = clientForUser(USER, null);
    expect(result.response?.status).toBe(409);
    expect((await result.response!.json()).code).toBe('no_key');
  });

  it('строка есть, ключа нет — 409 no_key', async () => {
    const result = clientForUser(USER, {
      present: false,
      sealed: null,
      keySetAt: null,
      failedAttempts: 2,
      lockedUntil: null,
    });
    expect((await result.response!.json()).code).toBe('no_key');
  });

  it('ключ не расшифровался — 409 key_unreadable', async () => {
    // Шифротекст запечатан на другого владельца (AAD = 'zz-кто-то-другой'):
    // AEAD отказывается расшифровывать чужую строку, decryptApiKey возвращает
    // null — то же самое происходит при смене KEY_ENCRYPTION_KEY или порче
    // байтов. Отсутствие переменной окружения — отдельный, не этот случай:
    // он бросает уровнем ниже, см. следующий describe.
    const result = clientForUser(USER, rowWithKey('zz-кто-то-другой', 'sk-ant-zz-ключ'));
    expect(result.response?.status).toBe(409);
    expect((await result.response!.json()).code).toBe('key_unreadable');
  });

  it('рабочий ключ — готовый клиент и никакого отказа', () => {
    const result = clientForUser(USER, rowWithKey(USER, 'sk-ant-zz-рабочий-ключ'));
    expect(result.response).toBeUndefined();
    expect(result.client).toBeDefined();
  });

  it('отсутствующая KEY_ENCRYPTION_KEY — авария, а не 409 всем подряд', () => {
    // Шифруем ДО подмены переменной: само шифрование тоже её требует и
    // упало бы раньше времени.
    const row = rowWithKey(USER, 'sk-ant-zz-рабочий-ключ');

    // Главный предохранитель задачи: clientForUser не смеет обернуть
    // decryptApiKey в try/catch и превратить забытую переменную окружения
    // в тихий 409 «введи ключ заново» для всех пользователей разом. Это
    // авария развёртывания — она обязана бросить и уронить запрос, а не
    // притвориться обычным «ключ не читается».
    vi.stubEnv('KEY_ENCRYPTION_KEY', '');
    expect(() => clientForUser(USER, row)).toThrow(/KEY_ENCRYPTION_KEY/);
    vi.unstubAllEnvs();
  });
});

describe('anthropicFailure', () => {
  const withStatus = (status?: number) => Object.assign(new Error('ZZ'), { status });

  it('401 объясняет, что дело в ключе, а не во фразе', async () => {
    const body = await anthropicFailure(withStatus(401)).json();
    expect(body.error).toMatch(/ключ/i);
    // Главное: не предлагать переформулировать фразу — человек будет
    // переформулировать её бесконечно, а причина совсем в другом.
    expect(body.error).not.toMatch(/сформулир/i);
  });

  it('403 говорит про доступ и средства', async () => {
    expect((await anthropicFailure(withStatus(403)).json()).error).toMatch(/средств|доступ/i);
  });

  it('429 говорит про ограничение', async () => {
    expect((await anthropicFailure(withStatus(429)).json()).error).toMatch(/ограничив/i);
  });

  it('неизвестная ошибка сохраняет прежний текст про формулировку', async () => {
    expect((await anthropicFailure(withStatus(500)).json()).error).toMatch(/сформулир/i);
  });
});
