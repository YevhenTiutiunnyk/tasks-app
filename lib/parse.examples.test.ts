import { describe, it, expect } from 'vitest';
import { parseCommand } from './parse';
import type { Settings, Task } from './types';

const run = process.env.RUN_LLM_TESTS ? describe : describe.skip;

const settings: Settings = {
  workStartMinute: 540,
  workEndMinute: 1080,
  aboutMe: 'Встаю в 7, спортзал обычно вечером.',
  categories: [
    { id: 'work', name: 'Работа', color: '#3b82f6' },
    { id: 'sport', name: 'Спорт', color: '#22c55e' },
    { id: 'health', name: 'Здоровье', color: '#ef4444' },
  ],
};

const DOCTOR_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

const tasks: Task[] = [
  {
    id: DOCTOR_ID, title: 'Врач', date: '2026-08-05', startMinute: 600,
    durationMinutes: 60, allDay: false, categoryId: 'health', done: false,
    recurrenceId: null, recurrenceDate: null,
  },
];

const base = { today: '2026-08-04', timezone: 'Europe/Kyiv', tasks, settings };

run('parseCommand', () => {
  it('создаёт задачу с явным временем', async () => {
    const result = await parseCommand({ ...base, text: 'в четверг в 15 забрать посылку' });
    expect(result.operations).toHaveLength(1);
    const op = result.operations[0];
    expect(op.type).toBe('create');
    if (op.type === 'create') {
      expect(op.date).toBe('2026-08-06');
      expect(op.startMinute).toBe(900);
    }
    expect(result.needsTime).toEqual([]);
  }, 120_000);

  it('переносит существующую задачу по её id', async () => {
    const result = await parseCommand({ ...base, text: 'перенеси врача на пятницу' });
    const op = result.operations[0];
    expect(op.type).toBe('update');
    if (op.type === 'update') {
      expect(op.taskId).toBe(DOCTOR_ID);
      expect(op.date).toBe('2026-08-07');
    }
  }, 120_000);

  it('удаляет существующую задачу', async () => {
    const result = await parseCommand({ ...base, text: 'убери врача из расписания' });
    expect(result.operations).toEqual([{ type: 'delete', taskId: DOCTOR_ID }]);
  }, 120_000);

  it('заводит правило повтора', async () => {
    const result = await parseCommand({ ...base, text: 'каждый вторник в 8 утра спортзал' });
    const op = result.operations[0];
    expect(op.type).toBe('create');
    if (op.type === 'create') {
      expect(op.recurrence?.weekdays).toEqual([2]);
      expect(op.startMinute).toBe(480);
      expect(op.date).toBeNull();
    }
  }, 120_000);

  it('спрашивает время у обеих задач без времени', async () => {
    const result = await parseCommand({
      ...base,
      text: 'надо сходить в спортзал и доделать отчёт',
    });
    expect(result.operations).toHaveLength(2);
    expect(result.needsTime).toHaveLength(2);
  }, 120_000);

  it('размытое время трактует сам и не спрашивает', async () => {
    const result = await parseCommand({ ...base, text: 'поставь созвон завтра утром' });
    const op = result.operations[0];
    expect(op.type).toBe('create');
    if (op.type === 'create') {
      expect(op.startMinute).not.toBeNull();
      expect(op.allDay).not.toBe(true);
    }
    expect(result.needsTime).toEqual([]);
  }, 120_000);

  it('не выдумывает задачу, которой нет', async () => {
    const result = await parseCommand({ ...base, text: 'перенеси совещание с бухгалтером на среду' });
    expect(result.operations).toEqual([]);
    expect(result.reply.length).toBeGreaterThan(0);
  }, 120_000);
});
