import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { decryptApiKey } from './user-key';
import type { UserKeyRow } from './db';

/**
 * Строка базы → готовый клиент либо готовый отказ.
 *
 * Форма повторяет requireUser намеренно: в роуте получается одна и та же
 * узнаваемая пара строк — вызвать и вернуть response, если он есть.
 */
export function clientForUser(
  userId: string,
  row: UserKeyRow | null,
):
  | { client: Anthropic; response?: undefined }
  | { client?: undefined; response: NextResponse } {
  if (!row?.sealed) {
    // Страховка: экран сюда не пустит, потому что знает hasKey.
    return {
      response: NextResponse.json(
        { error: 'Нужен свой ключ Anthropic — заведи его в настройках', code: 'no_key' },
        { status: 409 },
      ),
    };
  }

  const apiKey = decryptApiKey(userId, row.sealed);
  if (apiKey === null) {
    // null здесь значит: сменился KEY_ENCRYPTION_KEY или побились байты
    // шифротекста. Отсутствующая или неверной длины переменная окружения
    // сюда не доходит — decryptApiKey бросает ниже, до этой развилки,
    // и намеренно не ловится: это авария развёртывания, а не состояние
    // конкретного ключа. См. lib/user-key.ts и lib/user-key.test.ts.
    return {
      response: NextResponse.json(
        { error: 'Ключ больше не читается, введи его заново', code: 'key_unreadable' },
        { status: 409 },
      ),
    };
  }

  // 409, а не 400: тело запроса безупречно, выполнить не позволяет состояние
  // учётной записи.
  return { client: new Anthropic({ apiKey }) };
}

/**
 * Ошибка Anthropic уже во время разбора.
 *
 * Раньше здесь на любую ошибку отвечали «попробуй сформулировать иначе».
 * Для отозванного ключа это приговор: человек будет переформулировать фразу
 * до бесконечности, а причина совсем в другом.
 *
 * Строку в базе при этом не помечаем: отзыв бывает временным, а лишний флаг
 * «ключ протух» пришлось бы потом снимать — новое состояние и новый способ
 * соврать.
 */
export function anthropicFailure(error: unknown): NextResponse {
  const status = (error as { status?: number } | null)?.status;
  const message =
    status === 401
      ? 'Твой ключ больше не принимается Anthropic. Проверь его в настройках.'
      : status === 403
        ? 'Нет доступа к модели либо на счету твоего ключа нет средств.'
        : status === 429
          ? 'Anthropic ограничивает твой ключ, попробуй через минуту.'
          : 'Не получилось разобрать фразу. Попробуй сформулировать иначе.';
  return NextResponse.json({ error: message }, { status: 502 });
}
