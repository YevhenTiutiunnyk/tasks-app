import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from './db';
import {
  getExceptions,
  getRecurrences,
  getSettings,
  getTasksBetween,
  getTimezone,
  saveSettings,
  saveTimezone,
} from './db';
import { DEFAULT_SETTINGS } from './settings-defaults';
import { loadRange, loadWeek } from './week';

// Тестовые пользователи заводятся в БОЕВОЙ таблице "user" — другой базы нет.
// Домен .invalid зарезервирован стандартом и не может принадлежать человеку.
const A = 'zz-owner-a@example.invalid';
const B = 'zz-owner-b@example.invalid';
// Диапазон 2030 года — как в lib/apply.test.ts, чтобы не пересечься с живыми.
// Оба понедельника: правило с weekdays [1] попадает ровно на них.
const DATE = '2030-03-04';
const NEXT = '2030-03-11';

// Как в lib/db.test.ts и lib/apply.test.ts: без строки подключения файл
// пропускается, а не падает на первом же запросе. Полный прогон становится
// возможен в задаче 6, и к нему это должно быть уже верно.
const run = process.env.DATABASE_URL ? describe : describe.skip;

let idA = '';
let idB = '';
let ruleA = '';
let ruleB = '';

// Настройки B заметно отличаются от умолчаний. Это не декорация: тест
// «у нового человека — умолчания» без чужой строки в таблице прошёл бы
// и при потерянном where, потому что сравнивать было бы не с чем.
const SETTINGS_B = {
  workStartMinute: 300,
  workEndMinute: 1200,
  aboutMe: 'ZZ-только для B',
  categories: [{ id: 'zz', name: 'ZZ', color: '#000000' }],
  notifyBeforeMinutes: 45,
};

/** Убрать за собой. Отдельной функцией, потому что нужна и до, и после. */
async function clean() {
  // Порядок продиктован ссылками: исключения висят на правилах, а настройки
  // и всё остальное — на пользователе с on delete restrict.
  await sql`delete from recurrence_exceptions where recurrence_id in (
    select id from recurrences where user_id in (${idA}, ${idB})
  )`;
  await sql`delete from tasks where user_id in (${idA}, ${idB})`;
  await sql`delete from recurrences where user_id in (${idA}, ${idB})`;
  await sql`delete from user_settings where user_id in (${idA}, ${idB})`;
  await sql`delete from "user" where email in (${A}, ${B})`;
}

