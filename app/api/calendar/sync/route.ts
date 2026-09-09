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
    const { synced } = await syncUser(calendarDeps, user.userId, today, new Date());
    return NextResponse.json({ synced });
  } catch {
    // Ни адреса, ни идентификатора владельца — только факт сбоя.
    console.error('calendar: обновление по открытию не удалось');
    return NextResponse.json({ synced: 0 });
  }
}
