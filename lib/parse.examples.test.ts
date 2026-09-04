import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
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
  notifyBeforeMinutes: 15,
};

const DOCTOR_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const WINDOWS_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const CRANE_ID = 'aaaaaaaa-0000-4000-8000-000000000003';

// today (2026-08-04) — вторник, поэтому понедельник её недели — 2026-08-03.
// Задача заведена с этим якорем, как реально кладёт applyOperations, —
// иначе describeTask показал бы модели дату, которой на самом деле не бывает.
const tasks: Task[] = [
  {
    id: DOCTOR_ID, title: 'Врач', date: '2026-08-05', startMinute: 600,
    durationMinutes: 60, allDay: false, categoryId: 'health', done: false,
    horizon: 'day', recurrenceId: null, recurrenceDate: null,
  },
  {
    id: WINDOWS_ID, title: 'Помыть окна', date: '2026-08-03', startMinute: null,
    durationMinutes: null, allDay: true, categoryId: null, done: false,
    horizon: 'week', recurrenceId: null, recurrenceDate: null,
  },
  // Недельная фикстура для примеров замечания 2: переход между горизонтами
  // при правке. Дата — тот же понедельник её недели, что и у «Помыть окна».
  {
    id: CRANE_ID, title: 'Починить кран', date: '2026-08-03', startMinute: null,
    durationMinutes: null, allDay: true, categoryId: null, done: false,
    horizon: 'week', recurrenceId: null, recurrenceDate: null,
  },
];

// Ключ для примеров берётся из окружения (.env.local): это стенд качества
// разбора, а не приложение. У приложения ключ приходит из базы, от вошедшего.
const client = new Anthropic();
const base = {
  today: '2026-08-04',
  timezone: 'Europe/Kyiv',
  tasks,
  settings,
};

