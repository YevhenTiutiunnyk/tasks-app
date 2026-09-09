import type { CalendarEvent } from './types';

/** Тот кусок ресурса Event, который мы читаем. Остальные 30 полей не нужны. */
export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  transparency?: string;
  updated: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
}

function sameAddress(a: string | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Проверяет, содержит ли строка времени явный контекст: либо Z (UTC), либо смещение
 * вида +HH:MM или -HH:MM. Без них Date() разбирает по часовому поясу процесса,
 * что нарушает чистоту функции.
 */
function hasExplicitTimezone(dateTime: string): boolean {
  // Проверяем наличие Z в конце или смещения в виде ±HH:MM
  return /Z$/.test(dateTime) || /[+-]\d{2}:\d{2}$/.test(dateTime);
}

/**
 * Событие Google в нашу запись. null означает «в копии этого быть не должно».
 *
 * Три случая дают null, и все три обязаны удалять уже сохранённую строку,
 * а не просто пропускаться: человек мог отклонить приглашение, которое мы
 * вчера показывали, и оно должно исчезнуть с экрана.
 */
export function toCalendarEvent(
  raw: GoogleEvent,
  calendarId: string,
  ownerEmail: string,
): CalendarEvent | null {
  if (raw.status === 'cancelled') return null;

  const self = raw.attendees?.find(
    (attendee) => attendee.self === true || sameAddress(attendee.email, ownerEmail),
  );
  if (self?.responseStatus === 'declined') return null;

  // «Показывать меня как: Свободен». Дни рождения и праздники приходят
  // именно так, и считать их занятостью значит запретить модели весь день.
  if (raw.transparency === 'transparent') return null;

  const allDay = typeof raw.start?.date === 'string';

  // Событие без начала или конца не может быть корректно отображено.
  // Попытка использовать undefined приведёт к TypeError.
  if (!raw.start || !raw.end) return null;

  // Событие без явного контекста времени (Z или смещение) разбирается
  // по часовому поясу процесса, нарушая чистоту функции. Такое событие
  // неопределённо и должно быть отброшено.
  if (!allDay && (!hasExplicitTimezone(raw.start.dateTime ?? '') || !hasExplicitTimezone(raw.end.dateTime ?? ''))) {
    return null;
  }

  // Событие на весь день — это диапазон ДАТ, а не мгновений: у отпуска нет
  // часа начала. Держим его как полночь UTC и никогда не переводим в пояс,
  // иначе переезд человека сдвигал бы отпуск на день.
  const startsAt = allDay
    ? `${raw.start!.date}T00:00:00.000Z`
    : new Date(raw.start!.dateTime!).toISOString();
  const endsAt = allDay
    ? `${raw.end!.date}T00:00:00.000Z`
    : new Date(raw.end!.dateTime!).toISOString();

  const organizerEmail = raw.organizer?.email ?? null;

  return {
    calendarId,
    eventId: raw.id,
    title: raw.summary ?? '(без названия)',
    startsAt,
    endsAt,
    allDay,
    // Организатора нет у событий, заведённых в собственном календаре.
    mine: organizerEmail === null || sameAddress(organizerEmail, ownerEmail),
    organizerEmail,
    googleUpdatedAt: new Date(raw.updated).toISOString(),
  };
}
