import { describe, it, expect, afterAll } from 'vitest';
import { applyOperations, undoBatch } from './apply';
import { getTasksBetween, sql } from './db';
import type { Operation } from './types';

const run = process.env.DATABASE_URL ? describe : describe.skip;

const FROM = '2030-01-07';   // понедельник, заведомо пустая неделя
const TO = '2030-01-13';

function create(title: string, date: string, startMinute: number | null): Operation {
  return {
    type: 'create', title, date, startMinute,
    durationMinutes: startMinute === null ? null : 60,
    allDay: startMinute === null, categoryId: null, recurrence: null,
  };
}

async function clean() {
  await sql`delete from tasks where date >= ${FROM} and date <= ${TO}`;
  await sql`delete from recurrences where starts_on >= ${FROM} and starts_on <= ${TO}`;
  await sql`delete from command_log`;
}

run('applyOperations', () => {
  afterAll(async () => {
    await clean();
    await sql.end();
  });

  it('создаёт задачу', async () => {
    await clean();
    await applyOperations('в среду в 10 врач', [create('Врач', '2030-01-09', 600)]);
    const tasks = await getTasksBetween(FROM, TO);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Врач');
    expect(tasks[0].startMinute).toBe(600);
  });

  it('переносит задачу', async () => {
    await clean();
    await applyOperations('создать', [create('Врач', '2030-01-09', 600)]);
    const [task] = await getTasksBetween(FROM, TO);
    await applyOperations('перенеси врача на пятницу', [
      {
        type: 'update', taskId: task.id, title: null, date: '2030-01-11',
        startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
      },
    ]);
    const [moved] = await getTasksBetween(FROM, TO);
    expect(moved.date).toBe('2030-01-11');
    expect(moved.startMinute).toBe(600);   // время не трогали
  });

  it('удаляет задачу', async () => {
    await clean();
    await applyOperations('создать', [create('Врач', '2030-01-09', 600)]);
    const [task] = await getTasksBetween(FROM, TO);
    await applyOperations('удали врача', [{ type: 'delete', taskId: task.id }]);
    expect(await getTasksBetween(FROM, TO)).toHaveLength(0);
  });

  it('создаёт правило повтора вместо задачи', async () => {
    await clean();
    await applyOperations('каждый вторник в 8 зал', [
      {
        type: 'create', title: 'Зал', date: null, startMinute: 480, durationMinutes: 60,
        allDay: false, categoryId: null,
        recurrence: { weekdays: [2], startsOn: '2030-01-07', endsOn: null },
      },
    ]);
    const rules = await sql`select * from recurrences where starts_on = '2030-01-07'`;
    expect(rules).toHaveLength(1);
    expect(rules[0].title).toBe('Зал');
    expect(await getTasksBetween(FROM, TO)).toHaveLength(0);
  });

  it('материализует вхождение серии при удалении', async () => {
    await clean();
    await applyOperations('каждый вторник в 8 зал', [
      {
        type: 'create', title: 'Зал', date: null, startMinute: 480, durationMinutes: 60,
        allDay: false, categoryId: null,
        recurrence: { weekdays: [2], startsOn: '2030-01-07', endsOn: null },
      },
    ]);
    const [rule] = await sql`select * from recurrences where starts_on = '2030-01-07'`;
    await applyOperations('убери зал во вторник', [
      { type: 'delete', taskId: `occ:${rule.id}:2030-01-08` },
    ]);
    const exceptions = await sql`select * from recurrence_exceptions where recurrence_id = ${rule.id}`;
    expect(exceptions).toHaveLength(1);
  });

  it('откатывает всю пачку целиком', async () => {
    await clean();
    const { batchId } = await applyOperations('две задачи', [
      create('Первая', '2030-01-08', 540),
      create('Вторая', '2030-01-08', 660),
    ]);
    expect(await getTasksBetween(FROM, TO)).toHaveLength(2);
    expect(await undoBatch(batchId)).toBe(true);
    expect(await getTasksBetween(FROM, TO)).toHaveLength(0);
  });

  it('откат возвращает удалённую задачу', async () => {
    await clean();
    await applyOperations('создать', [create('Врач', '2030-01-09', 600)]);
    const [task] = await getTasksBetween(FROM, TO);
    const { batchId } = await applyOperations('удали', [{ type: 'delete', taskId: task.id }]);
    expect(await undoBatch(batchId)).toBe(true);
    const restored = await getTasksBetween(FROM, TO);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe(task.id);
    expect(restored[0].startMinute).toBe(600);
  });

  it('второй откат той же пачки возвращает false', async () => {
    await clean();
    const { batchId } = await applyOperations('создать', [create('Врач', '2030-01-09', 600)]);
    expect(await undoBatch(batchId)).toBe(true);
    expect(await undoBatch(batchId)).toBe(false);
  });

  it('не оставляет следов, если операция посреди пачки упала', async () => {
    await clean();
    await expect(
      applyOperations('сломанная пачка', [
        create('Первая', '2030-01-08', 540),
        { type: 'update', taskId: 'не-uuid-вовсе', title: 'Х', date: null,
          startMinute: null, durationMinutes: null, allDay: null, categoryId: null },
      ]),
    ).rejects.toThrow();
    expect(await getTasksBetween(FROM, TO)).toHaveLength(0);
  });
});
