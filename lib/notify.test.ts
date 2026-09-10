import { describe, expect, it, test } from 'vitest';
import { eventFetchWindow, eventKey, normalizeTimezone, nowInZone, selectDue, selectDueEvents } from './notify';
import type { EventDay, Task } from './types';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Тренировка',
    date: '2026-08-09',
    startMinute: 14 * 60,
    durationMinutes: 90,
    allDay: false,
    categoryId: null,
    done: false,
    horizon: 'day',
    recurrenceId: null,
    recurrenceDate: null,
    ...overrides,
  };
}

const base = {
  today: '2026-08-09',
  beforeMinutes: 15,
  alreadySent: new Set<string>(),
};

function due(tasks: Task[], nowMinute: number, extra: Partial<typeof base> = {}) {
  return selectDue({ ...base, ...extra, tasks, nowMinute }).map((t) => t.id);
}

describe('проверка часового пояса', () => {
  it('пропускает настоящие пояса', () => {
    expect(normalizeTimezone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(normalizeTimezone('UTC')).toBe('UTC');
  });

  it('приводит к каноническому виду', () => {
    expect(normalizeTimezone('europe/amsterdam')).toBe('Europe/Amsterdam');
    expect(normalizeTimezone('GMT')).toBe('UTC');
  });

  it('отсекает мусор', () => {
    expect(normalizeTimezone('Europe/Атлантида')).toBeNull();
    expect(normalizeTimezone('')).toBeNull();
  });

  it('отсекает фиксированные смещения', () => {
    // Intl их принимает, но они не знают про летнее время: напоминания
    // уезжали бы на час дважды в год.
    expect(normalizeTimezone('+02:00')).toBeNull();
  });
});

describe('перевод текущего момента в часовой пояс', () => {
  it('ночью отдаёт уже следующую дату, хотя в UTC ещё вчера', () => {
    // 23:36 UTC — это 01:36 следующего дня в Амстердаме. Без перевода
    // планировщик считал бы, что идёт предыдущий день, и весь отбор поехал бы
    // на сутки.
    const at = new Date('2026-08-08T23:36:00Z');
    expect(nowInZone('Europe/Amsterdam', at)).toEqual({
      today: '2026-08-09',
      nowMinute: 96,
    });
    expect(nowInZone('UTC', at)).toEqual({
      today: '2026-08-08',
      nowMinute: 23 * 60 + 36,
    });
  });

  it('полночь даёт нулевую минуту, а не 1440', () => {
    expect(nowInZone('UTC', new Date('2026-08-09T00:00:00Z'))).toEqual({
      today: '2026-08-09',
      nowMinute: 0,
    });
  });

  it('учитывает летнее время', () => {
    // Зимой Амстердам +1, летом +2.
    const winter = new Date('2026-01-15T12:00:00Z');
    const summer = new Date('2026-07-15T12:00:00Z');
    expect(nowInZone('Europe/Amsterdam', winter).nowMinute).toBe(13 * 60);
    expect(nowInZone('Europe/Amsterdam', summer).nowMinute).toBe(14 * 60);
  });
});

describe('отбор задач для напоминания', () => {
  it('берёт задачу ровно за N минут до начала', () => {
    expect(due([task()], 14 * 60 - 15)).toEqual(['task-1']);
  });

  it('не берёт задачу, до которой ещё больше N минут', () => {
    expect(due([task()], 14 * 60 - 16)).toEqual([]);
  });

  it('не берёт задачу, которая уже началась', () => {
    expect(due([task()], 14 * 60)).toEqual([]);
    expect(due([task()], 14 * 60 + 1)).toEqual([]);
  });

  it('берёт задачу, если планировщик опоздал', () => {
    // Окно — «уже пора и ещё не началось», а не попадание в конкретную
    // минуту. Иначе задержка cron теряла бы напоминание насовсем.
    expect(due([task()], 14 * 60 - 3)).toEqual(['task-1']);
  });

  it('никогда не берёт задачи на весь день, выполненные и без времени', () => {
    const now = 14 * 60 - 15;
    expect(due([task({ allDay: true, startMinute: null })], now)).toEqual([]);
    expect(due([task({ done: true })], now)).toEqual([]);
    expect(due([task({ startMinute: null })], now)).toEqual([]);
  });

  it('не берёт задачу, о которой уже уведомляли', () => {
    const sent = new Set(['task-1']);
    expect(due([task()], 14 * 60 - 15, { alreadySent: sent })).toEqual([]);
  });

  it('берёт завтрашнюю задачу, если окно перешагивает полночь', () => {
    // 23:50 сегодня, задача завтра в 00:05, N = 15.
    const midnightish = task({ id: 'task-2', date: '2026-08-10', startMinute: 5 });
    expect(due([midnightish], 23 * 60 + 50)).toEqual(['task-2']);
  });

  it('не берёт вчерашние задачи и задачи дальше завтра', () => {
    const now = 14 * 60 - 15;
    expect(due([task({ date: '2026-08-08' })], now)).toEqual([]);
    expect(due([task({ date: '2026-08-11' })], now)).toEqual([]);
  });

  it('различает вхождения одной серии по дате', () => {
    // У раскрытых вхождений id уже содержит дату, поэтому отметка об одном
    // не глушит следующее.
    const rule = 'cccccccc-0000-4000-8000-000000000002';
    const today = task({ id: `occ:${rule}:2026-08-09` });
    const tomorrow = task({ id: `occ:${rule}:2026-08-10`, date: '2026-08-10' });
    const sent = new Set([`occ:${rule}:2026-08-09`]);
    // Девятого уже уведомляли — молчим.
    expect(due([today, tomorrow], 14 * 60 - 15, { alreadySent: sent })).toEqual([]);
    // Наступило десятое: вхождение той же серии уведомляется заново.
    expect(
      due([today, tomorrow], 14 * 60 - 15, { alreadySent: sent, today: '2026-08-10' }),
    ).toEqual([`occ:${rule}:2026-08-10`]);
  });

  it('учитывает настроенное число минут', () => {
    expect(due([task()], 14 * 60 - 30, { beforeMinutes: 30 })).toEqual(['task-1']);
    expect(due([task()], 14 * 60 - 30)).toEqual([]);
  });
});

function eventDay(patch: Partial<EventDay> = {}): EventDay {
  return {
    calendarId: 'primary', eventId: 'e1', title: 'ZZ-созвон', date: '2026-09-09',
    startMinute: 600, durationMinutes: 60, allDay: false, mine: true, ...patch,
  };
}

test('встреча попадает в отбор так же, как задача', () => {
  const due = selectDueEvents({
    events: [eventDay()], today: '2026-09-09', nowMinute: 590,
    beforeMinutes: 15, alreadySent: new Set(), userId: 'zz-owner',
  });
  expect(due).toHaveLength(1);
});

test('событие на весь день завтра не будит телефон в 23:50 сегодня', () => {
  // Прежний вариант теста (nowMinute: 0 в день самого события) не мог
  // покраснеть при удалении фильтра allDay: startsAt в той арифметике и
  // так получался 0, а условие «ещё не началось» само отсекало результат.
  // Настоящая опасность — не сегодня, а всё то же перешагивание полуночи,
  // что и у обычной встречи: null трактуется арифметикой как 0, поэтому
  // офсет «завтра» без фильтра даёт startsAt = 1440, и окно «за 15 минут»
  // ловит его в последние 15 минут сегодняшних суток — 23:45–23:59.
  const due = selectDueEvents({
    events: [eventDay({ allDay: true, startMinute: null, durationMinutes: null, date: '2026-09-10' })],
    today: '2026-09-09', nowMinute: 23 * 60 + 50, beforeMinutes: 15, alreadySent: new Set(), userId: 'zz-owner',
  });
  expect(due).toEqual([]);
});

test('ключ отправки различает календари', () => {
  expect(eventKey(eventDay(), 'zz-owner')).toBe('gcal:zz-owner:primary:e1');
  expect(eventKey(eventDay({ calendarId: 'work' }), 'zz-owner')).not.toBe(eventKey(eventDay(), 'zz-owner'));
});

test('ключ отправки различает владельцев — общий календарь не течёт между ними', () => {
  // Семейный или рабочий календарь виден нескольким людям под одним и тем же
  // calendarId/eventId. Без владельца в ключе тот, кто первым получил
  // напоминание, записал бы общий ключ в таблицу `sent», и второй владелец
  // того же события не получил бы напоминание никогда (находка I2
  // финального ревью).
  const event = eventDay();
  expect(eventKey(event, 'owner-a')).not.toBe(eventKey(event, 'owner-b'));
});

test('уже отправленное не повторяется', () => {
  const due = selectDueEvents({
    events: [eventDay()], today: '2026-09-09', nowMinute: 590,
    beforeMinutes: 15, alreadySent: new Set(['gcal:zz-owner:primary:e1']), userId: 'zz-owner',
  });
  expect(due).toEqual([]);
});

describe('окно выборки встреч для getEventsBetween', () => {
  it('запас несимметричен: к концу окна двое суток, а не одни', () => {
    // Раньше конец окна был короче ровно на эти сутки — вечерняя встреча
    // в поясах западнее Гринвича выпадала из выборки ещё до selectDueEvents.
    expect(eventFetchWindow('2026-09-09')).toEqual({
      to: '2026-09-10',
      fromIso: '2026-09-08T00:00:00.000Z',
      toIso: '2026-09-12T00:00:00.000Z',
    });
  });

  it('вечерняя встреча завтрашнего дня в America/New_York попадает в окно', () => {
    // 20:30 по Нью-Йорку 10 сентября 2026 (EDT, UTC-4) — это уже
    // 2026-09-11T00:30:00Z, то есть началом суток позже локальной даты.
    const { toIso } = eventFetchWindow('2026-09-09');
    const eveningTomorrowUtc = '2026-09-11T00:30:00.000Z';
    expect(eveningTomorrowUtc < toIso).toBe(true);
  });
});
