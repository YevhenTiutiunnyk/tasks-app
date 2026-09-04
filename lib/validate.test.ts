import { describe, it, expect } from 'vitest';
import { validateParseResult } from './validate';
import type { Category, ParseResult, Task } from './types';

const categories: Category[] = [{ id: 'sport', name: 'Спорт', color: '#22c55e' }];

const existing: Task[] = [
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    title: 'Врач',
    date: '2026-08-05',
    startMinute: 600,
    durationMinutes: 60,
    allDay: false,
    categoryId: null,
    done: false,
    horizon: 'day',
    recurrenceId: null,
    recurrenceDate: null,
  },
];

function result(operations: ParseResult['operations'], needsTime: ParseResult['needsTime'] = []): ParseResult {
  return { operations, needsTime, reply: '' };
}

const context = { tasks: existing, categories };

describe('validateParseResult', () => {
  it('пропускает корректное создание', () => {
    const out = validateParseResult(
      result([
        {
          type: 'create', title: 'Зал', date: '2026-08-04', startMinute: 480,
          durationMinutes: 60, allDay: false, categoryId: 'sport', recurrence: null,
          horizon: null,
        },
      ]),
      context,
    );
    expect(out.operations).toHaveLength(1);
    expect(out.rejected).toEqual([]);
  });

  it('отбрасывает ссылку на несуществующую задачу', () => {
    const out = validateParseResult(
      result([{ type: 'delete', taskId: 'bbbbbbbb-0000-4000-8000-000000000009' }]),
      context,
    );
    expect(out.operations).toEqual([]);
    expect(out.rejected[0].reason).toMatch(/не нашёл/i);
  });

  it('пропускает ссылку на вхождение серии', () => {
    const out = validateParseResult(
      result([{ type: 'delete', taskId: 'occ:cccccccc-0000-4000-8000-000000000002:2026-08-04' }]),
      context,
    );
    expect(out.operations).toHaveLength(1);
  });

  // occ: с обрезанным или выдуманным правилом доходил до
  // where recurrence_id = '<мусор>', Postgres падал на приведении к uuid,
  // и вместе с транзакцией терялась вся пачка — включая годные операции.
  it('отбрасывает вхождение серии с негодным идентификатором правила', () => {
    const out = validateParseResult(
      result([{ type: 'delete', taskId: 'occ:r1:2026-08-04' }]),
      context,
    );
    expect(out.operations).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toMatch(/не нашёл/i);
  });

  it('отбрасывает вхождение серии с негодной датой', () => {
    const out = validateParseResult(
      result([{ type: 'delete', taskId: 'occ:cccccccc-0000-4000-8000-000000000002:2026-02-31' }]),
      context,
    );
    expect(out.operations).toEqual([]);
    expect(out.rejected[0].reason).toMatch(/не нашёл/i);
  });

  it('отбрасывает битую дату', () => {
    const out = validateParseResult(
      result([
        {
          type: 'create', title: 'Х', date: '2026-02-31', startMinute: null,
          durationMinutes: null, allDay: true, categoryId: null, recurrence: null,
          horizon: null,
        },
      ]),
      context,
    );
    expect(out.operations).toEqual([]);
    expect(out.rejected[0].reason).toMatch(/дат/i);
  });

  it('отбрасывает время за пределами суток', () => {
    const out = validateParseResult(
      result([
        {
          type: 'create', title: 'Х', date: '2026-08-04', startMinute: 1500,
          durationMinutes: 60, allDay: false, categoryId: null, recurrence: null,
          horizon: null,
        },
      ]),
      context,
    );
    expect(out.operations).toEqual([]);
    expect(out.rejected[0].reason).toMatch(/врем/i);
  });

  it('отбрасывает неположительную длительность', () => {
    const out = validateParseResult(
      result([
        {
          type: 'create', title: 'Х', date: '2026-08-04', startMinute: 480,
          durationMinutes: 0, allDay: false, categoryId: null, recurrence: null,
          horizon: null,
        },
      ]),
      context,
    );
    expect(out.operations).toEqual([]);
    expect(out.rejected[0].reason).toMatch(/длительност/i);
  });

  it('сбрасывает выдуманную категорию, но операцию оставляет', () => {
    const out = validateParseResult(
      result([
        {
          type: 'create', title: 'Х', date: '2026-08-04', startMinute: 480,
          durationMinutes: 60, allDay: false, categoryId: 'выдумка', recurrence: null,
          horizon: null,
        },
      ]),
      context,
    );
    expect(out.operations).toHaveLength(1);
    expect((out.operations[0] as { categoryId: string | null }).categoryId).toBeNull();
  });

  it('отбрасывает пустое название', () => {
    const out = validateParseResult(
      result([
        {
          type: 'create', title: '   ', date: '2026-08-04', startMinute: 480,
          durationMinutes: 60, allDay: false, categoryId: null, recurrence: null,
          horizon: null,
        },
      ]),
      context,
    );
    expect(out.operations).toEqual([]);
  });

  // Правило 7 промпта велит ставить date: null у повторов, правило 4 —
  // сегодняшнюю дату у задач без дня. Спутав ветки, модель вернёт create
  // без даты и без повтора: колонка date объявлена not null, вставка упадёт,
  // и пачка потеряется целиком.
  it('отбрасывает создание без даты и без повтора', () => {
    const out = validateParseResult(
      result([
        {
          type: 'create', title: 'Зал', date: null, startMinute: 480,
          durationMinutes: 60, allDay: false, categoryId: null, recurrence: null,
          horizon: null,
        },
      ]),
      context,
    );
    expect(out.operations).toEqual([]);
    expect(out.rejected[0].reason).toMatch(/день|дат/i);
  });

  it('пропускает создание без даты, если это повтор', () => {
    const out = validateParseResult(
      result([
        {
          type: 'create', title: 'Зал', date: null, startMinute: 480,
          durationMinutes: 60, allDay: false, categoryId: null,
          recurrence: { weekdays: [2], startsOn: '2026-08-04', endsOn: null },
          horizon: null,
        },
      ]),
      context,
    );
    expect(out.operations).toHaveLength(1);
    expect(out.rejected).toEqual([]);
  });

  it('перенумеровывает needsTime после отбрасывания', () => {
    const out = validateParseResult(
      result(
        [
          { type: 'delete', taskId: 'нет-такой' },
          {
            type: 'create', title: 'Отчёт', date: '2026-08-04', startMinute: null,
            durationMinutes: null, allDay: true, categoryId: null, recurrence: null,
            horizon: null,
          },
        ],
        [{ operationIndex: 1, question: 'Во сколько отчёт?' }],
      ),
      context,
    );
    expect(out.operations).toHaveLength(1);
    expect(out.needsTime).toEqual([{ operationIndex: 0, question: 'Во сколько отчёт?' }]);
  });

  it('выкидывает needsTime, указывающий на отброшенную операцию', () => {
    const out = validateParseResult(
      result(
        [{ type: 'delete', taskId: 'нет-такой' }],
        [{ operationIndex: 0, question: 'Во сколько?' }],
      ),
      context,
    );
    expect(out.needsTime).toEqual([]);
  });

  it('отбрасывает правило повтора с чужим днём недели', () => {
    const out = validateParseResult(
      result([
        {
          type: 'create', title: 'Зал', date: null, startMinute: 480,
          durationMinutes: 60, allDay: false, categoryId: null,
          recurrence: { weekdays: [0, 9], startsOn: '2026-08-04', endsOn: null },
          horizon: null,
        },
      ]),
      context,
    );
    expect(out.operations).toEqual([]);
    expect(out.rejected[0].reason).toMatch(/дн(и|ей) недели/i);
  });
});
