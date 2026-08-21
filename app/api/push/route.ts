import { NextResponse } from 'next/server';
import { addSubscription, removeSubscription } from '@/lib/db';
import { badRequest, readJson } from '@/lib/http';
import { requireUser } from '@/lib/require-user';

interface Body {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

/** Подписаться на уведомления. Идёт под сессией, как и весь остальной api. */
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const body = await readJson<Body>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');

  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys.auth) {
    return badRequest('Подписка неполная');
  }

  await addSubscription(user.userId, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
  return NextResponse.json({ ok: true });
}

/** Отписаться. Тело то же, значим только endpoint. */
export async function DELETE(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const body = await readJson<Body>(request);
  if (!body?.endpoint) return badRequest('Не указан endpoint подписки');

  await removeSubscription(user.userId, body.endpoint);
  return NextResponse.json({ ok: true });
}
