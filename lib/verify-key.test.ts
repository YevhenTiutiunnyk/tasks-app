import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { verifyApiKey } from './verify-key';

/** Клиент, у которого messages.create отвечает или падает как велено. */
function fakeClient(behaviour: { status?: number } | 'ok'): Anthropic {
  return {
    messages: {
      create: async () => {
        if (behaviour === 'ok') return { id: 'msg_zz' };
        const error = new Error('ZZ-имитация ответа Anthropic') as Error & { status?: number };
        error.status = behaviour.status;
        throw error;
      },
    },
  } as unknown as Anthropic;
}

describe('verifyApiKey', () => {
  it('успех — ok', async () => {
    expect(await verifyApiKey(fakeClient('ok'))).toEqual({ kind: 'ok' });
  });

  it('401 — ключа не существует, счётчику это считать', async () => {
    const verdict = await verifyApiKey(fakeClient({ status: 401 }));
    expect(verdict.kind).toBe('rejected');
  });

  it('403 — ключ настоящий, счётчику это НЕ считать', async () => {
    // Иначе запирали бы на час своего же человека, который положил денег
    // на счёт и переспрашивает.
    const verdict = await verifyApiKey(fakeClient({ status: 403 }));
    expect(verdict.kind).toBe('refused');
  });

  it('429 — ограничение, не считаем', async () => {
    const verdict = await verifyApiKey(fakeClient({ status: 429 }));
    expect(verdict.kind).toBe('refused');
    expect(verdict.kind === 'refused' && verdict.status).toBe(429);
  });

  it('обрыв связи — не считаем', async () => {
    const verdict = await verifyApiKey(fakeClient({ status: undefined }));
    expect(verdict.kind).toBe('refused');
  });

  it('ни один исход не отвечает кодом 401', async () => {
    // Экран настроек на 401 уводит на /login. Ответь мы 401 на «Anthropic
    // не принял ключ» — человека выбрасывало бы из аккаунта при опечатке.
    for (const status of [401, 403, 429, undefined]) {
      const verdict = await verifyApiKey(fakeClient({ status }));
      expect(verdict.kind === 'ok' ? 200 : verdict.status).not.toBe(401);
    }
  });
});
