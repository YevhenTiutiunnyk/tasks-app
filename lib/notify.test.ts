import { describe, expect, it } from 'vitest';
import { normalizeTimezone, nowInZone, selectDue } from './notify';
import type { Task } from './types';

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
