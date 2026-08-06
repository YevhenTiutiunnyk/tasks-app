import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { undoBatch } from '@/lib/apply';
import { sql } from '@/lib/db';
import { badRequest, readJson } from '@/lib/http';
import { loadWeek } from '@/lib/week';

export async function POST(request: Request) {
  const body = await readJson<{ batchId?: string; today?: string }>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');
  const { batchId, today } = body;
  if (!batchId) return badRequest('Нет batchId');
  if (!today || !isValidIsoDate(today)) return badRequest('Некорректная дата');

  // Откатывать можно только самую свежую пачку. Откат старой мог бы удалить
  // созданное ею правило повтора, а вместе с ним каскадом — задачи, которые
  // появились уже после неё. Заодно отсекает мусор вместо идентификатора:
  // до undoBatch, который упал бы на приведении к uuid, дело не доходит.
  // id desc как разрешение ничьей: created_at — момент начала транзакции,
  // и две пачки теоретически могут получить одинаковый.
  const [latest] = await sql`select id from command_log order by created_at desc, id desc limit 1`;
  if (!latest || latest.id !== batchId) {
    return NextResponse.json({ undone: false, week: await loadWeek(today) });
  }

  const undone = await undoBatch(batchId);
  return NextResponse.json({ undone, week: await loadWeek(today) });
}
