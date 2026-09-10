const DAY_MS = 86_400_000;

function parse(iso: string): number {
  return Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
}

function format(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Отсекает несуществующие даты вроде 2026-02-31: Date.UTC их нормализует,
  // и обратное форматирование даёт другую строку.
  return format(parse(value)) === value;
}

export function addDays(iso: string, days: number): string {
  return format(parse(iso) + days * DAY_MS);
}

/** 1 — понедельник, 7 — воскресенье. */
export function weekdayOf(iso: string): number {
  return ((new Date(parse(iso)).getUTCDay() + 6) % 7) + 1;
}

export function startOfWeek(iso: string): string {
  return addDays(iso, -(weekdayOf(iso) - 1));
}

export function startOfMonth(iso: string): string {
  // Срезом, а не арифметикой в миллисекундах: строка уже в нужном виде,
  // а любое вычитание дней здесь потребовало бы знать длину месяца.
  return `${iso.slice(0, 7)}-01`;
}

export function weekRange(iso: string): { from: string; to: string } {
  const from = startOfWeek(iso);
  return { from, to: addDays(from, 6) };
}

/**
 * Неделя целиком лежит вне окна копии календаря — то есть в ней точно
 * нет ни одной хранимой встречи, а не «встреч не нашлось».
 *
 * Спека прямо требует отличать это от пустой недели на экране (см. раздел
 * «Известные ограничения» дизайна): человек, перелиставший на четвёртый
 * месяц вперёд, иначе не отличил бы «дальше копия не заходит» от «правда
 * нет встреч» (находка I5 финального ревью). window === null — календарь
 * не подключён вовсе либо ещё не прошёл первую синхронизацию: в обоих
 * случаях предупреждать не о чем.
 */
export function isWeekOutsideCalendarWindow(
  weekFrom: string,
  weekTo: string,
  window: { start: string; end: string } | null,
): boolean {
  if (!window) return false;
  return weekTo < window.start || weekFrom > window.end;
}

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) days.push(cursor);
  return days;
}

/**
 * Сегодняшняя дата по часам устройства.
 *
 * Намеренно локальная, а не UTC: человек имеет в виду свой день, а не день
 * по Гринвичу. Единственное место во всём модуле, которое смотрит на часы,
 * — остальное чистая арифметика строк.
 */
export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
