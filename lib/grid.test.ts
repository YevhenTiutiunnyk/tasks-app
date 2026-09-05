import { describe, expect, test } from 'vitest';
import { visibleHourRange } from './grid';
import type { Settings, Task } from './types';

const settings: Settings = {
  workStartMinute: 540,   // 09:00
  workEndMinute: 1080,    // 18:00
  aboutMe: '',
  categories: [],
  notifyBeforeMinutes: 15,
};

function task(fields: Partial<Task>): Task {
  return {
    id: 'id',
    title: 'Задача',
    date: '2026-08-05',
    startMinute: 600,
    durationMinutes: 60,
    allDay: false,
    categoryId: null,
    done: false,
    horizon: 'day',
    recurrenceId: null,
    recurrenceDate: null,
    ...fields,
  };
}

describe('visibleHourRange', () => {
  test('без задач — рабочие часы, расширенные на два часа в обе стороны', () => {
    expect(visibleHourRange([], settings)).toEqual({ firstHour: 7, lastHour: 20 });
  });

  test('задача внутри рабочего дня диапазон не меняет', () => {
    expect(visibleHourRange([task({ startMinute: 600 })], settings)).toEqual({
      firstHour: 7,
      lastHour: 20,
    });
  });

  test('ранняя задача опускает нижнюю границу до своего часа', () => {
    expect(visibleHourRange([task({ startMinute: 360 })], settings).firstHour).toBe(6);
  });

  test('нижняя граница берёт час начала, а не округляет вверх', () => {
    expect(visibleHourRange([task({ startMinute: 375 })], settings).firstHour).toBe(6);
  });

  test('поздняя задача поднимает верхнюю границу до часа своего конца', () => {
    const late = task({ startMinute: 1260, durationMinutes: 60 }); // 21:00–22:00
    expect(visibleHourRange([late], settings).lastHour).toBe(22);
  });

  test('верхняя граница округляет конец вверх до целого часа', () => {
    const late = task({ startMinute: 1260, durationMinutes: 45 }); // 21:00–21:45
    expect(visibleHourRange([late], settings).lastHour).toBe(22);
  });

  test('задача без длительности считается часовой', () => {
    const late = task({ startMinute: 1260, durationMinutes: null }); // 21:00–22:00
    expect(visibleHourRange([late], settings).lastHour).toBe(22);
  });

  test('задачи на весь день на диапазон не влияют', () => {
    const allDay = task({ allDay: true, startMinute: null, durationMinutes: null });
    expect(visibleHourRange([allDay], settings)).toEqual({ firstHour: 7, lastHour: 20 });
  });

  test('диапазон не выходит за начало суток', () => {
    expect(visibleHourRange([task({ startMinute: 15 })], settings).firstHour).toBe(0);
  });

  test('диапазон не выходит за конец суток', () => {
    const late = task({ startMinute: 1410, durationMinutes: 60 }); // 23:30, конец за полночь
    expect(visibleHourRange([late], settings).lastHour).toBe(24);
  });

  test('диапазон расширяется по самой ранней и самой поздней задаче сразу', () => {
    const tasks = [
      task({ id: 'a', startMinute: 360 }),
      task({ id: 'b', startMinute: 600 }),
      task({ id: 'c', startMinute: 1260, durationMinutes: 120 }), // 21:00–23:00
    ];
    expect(visibleHourRange(tasks, settings)).toEqual({ firstHour: 6, lastHour: 23 });
  });
});
