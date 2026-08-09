const WEEKDAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAY_FULL = [
  'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье',
];

export function minutesToClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** '9:30' или '09:30' → 570. Возвращает null на мусоре. */
export function clockToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * '14:00–21:15' — начало и конец задачи. Одного начала мало: по «14:00»
 * не видно, что работа тянется до девяти вечера, а на телефоне сетки нет
 * вовсе и время — единственный ориентир.
 *
 * Конец после полуночи показывается временем следующих суток: задача
 * с 23:30 на час — это '23:30–00:30', а не '23:30–24:30'.
 */
export function formatTimeRange(startMinute: number, durationMinutes: number | null): string {
  const start = minutesToClock(startMinute);
  if (durationMinutes === null || durationMinutes <= 0) return start;
  return `${start}–${minutesToClock((startMinute + durationMinutes) % 1440)}`;
}

/**
 * 435 → '7 ч 15 мин'. Сырые минуты нечитаемы: по «435» не понять,
 * семь это часов или четыре.
 *
 * В сутки не сворачивается: '25 ч' понятнее, чем '1 д 1 ч', для задачи,
 * которая идёт день с небольшим. Мусор даёт пустую строку, чтобы вызывающий
 * не показывал 'NaN ч'.
 */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${rest} мин`;
  if (rest === 0) return `${hours} ч`;
  return `${hours} ч ${rest} мин`;
}

const MONTH_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function dayOf(iso: string): number {
  return Number(iso.slice(8, 10));
}

function monthOf(iso: string): string {
  return MONTH_GENITIVE[Number(iso.slice(5, 7)) - 1];
}

/**
 * '3–9 августа' — заголовок недели.
 *
 * Раньше в шапке стояло '2026-08-03 — 2026-08-09': на телефоне эта строка
 * переносилась на две и налезала на стрелки, а читалась как машинный вывод.
 *
 * Месяц называется дважды только на стыке месяцев, год — только на стыке
 * годов: иначе «28 декабря – 3 января» не говорит, какой это год из двух.
 */
export function formatWeekRange(from: string, to: string): string {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const sameMonth = sameYear && from.slice(5, 7) === to.slice(5, 7);

  if (sameMonth) return `${dayOf(from)}–${dayOf(to)} ${monthOf(to)}`;
  if (sameYear) return `${dayOf(from)} ${monthOf(from)} – ${dayOf(to)} ${monthOf(to)}`;
  return (
    `${dayOf(from)} ${monthOf(from)} ${from.slice(0, 4)} – ` +
    `${dayOf(to)} ${monthOf(to)} ${to.slice(0, 4)}`
  );
}

/**
 * '2026-08-04' → 'Вт 4'. Для строки, в которую сворачиваются пустые дни:
 * месяц там уже назван в заголовке недели, повторять его незачем.
 */
export function formatDayShort(iso: string, weekday: number): string {
  const short = WEEKDAY_SHORT[weekday - 1];
  return `${short[0].toUpperCase()}${short.slice(1)} ${dayOf(iso)}`;
}

/** '2026-08-04' → 'вт 4 авг' */
export function formatDayLabel(iso: string, weekday: number): string {
  return `${WEEKDAY_SHORT[weekday - 1]} ${Number(iso.slice(8, 10))} ${MONTH_SHORT[Number(iso.slice(5, 7)) - 1]}`;
}

/** '2026-08-04' → 'Вторник, 4 августа' — для ленты на телефоне */
export function formatDayHeading(iso: string, weekday: number): string {
  return `${WEEKDAY_FULL[weekday - 1]}, ${Number(iso.slice(8, 10))} ${MONTH_SHORT[Number(iso.slice(5, 7)) - 1]}`;
}
