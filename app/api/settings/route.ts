import { NextResponse } from 'next/server';
import { getSettings, saveSettings } from '@/lib/db';
import { badRequest, readJson } from '@/lib/http';
import type { Settings } from '@/lib/types';

// «Про меня» уходит в системный промпт с каждой фразой, а категории
// перечисляются там же. Без верхней границы это неограниченный счёт за API
// и растущее время ответа на ровном месте.
const MAX_ABOUT_ME = 2000;
const MAX_CATEGORIES = 30;

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function PUT(request: Request) {
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

  await saveSettings({
    workStartMinute: body.workStartMinute,
    workEndMinute: body.workEndMinute,
    aboutMe,
    categories: body.categories,
  });
  return NextResponse.json({ ok: true });
}
