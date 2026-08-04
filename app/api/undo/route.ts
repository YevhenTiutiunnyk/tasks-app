import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { undoBatch } from '@/lib/apply';
import { sql } from '@/lib/db';
import { loadWeek } from '@/lib/week';

export async function POST(request: Request) {
  const { batchId, today } = (await request.json()) as { batchId?: string; today?: string };
  if (!batchId) return NextResponse.json({ error: 'Нет batchId' }, { status: 400 });
  if (!today || !isValidIsoDate(today)) {
    return NextResponse.json({ error: 'Некорректная дата' }, { status: 400 });
  }

  // Откатывать можно только самую свежую пачку. Откат старой мог бы удалить
  // созданное ею правило повтора, а вместе с ним каскадом — задачи, которые
  // появились уже после неё. Заодно отсекает мусор вместо идентификатора:
  // до undoBatch, который упал бы на приведении к uuid, дело не доходит.
  const [latest] = await sql`select id from command_log order by created_at desc limit 1`;
  if (!latest || latest.id !== batchId) {
    return NextResponse.json({ undone: false, week: await loadWeek(today) });
  }

  const undone = await undoBatch(batchId);
  return NextResponse.json({ undone, week: await loadWeek(today) });
}
