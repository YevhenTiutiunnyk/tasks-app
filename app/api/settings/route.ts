import { NextResponse } from 'next/server';
import { getSettings, saveSettings } from '@/lib/db';
import type { Settings } from '@/lib/types';

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function PUT(request: Request) {
  const body = (await request.json()) as Settings;

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

  await saveSettings({
    workStartMinute: body.workStartMinute,
    workEndMinute: body.workEndMinute,
    aboutMe: String(body.aboutMe ?? ''),
    categories: body.categories,
  });
  return NextResponse.json({ ok: true });
}
