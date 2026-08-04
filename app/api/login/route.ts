import { NextResponse } from 'next/server';
import { signSession } from '@/lib/auth';

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

  const { password } = (await request.json()) as { password?: string };
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
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
