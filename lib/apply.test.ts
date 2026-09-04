import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { applyOperations, undoBatch } from './apply';
import { getTasksBetween, sql, toIsoDate } from './db';
import type { Operation } from './types';

const run = process.env.DATABASE_URL ? describe : describe.skip;

const FROM = '2030-01-07';   // понедельник, заведомо пустая неделя
const TO = '2030-01-13';

// Владельца передаём и в запись: applyOperations и undoBatch принимают его
// первым аргументом. Чистка command_log в clean() ниже — тоже адресная,
// по своему владельцу, а не по всей таблице: файл делит тестовую базу
// с lib/ownership.test.ts, и сплошной delete гонялся бы наперегонки
// с его собственными проверками журнала.
//
// Пользователь заводится по-настоящему, а не только называется: tasks.user_id —
// внешний ключ на "user"(id), и как только задача 3 начнёт его писать, вставка
// без этой строки упала бы на нарушении ссылки.
const OWNER = 'zz-apply@example.invalid';

function create(title: string, date: string, startMinute: number | null): Operation {
  return {
    type: 'create', title, date, startMinute,
    durationMinutes: startMinute === null ? null : 60,
    allDay: startMinute === null, categoryId: null, recurrence: null,
    horizon: null,
  };
}

async function clean() {
  await sql`delete from tasks where date >= ${FROM} and date <= ${TO}`;
  await sql`delete from recurrences where starts_on >= ${FROM} and starts_on <= ${TO}`;
  // Адресно, по своему владельцу — сплошной delete смёл бы и журнал
  // lib/ownership.test.ts, если файлы когда-нибудь снова окажутся
  // на одной базе одновременно.
  await sql`delete from command_log where user_id = ${OWNER}`;
}

