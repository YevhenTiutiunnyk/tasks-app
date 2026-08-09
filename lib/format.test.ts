import { describe, it, expect } from 'vitest';
import {
  clockToMinutes,
  formatDayLabel,
  formatDuration,
  formatTimeRange,
  formatWeekRange,
  minutesToClock,
} from './format';

describe('formatWeekRange', () => {
  it('внутри одного месяца называет месяц один раз', () => {
    expect(formatWeekRange('2026-08-03', '2026-08-09')).toBe('3–9 августа');
  });

  it('на стыке месяцев называет оба', () => {
    expect(formatWeekRange('2026-07-30', '2026-08-05')).toBe('30 июля – 5 августа');
  });

  it('на стыке годов добавляет годы', () => {
    // Иначе «28 декабря – 3 января» не говорит, какой это год из двух.
    expect(formatWeekRange('2026-12-28', '2027-01-03')).toBe(
      '28 декабря 2026 – 3 января 2027',
    );
  });
});

describe('minutesToClock', () => {
  it('добивает нулями', () => expect(minutesToClock(540)).toBe('09:00'));
  it('полночь', () => expect(minutesToClock(0)).toBe('00:00'));
  it('последняя минута суток', () => expect(minutesToClock(1439)).toBe('23:59'));
});

describe('clockToMinutes', () => {
  it('разбирает с ведущим нулём', () => expect(clockToMinutes('09:30')).toBe(570));
  it('разбирает без ведущего нуля', () => expect(clockToMinutes('9:30')).toBe(570));
  it('отвергает 25:00', () => expect(clockToMinutes('25:00')).toBeNull());
  it('отвергает 09:70', () => expect(clockToMinutes('09:70')).toBeNull());
  it('отвергает мусор', () => expect(clockToMinutes('утром')).toBeNull());
});

describe('formatDayLabel', () => {
  it('собирает подпись дня', () => expect(formatDayLabel('2026-08-04', 2)).toBe('вт 4 авг'));
});

describe('formatTimeRange', () => {
  it('показывает начало и конец', () => expect(formatTimeRange(840, 435)).toBe('14:00–21:15'));
  it('часовая задача', () => expect(formatTimeRange(600, 60)).toBe('10:00–11:00'));
  it('переход через полночь показывает время следующих суток', () =>
    expect(formatTimeRange(1410, 60)).toBe('23:30–00:30'));
  it('конец ровно в полночь', () => expect(formatTimeRange(1380, 60)).toBe('23:00–00:00'));
  it('без длительности показывает только начало', () =>
    expect(formatTimeRange(840, null)).toBe('14:00'));
  it('нулевая длительность показывает только начало', () =>
    expect(formatTimeRange(840, 0)).toBe('14:00'));
});

describe('formatDuration', () => {
  it('часы и минуты', () => expect(formatDuration(435)).toBe('7 ч 15 мин'));
  it('целые часы без минут', () => expect(formatDuration(120)).toBe('2 ч'));
  it('ровно час', () => expect(formatDuration(60)).toBe('1 ч'));
  it('меньше часа — только минуты', () => expect(formatDuration(45)).toBe('45 мин'));
  it('ноль', () => expect(formatDuration(0)).toBe('0 мин'));
  it('сутки с лишним не сворачиваются в дни', () => expect(formatDuration(1500)).toBe('25 ч'));
  it('мусор не притворяется длительностью', () => expect(formatDuration(NaN)).toBe(''));
  it('отрицательное не притворяется длительностью', () => expect(formatDuration(-30)).toBe(''));
});
