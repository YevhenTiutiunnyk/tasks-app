import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { sql } from '@/lib/db';
import { applyOperations } from '@/lib/apply';
import { loadWeek } from '@/lib/week';
import { parseOccurrenceId } from '@/lib/recurrence';
import type { Operation } from '@/lib/types';

async function respond(today: string, batchId: string | null) {
  return NextResponse.json({ batchId, week: await loadWeek(today) });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    today: string;
    title: string;
    date: string;
    startMinute: number | null;
    durationMinutes: number | null;
    allDay: boolean;
    categoryId: string | null;
  };
  if (!isValidIsoDate(body.today) || !isValidIsoDate(body.date) || !body.title.trim()) {
    return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });
  }
  const operation: Operation = {
    type: 'create', title: body.title, date: body.date, startMinute: body.startMinute,
    durationMinutes: body.durationMinutes, allDay: body.allDay,
    categoryId: body.categoryId, recurrence: null,
  };
  const { batchId } = await applyOperations('создано вручную', [operation]);
  return respond(body.today, batchId);
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    today: string;
    taskId: string;
    scope?: 'one' | 'series';
    title?: string | null;
    date?: string | null;
    startMinute?: number | null;
    durationMinutes?: number | null;
    allDay?: boolean | null;
    categoryId?: string | null;
    done?: boolean;
  };

  if (!isValidIsoDate(body.today)) {
    return NextResponse.json({ error: 'Некорректная дата' }, { status: 400 });
  }

  // Отметка «выполнено» серию не трогает и в журнал не пишется.
  if (body.done !== undefined) {
    const occurrence = parseOccurrenceId(body.taskId);
    if (occurrence) {
      return NextResponse.json(
        { error: 'Сначала измени это занятие, потом отмечай выполненным' },
        { status: 400 },
      );
    }
    await sql`update tasks set done = ${body.done}, updated_at = now() where id = ${body.taskId}`;
    return respond(body.today, null);
  }

  // Правка всей серии меняет само правило.
  const occurrence = parseOccurrenceId(body.taskId);
  if (body.scope === 'series' && occurrence) {
    const patch: Record<string, unknown> = {};
    if (body.title != null) patch.title = body.title;
    if (body.startMinute != null) patch.start_minute = body.startMinute;
    if (body.durationMinutes != null) patch.duration_minutes = body.durationMinutes;
    if (body.allDay != null) patch.all_day = body.allDay;
    if (body.categoryId !== undefined) patch.category_id = body.categoryId;
    if (Object.keys(patch).length > 0) {
      await sql`update recurrences set ${sql(patch)} where id = ${occurrence.recurrenceId}`;
    }
    return respond(body.today, null);
  }

  const operation: Operation = {
    type: 'update',
    taskId: body.taskId,
    title: body.title ?? null,
    date: body.date ?? null,
    startMinute: body.startMinute ?? null,
    durationMinutes: body.durationMinutes ?? null,
    allDay: body.allDay ?? null,
    categoryId: body.categoryId ?? null,
  };
  const { batchId } = await applyOperations('изменено вручную', [operation]);
  return respond(body.today, batchId);
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as {
    today: string;
    taskId: string;
    scope?: 'one' | 'series';
  };
  if (!isValidIsoDate(body.today)) {
    return NextResponse.json({ error: 'Некорректная дата' }, { status: 400 });
  }

  const occurrence = parseOccurrenceId(body.taskId);
  if (body.scope === 'series' && occurrence) {
    await sql`delete from recurrences where id = ${occurrence.recurrenceId}`;
    return respond(body.today, null);
  }

  const { batchId } = await applyOperations('удалено вручную', [
    { type: 'delete', taskId: body.taskId },
  ]);
  return respond(body.today, batchId);
}
