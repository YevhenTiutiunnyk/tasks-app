import { NextResponse } from 'next/server';
import { addDays, isValidIsoDate, weekRange } from '@/lib/dates';
import { getChecklistTasks, getEventsBetween, getSettings, getTimezone, getUserKey, saveTimezone } from '@/lib/db';
import { splitIntoDays } from '@/lib/calendar';
import { normalizeTimezone } from '@/lib/notify';
import { badRequest, readJson } from '@/lib/http';
import { requireUser } from '@/lib/require-user';
import { loadRange, loadWeek } from '@/lib/week';
import { parseCommand } from '@/lib/parse';
import { anthropicFailure, clientForUser } from '@/lib/key-client';
import { validateParseResult } from '@/lib/validate';
import { applyOperations } from '@/lib/apply';
import { findOverlaps } from '@/lib/overlap';

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const body = await readJson<{ text?: string; today?: string; timezone?: string }>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');
  const { text, today, timezone } = body;

  if (!text?.trim()) return badRequest('Пустая фраза');
  if (!today || !isValidIsoDate(today)) return badRequest('Некорректная дата');

  // Контекст для модели — текущая неделя и обе соседние.
  const { from, to } = weekRange(today);
  const contextFrom = addDays(from, -7);
  const contextTo = addDays(to, 7);

  // Пояс приходит от устройства и сохраняется здесь, а не на загрузке
  // расписания: команды отдаются с телефона, и телефон — источник правды
  // о том, где пользователь находится. Открытие расписания с ноутбука или
  // через VPN пояс не сдвинет. Планировщику уведомлений он нужен из базы:
  // браузера у него нет.
  const zone = timezone ? normalizeTimezone(timezone) : null;
  const saveZone = zone ? saveTimezone(user.userId, zone) : Promise.resolve();

  // Ключ достаём в той же Promise.all — лишнего обращения к базе не появляется.
  //
  // Модель должна видеть и то, что в сетке, и то, что в чеклистах: иначе
  // «убери кран» не с чем сопоставить — недельные задачи из loadRange
  // намеренно исключены, они не в расписании. Источников стало четыре
  // (Задача 7): чеклист на экране теперь показывает и следующую неделю,
  // а не только текущую, и без своего запроса модель не видела бы её
  // задачи вовсе — команда про них отвергалась бы проверкой идентификаторов.
  // Список идёт и в промпт, и в проверку идентификаторов ответа, поэтому
  // собирается один раз.
  // Пояс для раскладки встреч по дням берём из базы (сохранённый), а не из
  // тела запроса: событие «весь день» и разрезка по полуночи должны совпадать
  // с тем, что человек видит на экране расписания (lib/week.ts), а не гулять
  // от случая к случаю, если устройство не прислало зону в этот раз.
  const [scheduled, weekTasks, nextWeekTasks, monthTasks, settings, keyRow, storedTimezone, rawEvents] =
    await Promise.all([
      loadRange(user.userId, contextFrom, contextTo),
      getChecklistTasks(user.userId, 'week', today),
      getChecklistTasks(user.userId, 'week', addDays(today, 7)),
      getChecklistTasks(user.userId, 'month', today),
      getSettings(user.userId),
      getUserKey(user.userId),
      getTimezone(user.userId),
      // Сутки с запасом с каждой стороны, как в loadWeek: встреча, начавшаяся
      // в 23:30 по местному времени крайнего дня контекста, в UTC уже
      // на соседних сутках и без запаса не попала бы в выборку.
      getEventsBetween(
        user.userId,
        `${addDays(contextFrom, -1)}T00:00:00.000Z`,
        `${addDays(contextTo, 2)}T00:00:00.000Z`,
      ),
      saveZone,
    ]);
  const contextTasks = [...scheduled, ...weekTasks, ...nextWeekTasks, ...monthTasks];
  const events = splitIntoDays(rawEvents, storedTimezone, contextFrom, contextTo);

  const key = clientForUser(user.userId, keyRow);
  if (key.response) return key.response;

  let parsed;
  try {
    parsed = await parseCommand(key.client, {
      text,
      today,
      timezone: timezone ?? 'UTC',
      tasks: contextTasks,
      events,
      settings,
    });
  } catch (error) {
    console.error('parseCommand failed', error);
    return anthropicFailure(error);
  }

  const checked = validateParseResult(parsed, { tasks: contextTasks, categories: settings.categories });

  if (checked.operations.length === 0) {
    return NextResponse.json({
      batchId: null,
      reply: parsed.reply,
      rejected: checked.rejected,
      needsTime: [],
      overlaps: [],
      week: await loadWeek(user.userId, today),
    });
  }

  let batchId: string;
  try {
    ({ batchId } = await applyOperations(user.userId, text, checked.operations));
  } catch (error) {
    console.error('applyOperations failed', error);
    return NextResponse.json({ error: 'Не получилось сохранить изменения' }, { status: 500 });
  }

  const week = await loadWeek(user.userId, today);

  // Сопоставляем вопросы про время с уже созданными задачами. Ищем по всему
  // трёхнедельному диапазону, а не по одной видимой неделе: контекст модели
  // шире экрана, и «запиши врача на следующий понедельник» создаёт задачу
  // за её пределами — иначе вопрос про время молча потерялся бы.
  const applied = await loadRange(user.userId, contextFrom, contextTo);
  const needsTime = checked.needsTime.flatMap((entry) => {
    const operation = checked.operations[entry.operationIndex];
    if (operation.type !== 'create') return [];
    const task = applied.find(
      (t) => t.title === operation.title && t.date === operation.date && t.allDay,
    );
    return task ? [{ taskId: task.id, title: task.title, question: entry.question }] : [];
  });

  // Наложение считаем ПОСЛЕ применения, не до: приложение не спрашивает
  // разрешения, оно применяет и даёт откатить. По тому же трёхнедельному
  // диапазону, что и applied выше, — иначе задача, переехавшая за пределы
  // видимой недели, тихо потеряла бы своё предупреждение.
  const overlaps = findOverlaps(applied, events);

  return NextResponse.json({
    batchId,
    reply: parsed.reply,
    rejected: checked.rejected,
    needsTime,
    overlaps,
    week,
  });
}
