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

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) days.push(cursor);
  return days;
}
