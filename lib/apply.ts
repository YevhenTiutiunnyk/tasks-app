import 'server-only';
import postgres, { type TransactionSql } from 'postgres';
import { rowToTask, sql } from './db';
import { parseOccurrenceId } from './recurrence';
import type { Operation, Task } from './types';

/** Что было до применения — этого хватает, чтобы всё вернуть назад. */
interface Snapshot {
  tasks: { id: string; before: Task | null }[];
  recurrences: string[];                                     // созданные правила — при откате удаляются
  exceptions: { recurrenceId: string; date: string }[];      // созданные исключения — при откате удаляются
}

async function materializeOccurrence(
  tx: TransactionSql,
  recurrenceId: string,
  date: string,
): Promise<Task> {
  const [rule] = await tx`select * from recurrences where id = ${recurrenceId}`;
  if (!rule) throw new Error(`Правило повтора ${recurrenceId} не найдено`);

  await tx`
    insert into recurrence_exceptions (recurrence_id, date) values (${recurrenceId}, ${date})
    on conflict do nothing
  `;
  const [row] = await tx`
    insert into tasks (title, date, start_minute, duration_minutes, all_day, category_id,
                       recurrence_id, recurrence_date)
    values (${rule.title}, ${date}, ${rule.start_minute}, ${rule.duration_minutes},
            ${rule.all_day}, ${rule.category_id}, ${recurrenceId}, ${date})
    returning *
  `;
  return rowToTask(row);
}

/**
 * Применяет пачку операций одной транзакцией и пишет её в журнал.
 * Если хоть одна операция упала — не применяется ничего.
 */
export async function applyOperations(
  text: string,
  operations: Operation[],
): Promise<{ batchId: string }> {
  return sql.begin(async (tx) => {
    const snapshot: Snapshot = { tasks: [], recurrences: [], exceptions: [] };

    for (const operation of operations) {
      if (operation.type === 'create') {
        if (operation.recurrence) {
          const [row] = await tx`
            insert into recurrences (title, weekdays, start_minute, duration_minutes,
                                     all_day, category_id, starts_on, ends_on)
            values (${operation.title}, ${operation.recurrence.weekdays},
                    ${operation.startMinute}, ${operation.durationMinutes},
                    ${operation.allDay ?? false}, ${operation.categoryId},
                    ${operation.recurrence.startsOn}, ${operation.recurrence.endsOn})
            returning id
          `;
          snapshot.recurrences.push(row.id);
        } else {
          const [row] = await tx`
            insert into tasks (title, date, start_minute, duration_minutes, all_day, category_id)
            values (${operation.title}, ${operation.date}, ${operation.startMinute},
                    ${operation.durationMinutes}, ${operation.allDay ?? false},
                    ${operation.categoryId})
            returning *
          `;
          snapshot.tasks.push({ id: row.id, before: null });
        }
        continue;
      }

      // update и delete: если это вхождение серии — сначала материализуем.
      let taskId = operation.taskId;
      const occurrence = parseOccurrenceId(taskId);
      if (occurrence) {
        // Вхождение могло быть материализовано раньше — этой же пачкой или прошлой.
        // Без этой проверки вторая операция над тем же занятием создала бы дубль.
        const [existing] = await tx`
          select * from tasks
          where recurrence_id = ${occurrence.recurrenceId}
            and recurrence_date = ${occurrence.date}
        `;
        if (existing) {
          taskId = existing.id;
          snapshot.tasks.push({ id: taskId, before: rowToTask(existing) });
        } else {
          const created = await materializeOccurrence(tx, occurrence.recurrenceId, occurrence.date);
          taskId = created.id;
          snapshot.tasks.push({ id: created.id, before: null });
          snapshot.exceptions.push({ recurrenceId: occurrence.recurrenceId, date: occurrence.date });
        }
      } else {
        const [row] = await tx`select * from tasks where id = ${taskId}`;
        if (!row) throw new Error(`Задача ${taskId} не найдена`);
        snapshot.tasks.push({ id: taskId, before: rowToTask(row) });
      }

      if (operation.type === 'delete') {
        await tx`delete from tasks where id = ${taskId}`;
        continue;
      }

      // Обновляем только те поля, что модель действительно назвала. Для правки
      // из карточки задачи это не годится: она присылает все поля разом, и там
      // null значит «очистить», а не «не трогать». Флаг replace разделяет
      // эти два смысла.
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (operation.replace) {
        patch.title = operation.title;
        patch.date = operation.date;
        patch.start_minute = operation.startMinute;
        patch.duration_minutes = operation.durationMinutes;
        patch.all_day = operation.allDay;
        patch.category_id = operation.categoryId;
      } else {
        if (operation.title !== null) patch.title = operation.title;
        if (operation.date !== null) patch.date = operation.date;
        if (operation.startMinute !== null) patch.start_minute = operation.startMinute;
        if (operation.durationMinutes !== null) patch.duration_minutes = operation.durationMinutes;
        if (operation.allDay !== null) patch.all_day = operation.allDay;
        if (operation.categoryId !== null) patch.category_id = operation.categoryId;
      }

      await tx`update tasks set ${tx(patch)} where id = ${taskId}`;
    }

    // sql.json()'s parameter type (postgres.JSONValue) requires an index
    // signature; Snapshot is a plain-JSON-safe interface declared without
    // one, so TS rejects the structural match — cast through unknown
    // rather than loosen Snapshot's shape (same pattern as db.ts:saveSettings).
    const [batch] = await tx`
      insert into command_log (text, operations, snapshot)
      values (${text}, ${tx.json(operations)}, ${tx.json(snapshot as unknown as postgres.JSONValue)})
      returning id
    `;
    await tx`
      delete from command_log
      where id not in (select id from command_log order by created_at desc limit 50)
    `;

    return { batchId: batch.id as string };
  });
}

/** Откатывает пачку. Возвращает false, если такой пачки уже нет. */
export async function undoBatch(batchId: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [batch] = await tx`select * from command_log where id = ${batchId}`;
    if (!batch) return false;

    const snapshot = batch.snapshot as Snapshot;

    // В обратном порядке: если пачка трогала одну задачу дважды, первым записан
    // её исходный вид. Идя вперёд, мы бы восстановили оригинал, а потом затёрли
    // его промежуточным состоянием из второй записи.
    for (const entry of [...snapshot.tasks].reverse()) {
      if (entry.before === null) {
        await tx`delete from tasks where id = ${entry.id}`;
        continue;
      }
      const t = entry.before;
      await tx`
        insert into tasks (id, title, date, start_minute, duration_minutes, all_day,
                           category_id, done, recurrence_id, recurrence_date)
        values (${t.id}, ${t.title}, ${t.date}, ${t.startMinute}, ${t.durationMinutes},
                ${t.allDay}, ${t.categoryId}, ${t.done}, ${t.recurrenceId}, ${t.recurrenceDate})
        on conflict (id) do update set
          title = excluded.title, date = excluded.date,
          start_minute = excluded.start_minute, duration_minutes = excluded.duration_minutes,
          all_day = excluded.all_day, category_id = excluded.category_id,
          done = excluded.done, recurrence_id = excluded.recurrence_id,
          recurrence_date = excluded.recurrence_date, updated_at = now()
      `;
    }

    for (const exception of snapshot.exceptions) {
      await tx`
        delete from recurrence_exceptions
        where recurrence_id = ${exception.recurrenceId} and date = ${exception.date}
      `;
    }
    for (const recurrenceId of snapshot.recurrences) {
      await tx`delete from recurrences where id = ${recurrenceId}`;
    }

    await tx`delete from command_log where id = ${batchId}`;
    return true;
  });
}
