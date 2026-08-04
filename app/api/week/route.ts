import { NextResponse } from 'next/server';
import { isValidIsoDate } from '@/lib/dates';
import { loadWeek } from '@/lib/week';

export async function GET(request: Request) {
  const date = new URL(request.url).searchParams.get('date');
  if (!date || !isValidIsoDate(date)) {
    return NextResponse.json({ error: 'Нужен параметр date вида YYYY-MM-DD' }, { status: 400 });
  }
  return NextResponse.json(await loadWeek(date));
}