run('applyOperations', () => {
  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${OWNER}, ${OWNER}, ${OWNER}, false, now(), now())
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    await clean();
    // Строку пользователя — после clean: ссылки на неё стоят с on delete
    // restrict, и убрать её раньше задач не выйдет. Адресно, по своему адресу.
    await sql`delete from "user" where email = ${OWNER}`;
    await sql.end();
  });

  it('создаёт задачу', async () => {
    await clean();
    await applyOperations(OWNER, 'в среду в 10 врач', [create('Врач', '2030-01-09', 600)]);
    const tasks = await getTasksBetween(OWNER, FROM, TO);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Врач');
    expect(tasks[0].startMinute).toBe(600);
  });

  it('переносит задачу', async () => {
    await clean();
    await applyOperations(OWNER, 'создать', [create('Врач', '2030-01-09', 600)]);
    const [task] = await getTasksBetween(OWNER, FROM, TO);
    await applyOperations(OWNER, 'перенеси врача на пятницу', [
      {
        type: 'update', taskId: task.id, title: null, date: '2030-01-11',
        startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
        horizon: null,
      },
    ]);
    const [moved] = await getTasksBetween(OWNER, FROM, TO);
    expect(moved.date).toBe('2030-01-11');
    expect(moved.startMinute).toBe(600);   // время не трогали
  });

  it('удаляет задачу', async () => {
    await clean();
    await applyOperations(OWNER, 'создать', [create('Врач', '2030-01-09', 600)]);
    const [task] = await getTasksBetween(OWNER, FROM, TO);
    await applyOperations(OWNER, 'удали врача', [{ type: 'delete', taskId: task.id }]);
    expect(await getTasksBetween(OWNER, FROM, TO)).toHaveLength(0);
  });

  it('создаёт правило повтора вместо задачи', async () => {
    await clean();
    await applyOperations(OWNER, 'каждый вторник в 8 зал', [
      {
        type: 'create', title: 'Зал', date: null, startMinute: 480, durationMinutes: 60,
        allDay: false, categoryId: null,
        recurrence: { weekdays: [2], startsOn: '2030-01-07', endsOn: null },
        horizon: null,
      },
    ]);
    const rules = await sql`select * from recurrences where starts_on = '2030-01-07'`;
    expect(rules).toHaveLength(1);
    expect(rules[0].title).toBe('Зал');
    expect(await getTasksBetween(OWNER, FROM, TO)).toHaveLength(0);
  });

  it('материализует вхождение серии при удалении', async () => {
    await clean();
    await applyOperations(OWNER, 'каждый вторник в 8 зал', [
      {
        type: 'create', title: 'Зал', date: null, startMinute: 480, durationMinutes: 60,
        allDay: false, categoryId: null,
        recurrence: { weekdays: [2], startsOn: '2030-01-07', endsOn: null },
        horizon: null,
      },
    ]);
    const [rule] = await sql`select * from recurrences where starts_on = '2030-01-07'`;
    await applyOperations(OWNER, 'убери зал во вторник', [
      { type: 'delete', taskId: `occ:${rule.id}:2030-01-08` },
    ]);
    const exceptions = await sql`select * from recurrence_exceptions where recurrence_id = ${rule.id}`;
    expect(exceptions).toHaveLength(1);
  });

  it('откатывает всю пачку целиком', async () => {
    await clean();
    const { batchId } = await applyOperations(OWNER, 'две задачи', [
      create('Первая', '2030-01-08', 540),
      create('Вторая', '2030-01-08', 660),
    ]);
    expect(await getTasksBetween(OWNER, FROM, TO)).toHaveLength(2);
    expect(await undoBatch(OWNER, batchId)).toBe(true);
    expect(await getTasksBetween(OWNER, FROM, TO)).toHaveLength(0);
  });

  it('откат возвращает удалённую задачу', async () => {
    await clean();
    await applyOperations(OWNER, 'создать', [create('Врач', '2030-01-09', 600)]);
    const [task] = await getTasksBetween(OWNER, FROM, TO);
    const { batchId } = await applyOperations(OWNER, 'удали', [{ type: 'delete', taskId: task.id }]);
    expect(await undoBatch(OWNER, batchId)).toBe(true);
    const restored = await getTasksBetween(OWNER, FROM, TO);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe(task.id);
    expect(restored[0].startMinute).toBe(600);
  });

  it('второй откат той же пачки возвращает false', async () => {
    await clean();
    const { batchId } = await applyOperations(OWNER, 'создать', [create('Врач', '2030-01-09', 600)]);
    expect(await undoBatch(OWNER, batchId)).toBe(true);
    expect(await undoBatch(OWNER, batchId)).toBe(false);
  });

  it('откат возвращает исходное состояние, если пачка дважды трогала одну задачу', async () => {
    await clean();
    await applyOperations(OWNER, 'создать', [create('Врач', '2030-01-09', 600)]);
    const [task] = await getTasksBetween(OWNER, FROM, TO);
    const { batchId } = await applyOperations(OWNER, 'перенеси и переименуй', [
      {
        type: 'update', taskId: task.id, title: null, date: '2030-01-11',
        startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
        horizon: null,
      },
      {
        type: 'update', taskId: task.id, title: 'Стоматолог', date: null,
        startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
        horizon: null,
      },
    ]);
    expect(await undoBatch(OWNER, batchId)).toBe(true);
    const [restored] = await getTasksBetween(OWNER, FROM, TO);
    expect(restored.title).toBe('Врач');
    expect(restored.date).toBe('2030-01-09');
  });

  it('не дублирует вхождение серии, если пачка трогает его дважды', async () => {
    await clean();
    await applyOperations(OWNER, 'каждый вторник в 8 зал', [
      {
        type: 'create', title: 'Зал', date: null, startMinute: 480, durationMinutes: 60,
        allDay: false, categoryId: null,
        recurrence: { weekdays: [2], startsOn: '2030-01-07', endsOn: null },
        horizon: null,
      },
    ]);
    const [rule] = await sql`select * from recurrences where starts_on = '2030-01-07'`;
    const occurrence = `occ:${rule.id}:2030-01-08`;
    await applyOperations(OWNER, 'передвинь и переименуй зал во вторник', [
      {
        type: 'update', taskId: occurrence, title: null, date: null,
        startMinute: 600, durationMinutes: null, allDay: null, categoryId: null,
        horizon: null,
      },
      {
        type: 'update', taskId: occurrence, title: 'Бассейн', date: null,
        startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
        horizon: null,
      },
    ]);
    const tasks = await getTasksBetween(OWNER, FROM, TO);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Бассейн');
    expect(tasks[0].startMinute).toBe(600);
  });

  it('откат материализации убирает и исключение, и задачу', async () => {
    await clean();
    await applyOperations(OWNER, 'каждый вторник в 8 зал', [
      {
        type: 'create', title: 'Зал', date: null, startMinute: 480, durationMinutes: 60,
        allDay: false, categoryId: null,
        recurrence: { weekdays: [2], startsOn: '2030-01-07', endsOn: null },
        horizon: null,
      },
    ]);
    const [rule] = await sql`select * from recurrences where starts_on = '2030-01-07'`;
    const { batchId } = await applyOperations(OWNER, 'убери зал во вторник', [
      { type: 'delete', taskId: `occ:${rule.id}:2030-01-08` },
    ]);
    expect(await undoBatch(OWNER, batchId)).toBe(true);
    const exceptions = await sql`select * from recurrence_exceptions where recurrence_id = ${rule.id}`;
    expect(exceptions).toHaveLength(0);   // иначе занятие исчезло бы из календаря навсегда
    expect(await getTasksBetween(OWNER, FROM, TO)).toHaveLength(0);
  });

  it('не кладёт в снимок исключение, которого пачка не создавала', async () => {
    await clean();
    await applyOperations(OWNER, 'каждый вторник в 8 зал', [
      {
        type: 'create', title: 'Зал', date: null, startMinute: 480, durationMinutes: 60,
        allDay: false, categoryId: null,
        recurrence: { weekdays: [2], startsOn: '2030-01-07', endsOn: null },
        horizon: null,
      },
    ]);
    const [rule] = await sql`select * from recurrences where starts_on = '2030-01-07'`;
    const occurrence = `occ:${rule.id}:2030-01-08`;

    // Первая пачка вычеркнула вхождение: исключение появилось, задачи не осталось.
    await applyOperations(OWNER, 'убери зал во вторник', [{ type: 'delete', taskId: occurrence }]);
    expect(
      await sql`select * from recurrence_exceptions where recurrence_id = ${rule.id}`,
    ).toHaveLength(1);

    // Вторая пачка снова материализует то же вхождение. Исключение уже есть,
    // insert ... on conflict do nothing ничего не вставляет — значит эта пачка
    // исключения не создавала и в снимок класть его нечего.
    const { batchId } = await applyOperations(OWNER, 'переименуй зал во вторник', [
      {
        type: 'update', taskId: occurrence, title: 'Бассейн', date: null,
        startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
        horizon: null,
      },
    ]);
    expect(await undoBatch(OWNER, batchId)).toBe(true);

    // Иначе откат снял бы чужое исключение и вычеркнутое занятие вернулось бы
    // в календарь само собой.
    const exceptions = await sql`select * from recurrence_exceptions where recurrence_id = ${rule.id}`;
    expect(exceptions).toHaveLength(1);
    expect(await getTasksBetween(OWNER, FROM, TO)).toHaveLength(0);
  });

  it('не оставляет следов, если операция посреди пачки упала', async () => {
    await clean();
    await expect(
      applyOperations(OWNER, 'сломанная пачка', [
        create('Первая', '2030-01-08', 540),
        { type: 'update', taskId: 'не-uuid-вовсе', title: 'Х', date: null,
          startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
          horizon: null },
      ]),
    ).rejects.toThrow();
    expect(await getTasksBetween(OWNER, FROM, TO)).toHaveLength(0);
  });

  it('replace: true заменяет все поля разом — категория и время очищаются', async () => {
    await clean();
    await applyOperations(OWNER, 'создать', [
      { type: 'create', title: 'Врач', date: '2030-01-09', startMinute: 600, durationMinutes: 60,
        allDay: false, categoryId: 'health', recurrence: null, horizon: null },
    ]);
    const [task] = await getTasksBetween(OWNER, FROM, TO);
    expect(task.categoryId).toBe('health');

    // Так шлёт карточка задачи: все поля разом, null значит «очистить».
    await applyOperations(OWNER, 'правка из карточки', [
      {
        type: 'update', taskId: task.id, replace: true,
        title: 'Врач', date: '2030-01-09', startMinute: null, durationMinutes: null,
        allDay: true, categoryId: null, horizon: null,
      },
    ]);
    const [updated] = await getTasksBetween(OWNER, FROM, TO);
    expect(updated.categoryId).toBeNull();
    expect(updated.allDay).toBe(true);
    expect(updated.startMinute).toBeNull();
  });

  it('без replace null в полях не трогает их — прежнее поведение сохранилось', async () => {
    await clean();
    await applyOperations(OWNER, 'создать', [
      { type: 'create', title: 'Врач', date: '2030-01-09', startMinute: 600, durationMinutes: 60,
        allDay: false, categoryId: 'health', recurrence: null, horizon: null },
    ]);
    const [task] = await getTasksBetween(OWNER, FROM, TO);

    await applyOperations(OWNER, 'переименуй', [
      { type: 'update', taskId: task.id, title: 'Стоматолог', date: null,
        startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
        horizon: null },
    ]);
    const [updated] = await getTasksBetween(OWNER, FROM, TO);
    expect(updated.title).toBe('Стоматолог');
    expect(updated.categoryId).toBe('health');   // null без replace не трогает поле
    expect(updated.startMinute).toBe(600);        // время тоже не тронуто
  });

  const THURSDAY = '2030-01-10';   // внутри FROM..TO, но не понедельник

  it('создание с недельным горизонтом кладёт задачу на понедельник', async () => {
    // Модель называет любую дату внутри периода, якорь считаем мы.
    const { batchId } = await applyOperations(OWNER, 'ZZ-фраза', [
      {
        type: 'create',
        title: 'ZZ-кран',
        date: THURSDAY,
        startMinute: null,
        durationMinutes: null,
        allDay: true,
        categoryId: null,
        recurrence: null,
        horizon: 'week',
      },
    ]);
    try {
      const rows = await sql`
        select date, horizon from tasks where user_id = ${OWNER} and title = 'ZZ-кран'
      `;
      expect(rows.length).toBe(1);
      expect(toIsoDate(rows[0].date)).toBe(FROM);
      expect(rows[0].horizon).toBe('week');
    } finally {
      await undoBatch(OWNER, batchId);
    }
  });

  it('без горизонта задача остаётся дневной и дата не трогается', async () => {
    // Обратная сторона: фраза без периода обязана работать ровно как раньше.
    // Без этого теста приведение к якорю могло бы сдвигать на понедельник
    // вообще все задачи, и поймать это было бы нечем.
    const { batchId } = await applyOperations(OWNER, 'ZZ-фраза', [
      {
        type: 'create',
        title: 'ZZ-обычная',
        date: THURSDAY,
        startMinute: 600,
        durationMinutes: 60,
        allDay: false,
        categoryId: null,
        recurrence: null,
        horizon: null,
      },
    ]);
    try {
      const rows = await sql`
        select date, horizon from tasks where user_id = ${OWNER} and title = 'ZZ-обычная'
      `;
      expect(toIsoDate(rows[0].date)).toBe(THURSDAY);
      expect(rows[0].horizon).toBe('day');
    } finally {
      await undoBatch(OWNER, batchId);
    }
  });

  it('месячный горизонт кладёт задачу на первое число', async () => {
    const { batchId } = await applyOperations(OWNER, 'ZZ-фраза', [
      {
        type: 'create',
        title: 'ZZ-отчёт',
        date: THURSDAY,
        startMinute: null,
        durationMinutes: null,
        allDay: true,
        categoryId: null,
        recurrence: null,
        horizon: 'month',
      },
    ]);
    try {
      const rows = await sql`
        select date, horizon from tasks where user_id = ${OWNER} and title = 'ZZ-отчёт'
      `;
      expect(toIsoDate(rows[0].date)).toBe('2030-01-01');
      expect(rows[0].horizon).toBe('month');
    } finally {
      await undoBatch(OWNER, batchId);
      // Якорь месяца лежит вне диапазона, который чистит clean(). Отката
      // достаточно, но подстраховка адресная и дешёвая: строка не своего
      // диапазона переживёт прогон и станет «чужой» для предохранителя
      // в lib/ownership.test.ts.
      await sql`delete from tasks where user_id = ${OWNER} and title = 'ZZ-отчёт'`;
    }
  });

  it('откат удаления возвращает недельную задачу с её горизонтом, а не дневной', async () => {
    // Восстановление удалённой задачи — единственный путь, где строка в
    // undoBatch заводится заново вставкой из снимка, а не update по id.
    // Если забыть колонку horizon в списке insert, умолчание схемы
    // подставит 'day', и вернувшаяся задача молча уедет из недельного
    // чеклиста в сетку на понедельник.
    const { batchId: createdBatch } = await applyOperations(OWNER, 'ZZ-фраза', [
      {
        type: 'create',
        title: 'ZZ-удалённая неделя',
        date: FROM,
        startMinute: null,
        durationMinutes: null,
        allDay: true,
        categoryId: null,
        recurrence: null,
        horizon: 'week',
      },
    ]);
    const [row] = await sql`
      select id from tasks where user_id = ${OWNER} and title = 'ZZ-удалённая неделя'
    `;
    const { batchId: deleteBatch } = await applyOperations(OWNER, 'ZZ-фраза', [
      { type: 'delete', taskId: row.id as string },
    ]);
    try {
      expect(await undoBatch(OWNER, deleteBatch)).toBe(true);
      const [restored] = await sql`select date, horizon from tasks where id = ${row.id}`;
      expect(restored.horizon).toBe('week');
      expect(toIsoDate(restored.date)).toBe(FROM);
    } finally {
      await undoBatch(OWNER, createdBatch);
    }
  });

  it('правка переводит недельную задачу в конкретный день', async () => {
    // «Сделаю кран в четверг» — отдельной операции для этого не нужно.
    const created = await applyOperations(OWNER, 'ZZ-фраза', [
      {
        type: 'create',
        title: 'ZZ-перевод',
        date: FROM,
        startMinute: null,
        durationMinutes: null,
        allDay: true,
        categoryId: null,
        recurrence: null,
        horizon: 'week',
      },
    ]);
    const [row] = await sql`
      select id from tasks where user_id = ${OWNER} and title = 'ZZ-перевод'
    `;
    const updated = await applyOperations(OWNER, 'ZZ-фраза', [
      {
        type: 'update',
        taskId: row.id as string,
        title: null,
        date: THURSDAY,
        startMinute: 600,
        durationMinutes: 60,
        allDay: false,
        categoryId: null,
        horizon: 'day',
      },
    ]);
    try {
      const [after] = await sql`select date, horizon from tasks where id = ${row.id}`;
      // Главное утверждение: дата НЕ приведена к понедельнику, потому что
      // горизонт после правки дневной. Считай мы якорь от прежнего горизонта —
      // задача осталась бы на понедельнике и в чеклисте, и в сетке.
      expect(toIsoDate(after.date)).toBe(THURSDAY);
      expect(after.horizon).toBe('day');
    } finally {
      expect(await undoBatch(OWNER, updated.batchId)).toBe(true);
      // Откат живой задачи (не удалённой) идёт через on conflict do update,
      // а не через голую вставку выше по файлу. Без строки
      // "horizon = excluded.horizon" в этой ветке горизонт молча застрял бы
      // на 'day' из середины операции, а дата — на четверге: недельная
      // задача не нашлась бы ни в чеклисте, ни (с чужим горизонтом) в сетке.
      const [restored] = await sql`select date, horizon from tasks where id = ${row.id}`;
      expect(restored.horizon).toBe('week');
      expect(toIsoDate(restored.date)).toBe(FROM);
      await undoBatch(OWNER, created.batchId);
    }
  });

  it('правка называет только горизонт — якорь пересчитывается даже без смены даты', async () => {
    // «Сделай это на неделю» — период назван, дата нет. Пересчёт якоря
    // только при смене даты оставил бы дату на четверге с horizon = 'week' —
    // такая строка не находится НИ сеткой (там horizon = 'day'), НИ
    // чеклистом (там date обязана совпасть с якорем периода). Задача
    // исчезала бы из приложения целиком, молча.
    const { batchId: createdBatch } = await applyOperations(OWNER, 'ZZ-фраза', [
      {
        type: 'create',
        title: 'ZZ-только период',
        date: THURSDAY,
        startMinute: 600,
        durationMinutes: 60,
        allDay: false,
        categoryId: null,
        recurrence: null,
        horizon: null,
      },
    ]);
    const [row] = await sql`
      select id from tasks where user_id = ${OWNER} and title = 'ZZ-только период'
    `;
    const { batchId: updatedBatch } = await applyOperations(OWNER, 'ZZ-фраза', [
      {
        type: 'update',
        taskId: row.id as string,
        title: null,
        date: null,
        startMinute: null,
        durationMinutes: null,
        allDay: null,
        categoryId: null,
        horizon: 'week',
      },
    ]);
    try {
      const [after] = await sql`select date, horizon from tasks where id = ${row.id}`;
      expect(after.horizon).toBe('week');
      expect(toIsoDate(after.date)).toBe(FROM);
    } finally {
      await undoBatch(OWNER, updatedBatch);
      await undoBatch(OWNER, createdBatch);
    }
  });
});
