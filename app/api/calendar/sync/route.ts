import { NextResponse } from 'next/server';
import { calendarDeps, syncUser } from '@/lib/calendar-run';
import { getTimezone } from '@/lib/db';
import { nowInZone } from '@/lib/notify';
import { requireUser } from '@/lib/require-user';

/**
 * Обновление по открытию приложения. Пятиминутный интервал между фоновыми
 * прогонами человек не замечает ровно потому, что открыв экран, он получает
 * свежее сразу, не дожидаясь следующего тика планировщика.
 *
 * Отказ здесь — не повод показывать беду: расписание уже отрисовано без
 * этого запроса, встречи просто останутся вчерашними до следующего фонового
 * прогона.
 */
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  try {
    const { today } = nowInZone(await getTimezone(user.userId));
    const { synced, failed } = await syncUser(calendarDeps, user.userId, today, new Date());
    // syncUser сама не логирует (lib/ в лог не пишет — см. её комментарий),
    // а после отказа календарь помечается brokenAt, и планировщик такие
    // календари молча пропускает (calendar.brokenAt !== null => continue).
    // Значит именно этот момент — единственный шанс вообще заметить сбой:
    // не напиши мы здесь, поломка не оставит следа никогда.
    if (failed > 0) console.error('calendar: часть календарей не синхронизирована при открытии');
    return NextResponse.json({ synced, failed });
  } catch {
    // Ни адреса, ни идентификатора владельца — только факт сбоя.
    console.error('calendar: обновление по открытию не удалось');
    return NextResponse.json({ synced: 0, failed: 0 });
  }
}
