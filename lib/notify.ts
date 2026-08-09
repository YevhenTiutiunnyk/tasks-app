import { addDays } from './dates';
import type { Task } from './types';

const MINUTES_PER_DAY = 1440;

/**
 * Приводит имя часового пояса к каноническому виду. null — значение не годится.
 *
 * Пояс приходит от браузера, а нужен планировщику. Мусор в базе уронил бы
 * отправку целиком и навсегда: nowInZone бросает исключение, и чинить это
 * пришлось бы руками в базе.
 *
 * Фиксированные смещения вроде '+02:00' Intl принимает, но мы их отвергаем:
 * они не знают про летнее время, и напоминания дважды в год уезжали бы на час.
 * Оставить прежний пояс в такой ситуации безопаснее, чем принять этот.
 */
export function normalizeTimezone(value: string): string | null {
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-CA', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }

  // UTC каноничен, но в списке зон его нет — это не географическая зона.
  if (canonical === 'UTC') return canonical;
  return Intl.supportedValuesOf('timeZone').includes(canonical) ? canonical : null;
}

/**
 * Текущие дата и время в часовом поясе пользователя.
 *
 * Планировщик живёт в UTC, а расписание хранится как локальные дата и минуты
 * без пояса. Без этого перевода напоминания уезжали бы на разницу поясов —
 * и ночью ещё и на сутки: в 01:36 по Амстердаму в UTC идёт предыдущий день.
 */
export function nowInZone(
  timezone: string,
  at: Date = new Date(),
): { today: string; nowMinute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;

  // hourCycle h23 местами отдаёт «24» для полуночи.
  const hour = Number(value('hour')) % 24;

  return {
    today: `${value('year')}-${value('month')}-${value('day')}`,
    nowMinute: hour * 60 + Number(value('minute')),
  };
}

export interface SelectDueInput {
  /** Задачи на сегодня и завтра — обычно результат loadRange. */
  tasks: Task[];
  /** Текущая дата в часовом поясе пользователя, 'YYYY-MM-DD'. */
  today: string;
  /** Текущее время в том же поясе, минуты от полуночи. */
  nowMinute: number;
  /** За сколько минут до начала предупреждать. */
  beforeMinutes: number;
  /** Ключи задач, о которых уже уведомляли. Ключ — это task.id. */
  alreadySent: ReadonlySet<string>;
}

/**
 * Сколько суток от сегодня до даты задачи: 0 — сегодня, 1 — завтра,
 * null — всё остальное.
 *
 * Дальше завтра заглядывать незачем: окно уведомления никогда не длиннее
 * суток, а эндпоинт и грузит ровно эти два дня.
 */
function dayOffset(today: string, date: string): number | null {
  if (date === today) return 0;
  if (date === addDays(today, 1)) return 1;
  return null;
}

/**
 * Задачи, о которых пора уведомить прямо сейчас.
 *
 * Условие — «уже пора и ещё не началось», а не попадание в конкретную минуту.
 * Если планировщик опоздает, напоминание придёт с задержкой, а не потеряется
 * насовсем. От повторов защищает alreadySent, а не точность попадания.
 */
export function selectDue(input: SelectDueInput): Task[] {
  const { tasks, today, nowMinute, beforeMinutes, alreadySent } = input;

  return tasks.filter((task) => {
    if (task.allDay || task.done || task.startMinute === null) return false;
    if (alreadySent.has(task.id)) return false;

    const offset = dayOffset(today, task.date);
    if (offset === null) return false;

    const startsAt = offset * MINUTES_PER_DAY + task.startMinute;
    return nowMinute >= startsAt - beforeMinutes && nowMinute < startsAt;
  });
}
