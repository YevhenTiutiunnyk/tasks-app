import { NextResponse } from 'next/server';
import { SESSION_MAX_AGE_SECONDS, signSession } from '@/lib/auth';
import { badRequest, readJson } from '@/lib/http';

const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  rec.count += 1;
  return rec.count > 10;
}

export async function POST(request: Request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'Слишком много попыток. Подожди минуту.' }, { status: 429 });
  }

  // Как и в остальных роутах: битое тело — это 400, а не необработанное
  // исключение с ответом 500.
  const body = await readJson<{ password?: string }>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');

  const { password } = body;
  if (!password || password !== process.env.APP_PASSWORD) {
    return NextResponse.json({ error: 'Неверный пароль' }, { status: 401 });
  }

  const token = await signSession(process.env.SESSION_SECRET!);
  const response = NextResponse.json({ ok: true });
  response.cookies.set('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
