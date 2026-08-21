import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { sql, toIsoDate } from '@/lib/db';
import { badRequest, readJson } from '@/lib/http';
import { requireUser } from '@/lib/require-user';
import { isValidTaskId } from '@/lib/validate';
import { loadWeek } from '@/lib/week';
import { parseClarification } from '@/lib/parse-clarify';

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const body = await readJson<{
    answers?: { taskId: string; text: string }[];
    today?: string;
  }>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');
  const { answers, today } = body;

  // Именно массив: у строки тоже есть length, и {"answers":"abc"} проезжал
  // проверку насквозь, чтобы упасть на answers.some с ответом 500.
  if (!Array.isArray(answers) || answers.length === 0) return badRequest('Нечего уточнять');
  if (!today || !isValidIsoDate(today)) return badRequest('Некорректная дата');
  if (answers.some((a) => !a || !isValidTaskId(a.taskId) || typeof a.text !== 'string')) {
    return badRequest('Некорректный ответ на уточнение');
  }

  const failed: string[] = [];

  for (const answer of answers) {
    // Чужая задача пропускается ровно так же, как несуществующая, и до разбора
    // фразы моделью дело не доходит. Ответь роут по-разному — и перебором
    // идентификаторов узнавалось бы, что вообще есть в чужом расписании.
    const [row] = await sql`
      select * from tasks where id = ${answer.taskId} and user_id = ${user.userId}
    `;
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
      where id = ${answer.taskId} and user_id = ${user.userId}
    `;
  }

  return NextResponse.json({ failed, week: await loadWeek(user.userId, today) });
}
