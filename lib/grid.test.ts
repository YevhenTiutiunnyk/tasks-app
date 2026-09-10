import { describe, expect, test } from 'vitest';
import { eventsOutsideRange, visibleHourRange } from './grid';
import type { EventDay, Settings, Task } from './types';

const settings: Settings = {
  workStartMinute: 540,   // 09:00
  workEndMinute: 1080,    // 18:00
  aboutMe: '',
  categories: [],
  notifyBeforeMinutes: 15,
};

function event(patch: Partial<EventDay> = {}): EventDay {
  return {
    calendarId: 'primary',
    eventId: 'e1',
    title: 'ZZ-встреча',
    date: '2026-09-10',
    startMinute: 600,
    durationMinutes: 60,
    allDay: false,
    mine: true,
    ...patch,
  };
}

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

  // Встречи из Google растягивают диапазон наравне с задачами. Без этого
  // встреча раньше рабочих часов — планёрка в восемь утра, ночной перелёт —
  // молча не рисуется вовсе: её отступ оказывается выше первого часа сетки.
  // На телефоне она при этом видна в ленте, то есть экраны расходятся,
  // и человеку неоткуда узнать, что от него что-то скрыли.
  test('ранняя встреча растягивает диапазон вверх', () => {
    // 06:00 — раньше нижней границы рабочего дня с запасом (07:00),
    // иначе тест прошёл бы и без починки: встреча уже помещалась бы в сетку.
    expect(visibleHourRange([], settings, [event({ startMinute: 360 })]).firstHour).toBe(6);
  });

  test('поздняя встреча растягивает диапазон вниз', () => {
    const late = event({ startMinute: 1380, durationMinutes: 60 });
    expect(visibleHourRange([], settings, [late]).lastHour).toBe(24);
  });

  test('встреча на весь день диапазон не трогает', () => {
    const whole = event({ allDay: true, startMinute: null, durationMinutes: null });
    expect(visibleHourRange([], settings, [whole])).toEqual({ firstHour: 7, lastHour: 20 });
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

describe('eventsOutsideRange', () => {
  // Диапазон 09:00–18:00 для всех тестов ниже.
  const FIRST = 9;
  const LAST = 18;

  test('встреча целиком раньше диапазона считается скрытой сверху', () => {
    const early = event({ startMinute: 360, durationMinutes: 60 }); // 06:00–07:00
    const hidden = eventsOutsideRange([early], FIRST, LAST);
    expect(hidden.before.map((item) => item.eventId)).toEqual(['e1']);
    expect(hidden.after).toEqual([]);
  });

  test('встреча целиком позже диапазона считается скрытой снизу', () => {
    const late = event({ startMinute: 1290, durationMinutes: 60 }); // 21:30–22:30
    const hidden = eventsOutsideRange([late], FIRST, LAST);
    expect(hidden.after.map((item) => item.eventId)).toEqual(['e1']);
    expect(hidden.before).toEqual([]);
  });

  // Самая важная граница: встреча, задевающая край, на экране ЕСТЬ. Объявить
  // её скрытой значило бы звать человека раскрывать то, что он уже видит.
  test('встреча, задевающая край, скрытой не считается', () => {
    const overlapsTop = event({ startMinute: 480, durationMinutes: 90 }); // 08:00–09:30
    expect(eventsOutsideRange([overlapsTop], FIRST, LAST).before).toEqual([]);
    const overlapsBottom = event({ startMinute: 1050, durationMinutes: 90 }); // 17:30–19:00
    expect(eventsOutsideRange([overlapsBottom], FIRST, LAST).after).toEqual([]);
  });

  test('встреча, кончающаяся ровно на границе, скрыта — видимой её части нет', () => {
    const touches = event({ startMinute: 480, durationMinutes: 60 }); // 08:00–09:00
    expect(eventsOutsideRange([touches], FIRST, LAST).before).toHaveLength(1);
  });

  test('встречи на весь день в скрытые не попадают никогда', () => {
    const whole = event({ allDay: true, startMinute: null, durationMinutes: null });
    expect(eventsOutsideRange([whole], FIRST, LAST)).toEqual({ before: [], after: [] });
  });

  test('встреча без длительности считается часовой', () => {
    const early = event({ startMinute: 480, durationMinutes: null }); // 08:00–09:00
    expect(eventsOutsideRange([early], FIRST, LAST).before).toHaveLength(1);
  });
});
