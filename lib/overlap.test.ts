import { expect, test } from 'vitest';
import { findOverlaps } from './overlap';
import type { EventDay, Task } from './types';

function task(patch: Partial<Task> = {}): Task {
  return {
    id: 't1', title: 'ZZ-тренировка', date: '2026-09-09', startMinute: 600,
    durationMinutes: 60, allDay: false, categoryId: null, done: false,
    horizon: 'day', recurrenceId: null, recurrenceDate: null, ...patch,
  };
}

function event(patch: Partial<EventDay> = {}): EventDay {
  return {
    calendarId: 'primary', eventId: 'e1', title: 'ZZ-созвон', date: '2026-09-09',
    startMinute: 630, durationMinutes: 60, allDay: false, mine: true, ...patch,
  };
}

test('пересечение по времени находится', () => {
  expect(findOverlaps([task()], [event()])).toEqual([
    { taskTitle: 'ZZ-тренировка', eventTitle: 'ZZ-созвон' },
  ]);
});

test('соприкосновение впритык наложением не считается', () => {
  expect(findOverlaps([task()], [event({ startMinute: 660 })])).toEqual([]);
});

test('разные дни не пересекаются', () => {
  expect(findOverlaps([task()], [event({ date: '2026-09-10' })])).toEqual([]);
});

test('дела на весь день никого не блокируют', () => {
  const allDayTask = task({ allDay: true, startMinute: null, durationMinutes: null });
  expect(findOverlaps([allDayTask], [event()])).toEqual([]);
  expect(findOverlaps([task()], [event({ allDay: true, startMinute: null, durationMinutes: null })])).toEqual([]);
});
