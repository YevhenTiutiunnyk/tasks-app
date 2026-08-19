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
  userId: string,
  recurrenceId: string,
  date: string,
): Promise<{ task: Task; exceptionCreated: boolean }> {
  // Владелец проверяется здесь, до вставок: без него чужое правило нашлось бы,
  // и мы завели бы по нему задачу себе, а на его дату — исключение. Занятие
  // исчезло бы из календаря настоящего владельца, и он бы этого не заметил.
  // Ответ на чужое правило тот же, что на несуществующее: разница в ответах
  // сама по себе рассказывала бы, какие правила есть у других.
  const [rule] = await tx`
    select * from recurrences where id = ${recurrenceId} and user_id = ${userId}
  `;
  if (!rule) throw new Error(`Правило повтора ${recurrenceId} не найдено`);

  // returning отдаёт строку только если вставка действительно случилась.
  // Исключение могло существовать и до этой пачки — так бывает, когда
  // вхождение уже вычёркивали. Записать его в снимок безусловно значило бы
  // при откате удалить чужое исключение, и вычеркнутое занятие вернулось бы
  // в календарь само собой.
  const [exception] = await tx`
    insert into recurrence_exceptions (recurrence_id, date) values (${recurrenceId}, ${date})
    on conflict do nothing
    returning recurrence_id
  `;
  const [row] = await tx`
    insert into tasks (title, date, start_minute, duration_minutes, all_day, category_id,
                       recurrence_id, recurrence_date, user_id)
    values (${rule.title}, ${date}, ${rule.start_minute}, ${rule.duration_minutes},
            ${rule.all_day}, ${rule.category_id}, ${recurrenceId}, ${date}, ${userId})
    returning *
  `;
  return { task: rowToTask(row), exceptionCreated: exception !== undefined };
}

/**
 * Применяет пачку операций одной транзакцией и пишет её в журнал.
 * Если хоть одна операция упала — не применяется ничего.
 */
export async function applyOperations(
  userId: string,
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
                                     all_day, category_id, starts_on, ends_on, user_id)
            values (${operation.title}, ${operation.recurrence.weekdays},
                    ${operation.startMinute}, ${operation.durationMinutes},
                    ${operation.allDay ?? false}, ${operation.categoryId},
                    ${operation.recurrence.startsOn}, ${operation.recurrence.endsOn},
                    ${userId})
            returning id
          `;
          snapshot.recurrences.push(row.id);
        } else {
          const [row] = await tx`
            insert into tasks (title, date, start_minute, duration_minutes, all_day,
                               category_id, user_id)
            values (${operation.title}, ${operation.date}, ${operation.startMinute},
                    ${operation.durationMinutes}, ${operation.allDay ?? false},
                    ${operation.categoryId}, ${userId})
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
            and user_id = ${userId}
        `;
        if (existing) {
          taskId = existing.id;
          snapshot.tasks.push({ id: taskId, before: rowToTask(existing) });
        } else {
          const { task: created, exceptionCreated } =
            await materializeOccurrence(tx, userId, occurrence.recurrenceId, occurrence.date);
          taskId = created.id;
          snapshot.tasks.push({ id: created.id, before: null });
          if (exceptionCreated) {
            snapshot.exceptions.push({ recurrenceId: occurrence.recurrenceId, date: occurrence.date });
          }
        }
      } else {
        // Чужая задача — то же самое, что несуществующая: и там и там пачка
        // падает целиком с одним сообщением. Отдельная ветка «есть, но не
        // твоя» превратила бы перебор идентификаторов в способ узнать,
        // что у другого человека вообще есть в расписании.
        const [row] = await tx`
          select * from tasks where id = ${taskId} and user_id = ${userId}
        `;
        if (!row) throw new Error(`Задача ${taskId} не найдена`);
        snapshot.tasks.push({ id: taskId, before: rowToTask(row) });
      }

      if (operation.type === 'delete') {
        // Фильтр здесь дублирует выборку выше и остаётся намеренно: строка
        // могла бы поменять владельца между запросами, а цена промаха —
        // удалённое чужое занятие.
        await tx`delete from tasks where id = ${taskId} and user_id = ${userId}`;
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

      await tx`update tasks set ${tx(patch)} where id = ${taskId} and user_id = ${userId}`;
    }

    // sql.json()'s parameter type (postgres.JSONValue) requires an index
    // signature; Snapshot is a plain-JSON-safe interface declared without
    // one, so TS rejects the structural match — cast through unknown
    // rather than loosen Snapshot's shape (same pattern as db.ts:saveSettings).
    const [batch] = await tx`
      insert into command_log (text, operations, snapshot, user_id)
      values (${text}, ${tx.json(operations)},
              ${tx.json(snapshot as unknown as postgres.JSONValue)}, ${userId})
      returning id
    `;
    // Пятьдесят записей КАЖДОМУ, а не пятьдесят на всех: без фильтра активный
    // человек вытеснял бы историю отмены у остальных, и у них кнопка «отменить»
    // просто переставала бы работать без единой ошибки. Фильтр нужен и снаружи,
    // и в подзапросе: снаружи — чтобы не трогать чужие строки, в подзапросе —
    // чтобы «полсотни свежих» считались среди своих.
    await tx`
      delete from command_log
      where user_id = ${userId}
        and id not in (
          select id from command_log where user_id = ${userId}
          order by created_at desc limit 50
        )
    `;

    return { batchId: batch.id as string };
  });
}

/** Откатывает пачку. Возвращает false, если такой пачки уже нет. */
export async function undoBatch(userId: string, batchId: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    // Чужая пачка неотличима от несуществующей: обе дают false. Дальше по
    // снимку строки восстанавливаются по своим собственным идентификаторам —
    // пачка уже проверена на принадлежность, и повторно фильтровать нечего.
    const [batch] = await tx`
      select * from command_log where id = ${batchId} and user_id = ${userId}
    `;
    if (!batch) return false;

    const snapshot = batch.snapshot as Snapshot;

    // В обратном порядке: если пачка трогала одну задачу дважды, первым записан
    // её исходный вид. Идя вперёд, мы бы восстановили оригинал, а потом затёрли
    // его промежуточным состоянием из второй записи.
    for (const entry of [...snapshot.tasks].reverse()) {
      if (entry.before === null) {
        await tx`delete from tasks where id = ${entry.id} and user_id = ${userId}`;
        continue;
      }
      const t = entry.before;
      // user_id в списке колонок, но не в do update set: при восстановлении
      // удалённой задачи строку заводим заново, и без владельца она вернулась
      // бы ничьей — то есть невидимой и тому, кто нажал «отменить». У живой
      // строки владелец уже верный, и трогать его нечем: снимок владельца
      // не хранит.
      await tx`
        insert into tasks (id, title, date, start_minute, duration_minutes, all_day,
                           category_id, done, recurrence_id, recurrence_date, user_id)
        values (${t.id}, ${t.title}, ${t.date}, ${t.startMinute}, ${t.durationMinutes},
                ${t.allDay}, ${t.categoryId}, ${t.done}, ${t.recurrenceId},
                ${t.recurrenceDate}, ${userId})
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
      await tx`delete from recurrences where id = ${recurrenceId} and user_id = ${userId}`;
    }

    await tx`delete from command_log where id = ${batchId}`;
    return true;
  });
}
