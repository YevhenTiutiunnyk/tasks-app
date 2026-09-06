import { NextResponse } from 'next/server';
import { addDays, isValidIsoDate, weekRange } from '@/lib/dates';
import { getChecklistTasks, getSettings, getUserKey, saveTimezone } from '@/lib/db';
import { normalizeTimezone } from '@/lib/notify';
import { badRequest, readJson } from '@/lib/http';
import { requireUser } from '@/lib/require-user';
import { loadRange, loadWeek } from '@/lib/week';
import { parseCommand } from '@/lib/parse';
import { anthropicFailure, clientForUser } from '@/lib/key-client';
import { validateParseResult } from '@/lib/validate';
import { applyOperations } from '@/lib/apply';

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
  const [scheduled, weekTasks, nextWeekTasks, monthTasks, settings, keyRow] = await Promise.all([
    loadRange(user.userId, contextFrom, contextTo),
    getChecklistTasks(user.userId, 'week', today),
    getChecklistTasks(user.userId, 'week', addDays(today, 7)),
    getChecklistTasks(user.userId, 'month', today),
    getSettings(user.userId),
    getUserKey(user.userId),
    saveZone,
  ]);
  const contextTasks = [...scheduled, ...weekTasks, ...nextWeekTasks, ...monthTasks];

  const key = clientForUser(user.userId, keyRow);
  if (key.response) return key.response;

  let parsed;
  try {
    parsed = await parseCommand(key.client, {
      text,
      today,
      timezone: timezone ?? 'UTC',
      tasks: contextTasks,
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

  return NextResponse.json({
    batchId,
    reply: parsed.reply,
    rejected: checked.rejected,
    needsTime,
    week,
  });
}
