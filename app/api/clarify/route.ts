import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { sql, toIsoDate } from '@/lib/db';
import { badRequest, readJson } from '@/lib/http';
import { isValidTaskId } from '@/lib/validate';
import { loadWeek } from '@/lib/week';
import { parseClarification } from '@/lib/parse-clarify';

export async function POST(request: Request) {
  const body = await readJson<{
    answers?: { taskId: string; text: string }[];
    today?: string;
  }>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');
  const { answers, today } = body;

  if (!answers?.length) return badRequest('Нечего уточнять');
  if (!today || !isValidIsoDate(today)) return badRequest('Некорректная дата');
  if (answers.some((a) => !isValidTaskId(a.taskId) || typeof a.text !== 'string')) {
    return badRequest('Некорректный ответ на уточнение');
  }

  const failed: string[] = [];

  for (const answer of answers) {
    const [row] = await sql`select * from tasks where id = ${answer.taskId}`;
    if (!row) continue;

    let slot;
    try {
      // Драйвер отдаёт колонку date объектом Date, а разбор ждёт строку
      // 'YYYY-MM-DD'. Без toIsoDate уточнение молча не срабатывало бы.
      slot = await parseClarification(answer.text, toIsoDate(row.date), today);
    } catch {
      failed.push(answer.taskId);
      continue;
    }
    if (slot === null) {
      failed.push(answer.taskId);
      continue;
    }

    await sql`
      update tasks set
        date = ${slot.date},
        start_minute = ${slot.startMinute},
        duration_minutes = ${slot.durationMinutes},
        all_day = false,
        updated_at = now()
      where id = ${answer.taskId}
    `;
  }

  return NextResponse.json({ failed, week: await loadWeek(today) });
}
