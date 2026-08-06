import { describe, it, expect, vi, afterEach } from 'vitest';
import { SESSION_MAX_AGE_SECONDS, signSession, verifySession } from './auth';

const SECRET = 'test-secret-that-is-long-enough-1234';

describe('session cookie', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('принимает собственную подпись', async () => {
    const token = await signSession(SECRET);
    expect(await verifySession(token, SECRET)).toBe(true);
  });

  it('отвергает подпись другим секретом', async () => {
    const token = await signSession('another-secret-value-000000000000');
    expect(await verifySession(token, SECRET)).toBe(false);
  });

  it('отвергает подделанный токен', async () => {
    const token = await signSession(SECRET);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(await verifySession(tampered, SECRET)).toBe(false);
  });

  it('отвергает мусор', async () => {
    expect(await verifySession('', SECRET)).toBe(false);
    expect(await verifySession('нет-точки', SECRET)).toBe(false);
  });

  // Метка времени клалась в токен, но никогда не читалась: утёкшую куку
  // нельзя было отозвать ничем, кроме смены SESSION_SECRET.
  it('отвергает токен старше срока жизни сессии', async () => {
    const token = await signSession(SECRET);
    // Подменяем только Date: таймеры подписи и проверки не касаются.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + (SESSION_MAX_AGE_SECONDS + 60) * 1000);
    expect(await verifySession(token, SECRET)).toBe(false);
  });

  it('принимает токен моложе срока жизни сессии', async () => {
    const token = await signSession(SECRET);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + (SESSION_MAX_AGE_SECONDS - 60) * 1000);
    expect(await verifySession(token, SECRET)).toBe(true);
  });

  it('отвергает токен с меткой времени не из подписи', async () => {
    const token = await signSession(SECRET);
    const signature = token.slice(token.lastIndexOf('.') + 1);
    expect(await verifySession(`${Date.now() + 1000}.${signature}`, SECRET)).toBe(false);
    expect(await verifySession(`не-число.${signature}`, SECRET)).toBe(false);
  });
});
