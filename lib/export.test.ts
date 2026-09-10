import { expect, test } from 'vitest';
import { diffExport, eventTitle, exportWindow, exportableTasks, fingerprintOf } from './export';
import type { Task } from './types';
import type { ExportLink } from './db';

function task(patch: Partial<Task> = {}): Task {
  return {
    id: 't1', title: 'ZZ-тренировка', date: '2026-09-10', startMinute: 600,
    durationMinutes: 60, allDay: false, categoryId: null, done: false,
    horizon: 'day', recurrenceId: null, recurrenceDate: null, ...patch,
  };
}

test('окно — неделя назад и месяц вперёд', () => {
  expect(exportWindow('2026-09-10')).toEqual({ from: '2026-09-03', to: '2026-10-10' });
});

test('выгружаются только дела с днём и часом', () => {
  const good = task();
  const allDay = task({ id: 't2', allDay: true, startMinute: null, durationMinutes: null });
  const weekly = task({ id: 't3', horizon: 'week' });
  const monthly = task({ id: 't4', horizon: 'month' });
  const noTime = task({ id: 't5', startMinute: null });
  // Дело на весь день, у которого время начала всё-таки проставлено, —
  // единственная форма, что проверяет само условие `!allDay`, а не
  // соседнее условие про время.
  const allDayWithTime = task({ id: 't6', allDay: true, startMinute: 600 });
  expect(
    exportableTasks([good, allDay, weekly, monthly, noTime, allDayWithTime]).map((item) => item.id),
  ).toEqual(['t1']);
});

test('выполненная задача получает галочку в названии', () => {
  expect(eventTitle(task())).toBe('ZZ-тренировка');
  expect(eventTitle(task({ done: true }))).toBe('✓ ZZ-тренировка');
});

test('отпечаток меняется от каждого выгружаемого поля', () => {
  const base = fingerprintOf(task());
  expect(fingerprintOf(task({ title: 'ZZ-другое' }))).not.toBe(base);
  expect(fingerprintOf(task({ date: '2026-09-11' }))).not.toBe(base);
  expect(fingerprintOf(task({ startMinute: 630 }))).not.toBe(base);
  expect(fingerprintOf(task({ durationMinutes: 90 }))).not.toBe(base);
  expect(fingerprintOf(task({ done: true }))).not.toBe(base);
});

// Поля, которых в событии нет, менять отпечаток не должны: иначе смена
// категории гнала бы в Google правку, ничего там не меняющую.
test('отпечаток не меняется от полей, которые не выгружаются', () => {
  const base = fingerprintOf(task());
  expect(fingerprintOf(task({ categoryId: 'work' }))).toBe(base);
  expect(fingerprintOf(task({ recurrenceDate: '2026-09-10' }))).toBe(base);
});

test('отпечаток устойчив: одна и та же задача даёт одно и то же значение', () => {
  expect(fingerprintOf(task())).toBe(fingerprintOf(task()));
});

function link(patch: Partial<ExportLink> = {}): ExportLink {
  return { taskKey: 't1', eventId: 'e1', fingerprint: 'старый', ...patch };
}

test('задача без связки идёт на создание', () => {
  const diff = diffExport([task()], []);
  expect(diff.create.map((item) => item.id)).toEqual(['t1']);
  expect(diff.update).toEqual([]);
  expect(diff.remove).toEqual([]);
});

test('разошедшийся отпечаток идёт на правку, с идентификатором события', () => {
  const diff = diffExport([task()], [link()]);
  expect(diff.update).toEqual([{ task: task(), eventId: 'e1' }]);
  expect(diff.create).toEqual([]);
});

test('совпавший отпечаток не даёт ни одной операции', () => {
  const current = task();
  const diff = diffExport([current], [link({ fingerprint: fingerprintOf(current) })]);
  expect(diff).toEqual({ create: [], update: [], remove: [] });
});

test('связка без задачи идёт на удаление', () => {
  const orphan = link({ taskKey: 't-исчезла', eventId: 'e-исчезла' });
  const diff = diffExport([], [orphan]);
  expect(diff.remove).toEqual([orphan]);
});

// Вхождения повторов приходят с синтетическими идентификаторами, и связка
// заводится на них же. Иначе одно занятие попадало бы разом и в «создать»,
// и в «удалить» на каждом проходе.
test('вхождение повтора связывается по своему синтетическому ключу', () => {
  const occurrence = task({ id: 'occ:rule-1:2026-09-10', recurrenceId: 'rule-1' });
  const diff = diffExport(
    [occurrence],
    [link({ taskKey: 'occ:rule-1:2026-09-10', fingerprint: fingerprintOf(occurrence) })],
  );
  expect(diff).toEqual({ create: [], update: [], remove: [] });
});