run('parseCommand', () => {
  it('создаёт задачу с явным временем', async () => {
    const result = await parseCommand(client, { ...base, text: 'в четверг в 15 забрать посылку' });
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
    const result = await parseCommand(client, { ...base, text: 'перенеси врача на пятницу' });
    const op = result.operations[0];
    expect(op.type).toBe('update');
    if (op.type === 'update') {
      expect(op.taskId).toBe(DOCTOR_ID);
      expect(op.date).toBe('2026-08-07');
    }
  }, 120_000);

  it('удаляет существующую задачу', async () => {
    const result = await parseCommand(client, { ...base, text: 'убери врача из расписания' });
    expect(result.operations).toEqual([{ type: 'delete', taskId: DOCTOR_ID }]);
  }, 120_000);

  it('заводит правило повтора', async () => {
    const result = await parseCommand(client, { ...base, text: 'каждый вторник в 8 утра спортзал' });
    const op = result.operations[0];
    expect(op.type).toBe('create');
    if (op.type === 'create') {
      expect(op.recurrence?.weekdays).toEqual([2]);
      expect(op.startMinute).toBe(480);
      expect(op.date).toBeNull();
    }
  }, 120_000);

  it('спрашивает время у обеих задач без времени', async () => {
    const result = await parseCommand(client, {
      ...base,
      text: 'надо сходить в спортзал и доделать отчёт',
    });
    expect(result.operations).toHaveLength(2);
    expect(result.needsTime).toHaveLength(2);
  }, 120_000);

  it('размытое время трактует сам и не спрашивает', async () => {
    const result = await parseCommand(client, { ...base, text: 'поставь созвон завтра утром' });
    const op = result.operations[0];
    expect(op.type).toBe('create');
    if (op.type === 'create') {
      expect(op.startMinute).not.toBeNull();
      expect(op.allDay).not.toBe(true);
    }
    expect(result.needsTime).toEqual([]);
  }, 120_000);

  it('не выдумывает задачу, которой нет', async () => {
    const result = await parseCommand(client, { ...base, text: 'перенеси совещание с бухгалтером на среду' });
    expect(result.operations).toEqual([]);
    expect(result.reply.length).toBeGreaterThan(0);
  }, 120_000);

  it('дело без дня, но с периодом, становится недельным', async () => {
    const result = await parseCommand(client, { ...base, text: 'почини кран на этой неделе' });
    expect(result.operations.length).toBe(1);
    const op = result.operations[0];
    expect(op.type).toBe('create');
    if (op.type === 'create') {
      expect(op.horizon).toBe('week');
      // anchorFor приведёт любую дату внутри периода к понедельнику, но только
      // если модель попала в правильную неделю. today = 2026-08-04 (вторник),
      // значит период — 2026-08-03..2026-08-09; дата за его пределами положила
      // бы задачу в чужой чеклист, и без этой проверки пример этого не заметил бы.
      expect(op.date).not.toBeNull();
      expect(op.date! >= '2026-08-03' && op.date! <= '2026-08-09').toBe(true);
    }
    // Времени у такой задачи нет по замыслу, и переспрашивать про него незачем.
    expect(result.needsTime).toEqual([]);
  }, 120_000);

  it('месячный период понимается отдельно от недельного', async () => {
    const result = await parseCommand(client, { ...base, text: 'в этом месяце сдать отчёт' });
    expect(result.operations.length).toBe(1);
    const op = result.operations[0];
    expect(op.type).toBe('create');
    if (op.type === 'create') {
      expect(op.horizon).toBe('month');
      expect(op.date).not.toBeNull();
      expect(op.date! >= '2026-08-01' && op.date! <= '2026-08-31').toBe(true);
    }
  }, 120_000);

  it('обычная фраза с днём остаётся дневной', async () => {
    // Обратная сторона: новое правило не должно превращать в недельные
    // задачи всё подряд. Без этого примера регресс промпта был бы незаметен.
    const result = await parseCommand(client, { ...base, text: 'в четверг в 15 забрать посылку' });
    expect(result.operations.length).toBe(1);
    const op = result.operations[0];
    expect(op.type === 'create' && (op.horizon === 'day' || op.horizon === null)).toBe(true);
  }, 120_000);

  it('удаляет существующую недельную задачу по её id', async () => {
    // Ровно та фраза, ради которой затевался шаг 1: недельная задача не
    // из loadRange, а из чеклиста — без объединённого контекста id
    // не нашёлся бы, и удаление отверг бы уже наш код проверки, а не модель.
    const result = await parseCommand(client, { ...base, text: 'убери из чеклиста мытьё окон' });
    expect(result.operations).toEqual([{ type: 'delete', taskId: WINDOWS_ID }]);
  }, 120_000);

  it('правка недельной задачи без периода не трогает её горизонт', async () => {
    // Регресс, который чинит замечание 1 ревью: до правки правило 8
    // не ограничивало horizon="day" только созданием, и любая правка
    // недельной задачи — даже простое переименование — молча вытаскивала
    // бы её из чеклиста в дневную сетку.
    const result = await parseCommand(client, {
      ...base,
      text: 'переименуй мытьё окон в мытьё окон и рам',
    });
    expect(result.operations.length).toBe(1);
    const op = result.operations[0];
    expect(op.type).toBe('update');
    if (op.type === 'update') {
      expect(op.taskId).toBe(WINDOWS_ID);
      expect(op.horizon).toBeNull();
    }
  }, 120_000);

  it('день, названный недельной задаче, переводит её в дневной горизонт', async () => {
    // Замечание 2 финального ревью: спека обещает, что «сделаю кран в
    // четверг» — обычная правка, которая сама переводит горизонт на
    // дневной и ставит дату. До правки правила 8 модель отвечала бы
    // horizon: null, и пересчёт якоря в lib/apply.ts тут же переписывал бы
    // четверг обратно на понедельник этой недели — снаружи выглядело бы
    // так, будто приложение ничего не сделало.
    //
    // today = 2026-08-04 (вторник), значит «в четверг» без уточнения —
    // это 2026-08-06, четверг ТЕКУЩЕЙ недели задачи (её якорь 2026-08-03).
    const result = await parseCommand(client, { ...base, text: 'почини кран в четверг в 10' });
    expect(result.operations.length).toBe(1);
    const op = result.operations[0];
    expect(op.type).toBe('update');
    if (op.type === 'update') {
      expect(op.taskId).toBe(CRANE_ID);
      expect(op.horizon).toBe('day');
      expect(op.date).toBe('2026-08-06');
      expect(op.startMinute).toBe(600);
    }
  }, 120_000);

  it('другой период, названный недельной задаче, переводит её в этот период', async () => {
    // Обратное направление того же перехода: «на следующий месяц» с
    // horizon: 'month' и date: null пересчитало бы якорь от ТЕКУЩЕЙ даты
    // задачи (2026-08-03) и оставило бы её в августе — правило 8 до
    // правки не требовало от модели даты внутри нового периода.
    const result = await parseCommand(client, {
      ...base,
      text: 'перенеси мытьё окон на следующий месяц',
    });
    expect(result.operations.length).toBe(1);
    const op = result.operations[0];
    expect(op.type).toBe('update');
    if (op.type === 'update') {
      expect(op.taskId).toBe(WINDOWS_ID);
      expect(op.horizon).toBe('month');
      // Следующий месяц от 2026-08 — сентябрь; дата вне этого диапазона
      // означала бы, что anchorFor приведёт задачу к чужому месяцу.
      expect(op.date).not.toBeNull();
      expect(op.date! >= '2026-09-01' && op.date! <= '2026-09-30').toBe(true);
    }
  }, 120_000);
});