run('изоляция чтения', () => {
  beforeAll(async () => {
    idA = A;
    idB = B;
    // Чистка ДО, а не только после: жёсткий обрыв прогона оставит двух лишних
    // в "user", и это не косметика — getSoleUserId вернёт null и планировщик
    // молча замолчит, а предохранитель «ровно одна строка» в фазах 2 и 3
    // миграции откажется работать.
    await clean();

    for (const email of [A, B]) {
      await sql`
        insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${email}, ${email}, ${email}, false, now(), now())
        on conflict (id) do nothing
      `;
    }
    await sql`
      insert into tasks (title, date, all_day, user_id)
      values ('ZZ-задача A', ${DATE}, true, ${idA}), ('ZZ-задача B', ${DATE}, true, ${idB})
    `;

    // По правилу на каждого, оба по понедельникам, и обоим — исключение
    // на второй понедельник. Симметрия нарочная: перепутанный фильтр вернёт
    // не пусто, а чужое, и это заметно только при сравнении названий.
    const [rowA] = await sql`
      insert into recurrences (title, weekdays, start_minute, duration_minutes, starts_on, user_id)
      values ('ZZ-правило A', ${[1]}, 600, 60, ${DATE}, ${idA}) returning id
    `;
    const [rowB] = await sql`
      insert into recurrences (title, weekdays, start_minute, duration_minutes, starts_on, user_id)
      values ('ZZ-правило B', ${[1]}, 600, 60, ${DATE}, ${idB}) returning id
    `;
    ruleA = rowA.id;
    ruleB = rowB.id;
    await sql`
      insert into recurrence_exceptions (recurrence_id, date)
      values (${ruleA}, ${NEXT}), (${ruleB}, ${NEXT})
    `;

    // Строка настроек есть только у B: A остаётся «новым человеком».
    await saveSettings(idB, SETTINGS_B);
  });

  afterAll(async () => {
    // Только свои строки. delete без условий здесь стоил бы владельцу расписания.
    await clean();
    await sql.end();
  });

  it('задачи одного не видны другому', async () => {
    const forA = await getTasksBetween(idA, DATE, DATE);
    expect(forA.map((t) => t.title)).toEqual(['ZZ-задача A']);
    const forB = await getTasksBetween(idB, DATE, DATE);
    expect(forB.map((t) => t.title)).toEqual(['ZZ-задача B']);
  });

  it('правила повтора одного не видны другому', async () => {
    expect((await getRecurrences(idA)).map((r) => r.title)).toEqual(['ZZ-правило A']);
    expect((await getRecurrences(idB)).map((r) => r.title)).toEqual(['ZZ-правило B']);
  });

  it('исключения фильтруются через правило, а не через свою колонку', async () => {
    // У recurrence_exceptions своей колонки владельца нет — фильтр держится
    // на соединении с recurrences. Ошибись в нём, и вычеркнутое одним
    // занятие исчезло бы из календаря другого.
    expect(await getExceptions(idA)).toEqual([{ recurrenceId: ruleA, date: NEXT }]);
    expect(await getExceptions(idB)).toEqual([{ recurrenceId: ruleB, date: NEXT }]);
  });

  it('в диапазон попадают свои задачи и свои раскрытые повторы', async () => {
    // Первый понедельник: своя разовая задача плюс раскрытое вхождение
    // своего правила. Второй — пусто: на него стоит исключение.
    const forA = await loadRange(idA, DATE, NEXT);
    expect(forA.map((t) => `${t.date} ${t.title}`)).toEqual([
      `${DATE} ZZ-задача A`,
      `${DATE} ZZ-правило A`,
    ]);
    const forB = await loadRange(idB, DATE, NEXT);
    expect(forB.map((t) => `${t.date} ${t.title}`)).toEqual([
      `${DATE} ZZ-задача B`,
      `${DATE} ZZ-правило B`,
    ]);
  });

  it('неделя собирается из своих задач и своих настроек', async () => {
    const week = await loadWeek(idB, DATE);
    expect(week.tasks.map((t) => t.title)).toEqual(['ZZ-задача B', 'ZZ-правило B']);
    expect(week.settings.aboutMe).toBe(SETTINGS_B.aboutMe);
  });

  it('без своей строки настройки — умолчания, а не чужие', async () => {
    // Строка есть у B и заметно отличается от умолчаний. Потеряй getSettings
    // фильтр — сюда пришли бы значения B, а не эти.
    const forA = await getSettings(idA);
    expect(forA.workStartMinute).toBe(540);
    expect(forA.workEndMinute).toBe(1080);
    expect(forA.aboutMe).toBe('');
    expect(forA.notifyBeforeMinutes).toBe(15);
    expect(forA.categories.map((c) => c.id)).toContain('work');
    expect(forA).toEqual(DEFAULT_SETTINGS);
  });

  it('сохранённые настройки не протекают к другому', async () => {
    await saveSettings(idA, { ...DEFAULT_SETTINGS, aboutMe: 'ZZ-только для A' });
    expect((await getSettings(idA)).aboutMe).toBe('ZZ-только для A');
    expect((await getSettings(idB)).aboutMe).toBe(SETTINGS_B.aboutMe);
  });

  it('пояс одного не виден другому', async () => {
    // Пояса заданы РАЗНЫЕ, и проверяются оба. Это не для симметрии:
    // getTimezone берёт первую строку без order by, и при потерянном фильтре
    // запрос вернёт произвольную из двух. Проверка «у B не Токио» тогда
    // падала бы или проходила по физическому порядку строк в куче, а не по
    // логике. С двумя разными ожиданиями оба вызова вернут одно значение,
    // и хотя бы одно ожидание не сойдётся при любом порядке.
    await saveTimezone(idA, 'Asia/Tokyo');
    await saveTimezone(idB, 'America/Bogota');
    expect(await getTimezone(idA)).toBe('Asia/Tokyo');
    expect(await getTimezone(idB)).toBe('America/Bogota');
  });

  it('сохранение настроек не затирает присланный телефоном пояс', async () => {
    // Самое хрупкое место подпроекта. Пояс держится ровно на том, что
    // timezone НЕ перечислен в do update set у saveSettings: экран настроек
    // его не редактирует, а Settings его не содержит. Допиши его туда
    // «для полноты» — и каждое сохранение настроек будет откатывать пояс
    // к умолчанию. Тест затем и стоит, чтобы такая правка покраснела.
    await saveTimezone(idA, 'Asia/Tokyo');
    await saveSettings(idA, { ...DEFAULT_SETTINGS, aboutMe: 'ZZ-проверка пояса' });
    expect(await getTimezone(idA)).toBe('Asia/Tokyo');
  });
});
