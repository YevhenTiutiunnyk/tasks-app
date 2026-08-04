import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { sql } from '@/lib/db';
import { loadWeek } from '@/lib/week';
import { parseClarification } from '@/lib/parse-clarify';

export async function POST(request: Request) {
  const { answers, today } = (await request.json()) as {
    answers?: { taskId: string; text: string }[];
    today?: string;
  };

  if (!answers?.length) return NextResponse.json({ error: 'Нечего уточнять' }, { status: 400 });
  if (!today || !isValidIsoDate(today)) {
    return NextResponse.json({ error: 'Некорректная дата' }, { status: 400 });
  }

  const failed: string[] = [];

  for (const answer of answers) {
    const [row] = await sql`select * from tasks where id = ${answer.taskId}`;
    if (!row) continue;

    let slot;
    try {
      slot = await parseClarification(answer.text, row.date, today);
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
