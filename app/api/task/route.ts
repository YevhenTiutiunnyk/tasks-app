import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { sql } from '@/lib/db';
import { applyOperations } from '@/lib/apply';
import { badRequest, readJson } from '@/lib/http';
import type { Horizon } from '@/lib/horizons';
import { requireUser } from '@/lib/require-user';
import { isValidSlot, isValidTaskId } from '@/lib/validate';
import { loadWeek } from '@/lib/week';
import { parseOccurrenceId } from '@/lib/recurrence';
import type { Operation } from '@/lib/types';

async function respond(userId: string, today: string, batchId: string | null) {
  return NextResponse.json({ batchId, week: await loadWeek(userId, today) });
}

/**
 * applyOperations бросает, если задачи уже нет — например при двойном клике
 * по «удалить» или на устаревшей вкладке. Это не сбой сервера, а гонка,
 * поэтому отвечаем 409, а не 500.
 */
async function applyOrConflict(
  userId: string,
  text: string,
  operations: Operation[],
  today: string,
) {
  try {
    const { batchId } = await applyOperations(userId, text, operations);
    return respond(userId, today, batchId);
  } catch (error) {
    console.error('applyOperations failed', error);
    return NextResponse.json({ error: 'Задача изменилась или уже удалена' }, { status: 409 });
  }
}

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

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
  // Горизонт эта ручная форма не знает: она заводит обычную дневную задачу
  // на выбранный день. null здесь — то же самое «период не назван», что и
  // у модели, apply.ts трактует его как 'day'.
  const operation: Operation = {
    type: 'create', title: body.title, date: body.date, startMinute: body.startMinute,
    durationMinutes: body.durationMinutes, allDay: body.allDay,
    categoryId: body.categoryId, recurrence: null, horizon: null,
  };
  return applyOrConflict(user.userId, 'создано вручную', [operation], body.today);
}

export async function PATCH(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

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
    // Чужая задача не находится и ответ тот же, что на уже удалённую: 200
    // с текущей неделей. Отдельного «не твоё» нет намеренно — по нему
    // перебором вычислялось бы, какие задачи есть у других.
    await sql`
      update tasks set done = ${body.done}, updated_at = now()
      where id = ${body.taskId} and user_id = ${user.userId}
    `;
    return respond(user.userId, body.today, null);
  }

  // Название проверяем до ветки серии: иначе title "   " записался бы прямо
  // в правило повтора. Карточка так не пошлёт, но ручной ввод здесь не
  // доверенней вывода модели.
  // При replace название обязательно: там null и пропуск значат «очистить»,
  // то есть затёрли бы его в базе. Без replace оно необязательно, но если
  // прислано — должно быть годным: apply применяет любую непустую по типу
  // строку, включая пробельную. Отметка «выполнено» тела с title не шлёт
  // и разобрана выше, до сюда не доходит.
  const replace = body.replace === true;
  if ((replace || body.title !== undefined)
      && (typeof body.title !== 'string' || !body.title.trim())) {
    return badRequest('Пустое название');
  }

  // Правка всей серии меняет само правило. Ветка работает по частичной
  // семантике независимо от флага replace: у правила повтора нет колонки
  // date, поэтому полная замена здесь неприменима — названные поля меняются,
  // остальные остаются как были.
  const occurrence = parseOccurrenceId(body.taskId);
  if (body.scope === 'series' && occurrence) {
    const patch: Record<string, unknown> = {};
    if (body.title != null) patch.title = body.title;
    if (body.startMinute != null) patch.start_minute = body.startMinute;
    if (body.durationMinutes != null) patch.duration_minutes = body.durationMinutes;
    if (body.allDay != null) patch.all_day = body.allDay;
    if (body.categoryId !== undefined) patch.category_id = body.categoryId;
    if (Object.keys(patch).length > 0) {
      await sql`
        update recurrences set ${sql(patch)}
        where id = ${occurrence.recurrenceId} and user_id = ${user.userId}
      `;
    }
    return respond(user.userId, body.today, null);
  }

  // Карточка задачи присылает все поля разом и просит полную замену
  // (replace: true). Перетаскивание знает только дату и время и флаг не
  // ставит, поэтому его сюда не пускаем.
  // При replace null значит «очистить», а не «поле не названо».
  //
  // Горизонт карточка не знает вовсе. Для перетаскивания (replace не стоит)
  // null безопасен — apply.ts частичной правки его просто не тронет, как
  // любое другое неназванное поле. Но при replace apply.ts трактует null
  // как «день» — подставь его в лоб, и любая правка из карточки увела бы
  // недельную или месячную задачу в дневные. Поэтому при replace читаем
  // нынешний горизонт из базы и передаём его же: полная замена это поле
  // не меняет. occ:-идентификатор в tasks не найдётся (это ещё не строка,
  // а ссылка на вхождение серии) — но у вхождений горизонта не бывает,
  // null для них и означает верное 'day'.
  let horizon: Horizon | null = null;
  if (replace && !occurrence) {
    const [current] = await sql`
      select horizon from tasks where id = ${body.taskId} and user_id = ${user.userId}
    `;
    horizon = (current?.horizon as Horizon | undefined) ?? null;
  }
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
    horizon,
  };
  return applyOrConflict(user.userId, 'изменено вручную', [operation], body.today);
}

export async function DELETE(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

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
    // Без владельца это была бы худшая дыра из всех: удаление правила уносит
    // каскадом и все материализованные по нему задачи чужого человека.
    await sql`
      delete from recurrences
      where id = ${occurrence.recurrenceId} and user_id = ${user.userId}
    `;
    return respond(user.userId, body.today, null);
  }

  return applyOrConflict(
    user.userId, 'удалено вручную', [{ type: 'delete', taskId: body.taskId }], body.today,
  );
}
