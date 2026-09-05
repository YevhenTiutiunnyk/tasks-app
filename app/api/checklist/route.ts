import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { getChecklistTasks, hasUserKey } from '@/lib/db';
import { requireUser } from '@/lib/require-user';
import { loadRange } from '@/lib/week';

/**
 * Три секции чеклиста одним запросом.
 *
 * Сегодняшняя секция идёт через loadRange, а не через getChecklistTasks:
 * в ней должны быть и вхождения повторов, которые материализуются только
 * при раскрытии правил. Недельная и месячная — обычные строки, повторов
 * без дня не бывает.
 */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const date = new URL(request.url).searchParams.get('date');
  if (!date || !isValidIsoDate(date)) {
    return NextResponse.json({ error: 'Нужен параметр date вида YYYY-MM-DD' }, { status: 400 });
  }

  const [today, week, month, hasKey] = await Promise.all([
    loadRange(user.userId, date, date),
    getChecklistTasks(user.userId, 'week', date),
    getChecklistTasks(user.userId, 'month', date),
    hasUserKey(user.userId),
  ]);

  return NextResponse.json({ today, week, month, hasKey });
}
