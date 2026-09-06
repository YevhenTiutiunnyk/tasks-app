import { NextResponse } from 'next/server';
import { getLatestReport } from '@/lib/db';
import { requireUser } from '@/lib/require-user';

/**
 * Последний собранный отчёт.
 *
 * Параметров нет: экран показывает последний, выбирать нечего.
 *
 * Отчёта ещё нет — это 200 с пустым weekStart, а не 404. Первая неделя
 * пользования — нормальное состояние, а не ошибка, и экран должен уметь
 * сказать об этом словами, а не показывать сообщение о сбое.
 */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const latest = await getLatestReport(user.userId);
  return NextResponse.json(latest ?? { weekStart: null, report: null });
}
