import { describe, it, expect } from 'vitest';
import { clockToMinutes, formatDayLabel, minutesToClock } from './format';

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
