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

// Обе фикстуры ниже подобраны так, чтобы удаление guard'а на allDay/null
// у соответствующей стороны действительно давало ложное наложение — не как
// в первой версии, где null в арифметике JS давал 60, случайно не задевавшее
// фикстуры 600/630, и guard можно было снять, а тест оставался зелёным.
// Здесь снятый guard превращает startMinute=null в 0, а окно дела на весь
// день молча схлопывается в [0, 60) — и фикстуры нарочно попадают в это окно.

test('дело на весь день не блокирует: guard на allDay-задаче обязателен', () => {
  // Без guard'а startMinute (null) станет 0, durationMinutes (null) — 60
  // через `?? 60», то есть виртуальное окно задачи — [0, 60). Событие
  // [30, 50) лежит внутри этого окна и даст ложное наложение, если guard снят.
  const allDayTask = task({ allDay: true, startMinute: null, durationMinutes: null });
  const eventInsideCollapsedWindow = event({ startMinute: 30, durationMinutes: 20 });
  expect(findOverlaps([allDayTask], [eventInsideCollapsedWindow])).toEqual([]);
});

test('встреча на весь день не блокирует: guard на allDay-встрече обязателен', () => {
  // Зеркально: у встречи startMinute/durationMinutes равны null, без guard'а
  // её окно тоже схлопывается в [0, 60). Задача [30, 50) внутри — ложное
  // наложение, если guard на событии снят.
  const taskInsideCollapsedWindow = task({ startMinute: 30, durationMinutes: 20 });
  const allDayEvent = event({ allDay: true, startMinute: null, durationMinutes: null });
  expect(findOverlaps([taskInsideCollapsedWindow], [allDayEvent])).toEqual([]);
});
