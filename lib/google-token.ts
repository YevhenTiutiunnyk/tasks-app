import 'server-only';
import { auth } from './auth';
import { CalendarAccessLost, googleClient, type CalendarClient } from './google-api';

/**
 * Похоже ли пойманное значение на структурный отказ auth-слоя, а не на
 * сырой низкоуровневый сбой.
 *
 * Better Auth заворачивает СВОИ решения (нет привязанного аккаунта, не
 * удалось обновить токен) в `APIError` — у неё всегда есть код статуса
 * (`status`/`statusCode`). Раньше `getCalendarClient` превращал в
 * `CalendarAccessLost` ЛЮБОЙ пойманный отказ подряд, включая обрыв сети
 * при самом запросе за токеном — а такой сбой не значит «доступа нет»:
 * это погода, а не отозванное разрешение. `broken_at` при нём ставиться
 * не должен (находка второго круга финального ревью). Наличие кода
 * статуса — единственная проверяемая снаружи форма отличия: у структурного
 * отказа она есть, у голого исключения (TypeError сети и подобного) — нет.
 */
function looksLikeApiRejection(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null
    && ('statusCode' in error || 'status' in error)
  );
}

/**
 * Свежий access-токен владельца. Обновление по refresh-токену делает
 * Better Auth — своей реализации у нас нет и быть не должно: она бы
 * разошлась с тем, как библиотека хранит и шифрует токены.
 *
 * Содержимое пойманного исключения никуда не идёт — ни в лог, ни в текст
 * новой ошибки: внутри может быть токен.
 */
export async function getCalendarClient(userId: string): Promise<CalendarClient> {
  let accessToken: string | undefined;
  try {
    const result = await auth.api.getAccessToken({ body: { providerId: 'google', userId } });
    accessToken = result?.accessToken;
  } catch (error) {
    if (looksLikeApiRejection(error)) throw new CalendarAccessLost();
    // Не структурный отказ — например, сеть упала при самом запросе
    // за токеном. Это не «доступа нет», а транзиентный сбой: обычная
    // ошибка, роут вокруг календаря её не сочтёт потерей доступа.
    throw new Error('Не удалось получить токен Google Calendar');
  }
  if (!accessToken) throw new CalendarAccessLost();
  return googleClient(accessToken);
}

export async function hasCalendarAccess(userId: string): Promise<boolean> {
  try {
    await getCalendarClient(userId);
    return true;
  } catch {
    return false;
  }
}
