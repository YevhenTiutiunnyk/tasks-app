import { NextResponse } from 'next/server';
import { addDays, isValidIsoDate, weekRange } from '@/lib/dates';
import { getSettings } from '@/lib/db';
import { loadRange, loadWeek } from '@/lib/week';
import { parseCommand } from '@/lib/parse';
import { validateParseResult } from '@/lib/validate';
import { applyOperations } from '@/lib/apply';

export async function POST(request: Request) {
  const { text, today, timezone } = (await request.json()) as {
    text?: string;
    today?: string;
    timezone?: string;
  };

  if (!text?.trim()) {
    return NextResponse.json({ error: 'Пустая фраза' }, { status: 400 });
  }
  if (!today || !isValidIsoDate(today)) {
    return NextResponse.json({ error: 'Некорректная дата' }, { status: 400 });
  }

  // Контекст для модели — текущая неделя и обе соседние.
  const { from, to } = weekRange(today);
  const contextFrom = addDays(from, -7);
  const contextTo = addDays(to, 7);

  const [contextTasks, settings] = await Promise.all([
    loadRange(contextFrom, contextTo),
    getSettings(),
  ]);

  let parsed;
  try {
    parsed = await parseCommand({
      text,
      today,
      timezone: timezone ?? 'UTC',
      tasks: contextTasks,
      settings,
    });
  } catch (error) {
    console.error('parseCommand failed', error);
    return NextResponse.json(
      { error: 'Не получилось разобрать фразу. Попробуй сформулировать иначе.' },
      { status: 502 },
    );
  }

  const checked = validateParseResult(parsed, { tasks: contextTasks, categories: settings.categories });

  if (checked.operations.length === 0) {
    return NextResponse.json({
      batchId: null,
      reply: parsed.reply,
      rejected: checked.rejected,
      needsTime: [],
      week: await loadWeek(today),
    });
  }

  let batchId: string;
  try {
    ({ batchId } = await applyOperations(text, checked.operations));
  } catch (error) {
    console.error('applyOperations failed', error);
    return NextResponse.json({ error: 'Не получилось сохранить изменения' }, { status: 500 });
  }

  const week = await loadWeek(today);

  // Сопоставляем вопросы про время с уже созданными задачами.
  const needsTime = checked.needsTime.flatMap((entry) => {
    const operation = checked.operations[entry.operationIndex];
    if (operation.type !== 'create') return [];
    const task = week.tasks.find(
      (t) => t.title === operation.title && t.date === operation.date && t.allDay,
    );
    return task ? [{ taskId: task.id, title: task.title, question: entry.question }] : [];
  });

  return NextResponse.json({
    batchId,
    reply: parsed.reply,
    rejected: checked.rejected,
    needsTime,
    week,
  });
}
