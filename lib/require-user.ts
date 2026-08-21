import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from './auth';

/**
 * Владелец запроса — или готовый отказ.
 *
 * Сессию гарантирует proxy.ts, но роут на это не полагается: пусто — отказ,
 * а не догадка. Ошибку базы не глушим здесь, чтобы она не превратилась
 * в тихий 401: пусть всплывает и роут отвечает 500, это видно.
 */
export async function requireUser(
  request: Request,
): Promise<{ userId: string; response?: undefined } | { userId?: undefined; response: NextResponse }> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return { response: NextResponse.json({ error: 'Не авторизован' }, { status: 401 }) };
  }
  return { userId: session.user.id };
}
