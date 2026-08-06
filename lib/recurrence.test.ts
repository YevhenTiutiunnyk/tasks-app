import { describe, it, expect } from 'vitest';
import { expandRecurrences, occurrenceId, parseOccurrenceId } from './recurrence';
import type { Recurrence } from './types';

const gym: Recurrence = {
  id: 'r1',
  title: 'Спортзал',
  weekdays: [2],                 // вторник
  startMinute: 480,              // 08:00
  durationMinutes: 60,
  allDay: false,
  categoryId: 'sport',
  startsOn: '2026-08-01',
  endsOn: null,
};

describe('occurrenceId', () => {
  it('складывается и разбирается обратно', () => {
    const id = occurrenceId('r1', '2026-08-04');
    expect(parseOccurrenceId(id)).toEqual({ recurrenceId: 'r1', date: '2026-08-04' });
  });

  it('на обычном uuid отдаёт null', () => {
    expect(parseOccurrenceId('7f1c6a5e-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('expandRecurrences', () => {
  it('даёт одно вхождение на неделю', () => {
    const result = expandRecurrences([gym], [], '2026-08-03', '2026-08-09');
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-08-04');
    expect(result[0].startMinute).toBe(480);
    expect(result[0].title).toBe('Спортзал');
    expect(result[0].recurrenceId).toBe('r1');
    expect(result[0].recurrenceDate).toBe('2026-08-04');
  });

  it('пропускает вхождение, на которое есть исключение', () => {
    const result = expandRecurrences(
      [gym],
      [{ recurrenceId: 'r1', date: '2026-08-04' }],
      '2026-08-03',
      '2026-08-09',
    );
    expect(result).toEqual([]);
  });

  it('не выходит за starts_on', () => {
    const result = expandRecurrences([gym], [], '2026-07-27', '2026-08-02');
    expect(result).toEqual([]);
  });

  it('не выходит за ends_on', () => {
    const ending = { ...gym, endsOn: '2026-08-10' };
    const result = expandRecurrences([ending], [], '2026-08-10', '2026-08-16');
    expect(result).toEqual([]);   // ближайший вторник — 11 августа, уже после конца
  });

  it('раскрывает несколько дней недели', () => {
    const twice = { ...gym, weekdays: [2, 4] };
    const result = expandRecurrences([twice], [], '2026-08-03', '2026-08-09');
    expect(result.map((t) => t.date)).toEqual(['2026-08-04', '2026-08-06']);
  });

  it('работает на стыке месяцев', () => {
    const result = expandRecurrences([gym], [], '2026-08-31', '2026-09-06');
    expect(result.map((t) => t.date)).toEqual(['2026-09-01']);
  });

  it('раскрывает задачи на весь день', () => {
    const allDay = { ...gym, allDay: true, startMinute: null, durationMinutes: null };
    const [task] = expandRecurrences([allDay], [], '2026-08-03', '2026-08-09');
    expect(task.allDay).toBe(true);
    expect(task.startMinute).toBeNull();
  });

  it('раскрывает несколько правил сразу', () => {
    const other: Recurrence = { ...gym, id: 'r2', title: 'Планёрка', weekdays: [1], startMinute: 600 };
    const result = expandRecurrences([gym, other], [], '2026-08-03', '2026-08-09');
    expect(result.map((t) => t.title).sort()).toEqual(['Планёрка', 'Спортзал']);
  });
});
