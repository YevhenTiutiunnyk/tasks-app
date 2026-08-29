import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { clearUserKey, getUserKey, registerKeyFailure, saveUserKey } from '@/lib/db';
import { badRequest, readJson } from '@/lib/http';
import { requireUser } from '@/lib/require-user';
import { encryptApiKey } from '@/lib/user-key';
import { verifyApiKey } from '@/lib/verify-key';

// Границы грубые нарочно: они отсекают пустую вставку и случайно вставленную
// простыню, а не угадывают формат ключа. Префикс sk-ant- намеренно не
// проверяется — настоящая проверка стоит доли цента, а жёсткий префикс это
// наш собственный отказ выдать доступ в день, когда Anthropic сменит формат.
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 500;

export const MAX_KEY_ATTEMPTS = 5;
export const KEY_LOCK_SECONDS = 60 * 60;

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const row = await getUserKey(user.userId);
  const locked = row?.lockedUntil && row.lockedUntil > new Date() ? row.lockedUntil : null;
  // Ни байта материала ключа: ни хвостика, ни длины, ни шифротекста.
  return NextResponse.json({
    present: row?.present ?? false,
    keySetAt: row?.keySetAt?.toISOString() ?? null,
    lockedUntil: locked?.toISOString() ?? null,
  });
}

export async function PUT(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  // Пауза проверяется первой: запертая строка не должна доходить до Anthropic
  // вовсе, иначе паузу можно было бы использовать как бесплатный оракул.
  const existing = await getUserKey(user.userId);
  if (existing?.lockedUntil && existing.lockedUntil > new Date()) {
    return NextResponse.json(
      {
        error: 'Слишком много неверных ключей подряд. Попробуй позже.',
        lockedUntil: existing.lockedUntil.toISOString(),
      },
      { status: 429 },
    );
  }

  const body = await readJson<{ key?: unknown }>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');
  if (typeof body.key !== 'string') return badRequest('Ключ должен быть строкой');

  const key = body.key.trim();
  if (!key) return badRequest('Пустой ключ');
  if (/\s/.test(key)) return badRequest('В ключе не должно быть пробелов');
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    return badRequest(
      `Ключ должен быть длиной от ${MIN_KEY_LENGTH} до ${MAX_KEY_LENGTH} символов`,
    );
  }

  const verdict = await verifyApiKey(new Anthropic({ apiKey: key }));

  if (verdict.kind === 'rejected') {
    // Счётчик растёт ТОЛЬКО здесь. Перебор чужих ключей состоит почти целиком
    // из несуществующих, то есть из этого исхода; считать сюда же 403 значило
    // бы запирать своего же человека, который пополнил счёт и переспрашивает.
    const { lockedUntil } = await registerKeyFailure(
      user.userId,
      MAX_KEY_ATTEMPTS,
      KEY_LOCK_SECONDS,
    );
    return NextResponse.json(
      { error: verdict.message, lockedUntil: lockedUntil?.toISOString() ?? null },
      { status: verdict.status },
    );
  }

  if (verdict.kind === 'refused') {
    return NextResponse.json({ error: verdict.message }, { status: verdict.status });
  }

  await saveUserKey(user.userId, encryptApiKey(user.userId, key));
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  await clearUserKey(user.userId);
  return NextResponse.json({ ok: true });
}
