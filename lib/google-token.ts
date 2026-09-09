import 'server-only';
import { auth } from './auth';
import { CalendarAccessLost, googleClient, type CalendarClient } from './google-api';

/**
 * Свежий access-токен владельца. Обновление по refresh-токену делает
 * Better Auth — своей реализации у нас нет и быть не должно: она бы
 * разошлась с тем, как библиотека хранит и шифрует токены.
 */
export async function getCalendarClient(userId: string): Promise<CalendarClient> {
  let accessToken: string | undefined;
  try {
    const result = await auth.api.getAccessToken({ body: { providerId: 'google', userId } });
    accessToken = result?.accessToken;
  } catch {
    // Наружу — только «доступа нет»: в исключении может быть токен.
    throw new CalendarAccessLost();
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
