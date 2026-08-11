import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мок объявляется до импорта proxy — отсюда динамический import ниже:
// статический import наверху файла сломал бы подмену.
const getSession = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: () => getSession() } } }));

const { proxy } = await import('./proxy');

beforeEach(() => {
  getSession.mockReset();
});

describe('proxy', () => {
  it('пропускает запрос, когда сессия есть', async () => {
    getSession.mockResolvedValue({ user: { id: 'zz-user' } });
    const response = await proxy(new NextRequest('https://example.test/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('отвечает 401 на api без сессии, а не редиректом', async () => {
    // Редирект на /login в ответ на fetch превратился бы для клиента
    // в HTML вместо JSON — и в невнятную ошибку разбора на экране.
    getSession.mockResolvedValue(null);
    const response = await proxy(new NextRequest('https://example.test/api/week'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Не авторизован' });
  });

  it('уводит страницу на вход без сессии', async () => {
    getSession.mockResolvedValue(null);
    const response = await proxy(new NextRequest('https://example.test/settings'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.test/login');
  });
});
