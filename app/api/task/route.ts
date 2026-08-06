import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { sql } from '@/lib/db';
import { applyOperations } from '@/lib/apply';
import { badRequest, readJson } from '@/lib/http';
import { isValidSlot, isValidTaskId } from '@/lib/validate';
import { loadWeek } from '@/lib/week';
import { parseOccurrenceId } from '@/lib/recurrence';
import type { Operation } from '@/lib/types';

async function respond(today: string, batchId: string | null) {
  return NextResponse.json({ batchId, week: await loadWeek(today) });
}

/**
 * applyOperations бросает, если задачи уже нет — например при двойном клике
 * по «удалить» или на устаревшей вкладке. Это не сбой сервера, а гонка,
 * поэтому отвечаем 409, а не 500.
 */
async function applyOrConflict(text: string, operations: Operation[], today: string) {
  try {
    const { batchId } = await applyOperations(text, operations);
    return respond(today, batchId);
  } catch (error) {
    console.error('applyOperations failed', error);
    return NextResponse.json({ error: 'Задача изменилась или уже удалена' }, { status: 409 });
  }
}

export async function POST(request: Request) {
  const body = await readJson<{
    today: string;
    title: string;
    date: string;
    startMinute: number | null;
    durationMinutes: number | null;
    allDay: boolean;
    categoryId: string | null;
  }>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');
  if (!isValidIsoDate(body.today) || !isValidIsoDate(body.date)) {
    return badRequest('Некорректная дата');
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    return badRequest('Пустое название');
  }
  if (!isValidSlot(body)) {
    return badRequest('Некорректное время или длительность');
  }
  const operation: Operation = {
    type: 'create', title: body.title, date: body.date, startMinute: body.startMinute,
    durationMinutes: body.durationMinutes, allDay: body.allDay,
    categoryId: body.categoryId, recurrence: null,
  };
  return applyOrConflict('создано вручную', [operation], body.today);
}

export async function PATCH(request: Request) {
  const body = await readJson<{
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
    replace?: boolean;
  }>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');

  if (!isValidIsoDate(body.today)) return badRequest('Некорректная дата');
  if (!isValidTaskId(body.taskId)) return badRequest('Некорректный идентификатор задачи');
  if (body.date != null && !isValidIsoDate(body.date)) return badRequest('Некорректная дата');
  if (!isValidSlot(body)) return badRequest('Некорректное время или длительность');

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

  // Карточка задачи присылает все поля разом и просит полную замену (replace:
  // true) — тогда название обязательно, иначе с replace пустое или
  // отсутствующее затёрло бы его в базе. Перетаскивание знает только дату и
  // время и флаг не ставит, поэтому его сюда не пускаем.
  const replace = body.replace === true;
  if (replace && (typeof body.title !== 'string' || !body.title.trim())) {
    return badRequest('Пустое название');
  }

  // При replace null значит «очистить», а не «поле не названо».
  const operation: Operation = {
    type: 'update',
    replace,
    taskId: body.taskId,
    title: body.title ?? null,
    date: body.date ?? null,
    startMinute: body.startMinute ?? null,
    durationMinutes: body.durationMinutes ?? null,
    allDay: body.allDay ?? null,
    categoryId: body.categoryId ?? null,
  };
  return applyOrConflict('изменено вручную', [operation], body.today);
}

export async function DELETE(request: Request) {
  const body = await readJson<{
    today: string;
    taskId: string;
    scope?: 'one' | 'series';
  }>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');
  if (!isValidIsoDate(body.today)) return badRequest('Некорректная дата');
  if (!isValidTaskId(body.taskId)) return badRequest('Некорректный идентификатор задачи');

  const occurrence = parseOccurrenceId(body.taskId);
  if (body.scope === 'series' && occurrence) {
    await sql`delete from recurrences where id = ${occurrence.recurrenceId}`;
    return respond(body.today, null);
  }

  return applyOrConflict('удалено вручную', [{ type: 'delete', taskId: body.taskId }], body.today);
}
