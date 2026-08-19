import { NextResponse } from 'next/server';
import { getSettings, saveSettings } from '@/lib/db';
import { badRequest, readJson } from '@/lib/http';
import { requireUser } from '@/lib/require-user';
import type { Settings } from '@/lib/types';

// «Про меня» уходит в системный промпт с каждой фразой, а категории
// перечисляются там же. Без верхней границы это неограниченный счёт за API
// и растущее время ответа на ровном месте.
const MAX_ABOUT_ME = 2000;
const MAX_CATEGORIES = 30;

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  return NextResponse.json(await getSettings(user.userId));
}

export async function PUT(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const body = await readJson<Settings>(request);
  if (!body) return badRequest('Не удалось разобрать тело запроса');

  const inRange = (m: number) => Number.isInteger(m) && m >= 0 && m <= 1439;
  if (!inRange(body.workStartMinute) || !inRange(body.workEndMinute)) {
    return NextResponse.json({ error: 'Некорректные рабочие часы' }, { status: 400 });
  }
  if (body.workStartMinute >= body.workEndMinute) {
    return NextResponse.json({ error: 'Начало рабочего дня позже конца' }, { status: 400 });
  }
  if (!Array.isArray(body.categories) || body.categories.some((c) => !c.id || !c.name || !c.color)) {
    return NextResponse.json({ error: 'Некорректные категории' }, { status: 400 });
  }
  if (body.categories.length > MAX_CATEGORIES) {
    return badRequest(`Категорий не больше ${MAX_CATEGORIES}`);
  }

  const aboutMe = String(body.aboutMe ?? '');
  if (aboutMe.length > MAX_ABOUT_ME) {
    return badRequest(`«Про меня» — не длиннее ${MAX_ABOUT_ME} символов`);
  }

  // Верхняя граница — сутки: напоминание за большее время до начала попало бы
  // в предыдущий день, а эндпоинт отправки смотрит только сегодня и завтра.
  const before = body.notifyBeforeMinutes;
  if (!Number.isInteger(before) || before < 0 || before > 1439) {
    return badRequest('Напоминать можно от 0 до 1439 минут до начала');
  }

  await saveSettings(user.userId, {
    workStartMinute: body.workStartMinute,
    workEndMinute: body.workEndMinute,
    aboutMe,
    categories: body.categories,
    notifyBeforeMinutes: before,
  });
  return NextResponse.json({ ok: true });
}
