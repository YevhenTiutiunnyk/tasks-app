import { describe, it, expect } from 'vitest';
import { signSession, verifySession } from './auth';

const SECRET = 'test-secret-that-is-long-enough-1234';

describe('session cookie', () => {
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
});
