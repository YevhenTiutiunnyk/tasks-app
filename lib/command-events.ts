import 'server-only';
import { getEventsBetween, getTimezone } from './db';
import { splitIntoDays } from './calendar';
import { addDays } from './dates';
import type { EventDay } from './types';

/**
 * Встречи для контекста модели и предупреждения о наложении в `/api/command`
 * — необязательный довесок к разбору фразы, а не то, без чего его нельзя
 * выполнить. Сбой чтения `google_events` (недоступна база, истёк токен
 * Google) не должен ронять весь путь: без встреч фраза всё равно
 * разбирается и применяется, просто без наложений в этом прогоне.
 *
 * Вынесена в отдельный модуль (а не оставлена внутри route.ts), чтобы её
 * можно было проверить в изоляции: именно эта функция обязана никогда не
 * отклонять промис, и это удобнее гарантировать unit-тестом, чем чтением
 * глазами.
 */
export async function loadEventsForCommand(
  userId: string, contextFrom: string, contextTo: string,
): Promise<EventDay[]> {
  try {
    const [timezone, rawEvents] = await Promise.all([
      getTimezone(userId),
      // Сутки с запасом с каждой стороны, как в loadWeek: встреча, начавшаяся
      // в 23:30 по местному времени крайнего дня контекста, в UTC уже
      // на соседних сутках и без запаса не попала бы в выборку.
      getEventsBetween(
        userId,
        `${addDays(contextFrom, -1)}T00:00:00.000Z`,
        `${addDays(contextTo, 2)}T00:00:00.000Z`,
      ),
    ]);
    return splitIntoDays(rawEvents, timezone, contextFrom, contextTo);
  } catch {
    // Только стадия: сам объект ошибки может нести адрес или id владельца,
    // а событие — название встречи (пункт про логи в брифе).
    console.error('command: сбой чтения встреч (загрузка календаря)');
    return [];
  }
}
