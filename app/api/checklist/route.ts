import { NextResponse } from 'next/server';
import { addDays, isValidIsoDate } from '@/lib/dates';
import { getChecklistTasks, hasUserKey } from '@/lib/db';
import { requireUser } from '@/lib/require-user';

/**
 * Чеклист — только про дела без дня, поэтому все три секции идут одним и
 * тем же запросом по горизонту (getChecklistTasks), а раскрытие повторов
 * здесь не нужно вовсе: правила повтора описываются днями недели и дают
 * только дневные задачи, которых в чеклисте нет.
 */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const date = new URL(request.url).searchParams.get('date');
  if (!date || !isValidIsoDate(date)) {
    return NextResponse.json({ error: 'Нужен параметр date вида YYYY-MM-DD' }, { status: 400 });
  }

  const [week, nextWeek, month, hasKey] = await Promise.all([
    getChecklistTasks(user.userId, 'week', date),
    // Якорь следующей недели: getChecklistTasks приводит любую дату внутри
    // периода к его началу, поэтому достаточно сдвинуть на семь дней.
    getChecklistTasks(user.userId, 'week', addDays(date, 7)),
    getChecklistTasks(user.userId, 'month', date),
    hasUserKey(user.userId),
  ]);

  return NextResponse.json({ week, nextWeek, month, hasKey });
}
