import { NextResponse } from 'next/server';
import {
  disconnectCalendars, getCalendars, markCalendarsBroken, markCalendarsHealthy,
  setSelectedCalendars, upsertCalendars,
} from '@/lib/db';
import { CalendarAccessLost } from '@/lib/google-api';
import { getCalendarClient } from '@/lib/google-token';
import { readJson } from '@/lib/http';
import { requireUser } from '@/lib/require-user';

/**
 * Список календарей человека. Обновляем названия у Google при каждом
 * открытии настроек: календарь могли переименовать, а галочки при этом
 * обязаны уцелеть — за это отвечает upsertCalendars.
 *
 * Заодно это единственное место, где сломанная связь оживает. Планировщик
 * сломанные календари больше не трогает (см. syncUser), а «Подключить
 * заново» в настройках зовёт согласие Google и возвращает сюда же — то есть
 * ровно к этому GET. Поэтому удачный поход в Google здесь — честный
 * человеческий сигнал «связь снова жива», а неудачный — что она мертва
 * прямо сейчас, а не когда-то в прошлом (находка C1 финального ревью).
 */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  try {
    const client = await getCalendarClient(user.userId);
    await upsertCalendars(user.userId, await client.listCalendars());
    await markCalendarsHealthy(user.userId);
  } catch (error) {
    // Помечаем сломанным ТОЛЬКО определённую потерю доступа. Любая другая
    // причина — 500 у Google, обрыв сети, сбой upsertCalendars — не значит
    // «доступа нет», а сломанный календарь пропускают и планировщик,
    // и обновление при открытии: ложная пометка тихо выключила бы его на
    // дни, до ручного похода в настройки (находка второго круга финального
    // ревью). Прочие ошибки экрана не касаются — покажем то, что уже
    // сохранено.
    if (error instanceof CalendarAccessLost) await markCalendarsBroken(user.userId);
  }

  const calendars = await getCalendars(user.userId);
  return NextResponse.json({
    connected: calendars.length > 0,
    broken: calendars.some((calendar) => calendar.brokenAt !== null),
    calendars: calendars.map(({ calendarId, summary, selected }) => ({ calendarId, summary, selected })),
  });
}

export async function PUT(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const body = await readJson<{ calendarIds?: unknown }>(request);
  if (!Array.isArray(body?.calendarIds) || body.calendarIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({ error: 'Нужен список календарей' }, { status: 400 });
  }
  await setSelectedCalendars(user.userId, body.calendarIds);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  await disconnectCalendars(user.userId);
  return NextResponse.json({ ok: true });
}
