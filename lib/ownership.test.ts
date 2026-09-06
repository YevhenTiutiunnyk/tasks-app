import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from './db';
import {
  addSubscription,
  clearUserKey,
  getChecklistTasks,
  getExceptions,
  getLatestReport,
  getNotifiableUsers,
  getRecurrences,
  getSettings,
  getSubscriptions,
  getTasksBetween,
  getTimezone,
  getUserKey,
  getWeekSnapshot,
  removeSubscription,
  saveReport,
  saveSettings,
  saveTimezone,
  saveUserKey,
  saveWeekSnapshot,
} from './db';
import { decryptApiKey, encryptApiKey } from './user-key';
import { DEFAULT_SETTINGS, DEFAULT_TIMEZONE } from './settings-defaults';
import { loadRange, loadWeek } from './week';
import { applyOperations, undoBatch } from './apply';
import { addDays } from './dates';
import { nowInZone } from './notify';

// Владельца запроса в роутах даёт сессия better-auth. Поднимать её ради
// проверки фильтров в SQL незачем — подменяем помощника целиком и называем
// владельца прямо в тесте. vi.hoisted нужен потому, что vi.mock поднимается
// выше импортов: фабрика не увидела бы обычную переменную модуля.
const session = vi.hoisted(() => ({ userId: '' }));
vi.mock('./require-user', () => ({
  requireUser: async () => ({ userId: session.userId }),
}));

// Разбор уточнения ходит в модель. Здесь важно не что он ответит, а был ли
// он вызван вообще: по чужой задаче до него дойти не должно.
//
// queue — очередь заготовленных исходов, по одному на вызов: 'ok' (или
// пусто, когда очередь исчерпана) — обычный успешный разбор; {} — бросок без
// status (беда одного ответа); {status} — бросок с status (ошибка самого
// Anthropic, общая для всех ответов). Нужна только тесту про Minor 3 ниже —
// остальные тесты очередь не трогают, и для них поведение не изменилось.
const clarify = vi.hoisted(() => ({
  calls: 0,
  queue: [] as Array<'ok' | { status?: number }>,
}));
vi.mock('./parse-clarify', () => ({
  parseClarification: async () => {
    clarify.calls += 1;
    const next = clarify.queue.shift();
    if (next && next !== 'ok') {
      const error = new Error('ZZ-имитация сбоя разбора') as Error & { status?: number };
      if (next.status !== undefined) error.status = next.status;
      throw error;
    }
    return { date: '2030-03-04', startMinute: 600, durationMinutes: 60 };
  },
}));

// Задача 7: роут команды теперь собирает контекст для модели из двух
// источников — расписания (loadRange) и чеклистов (getChecklistTasks по
// week/month). До этой подмены единственный тест роута команды упирался
// в путь «нет ключа» и до сбора contextTasks не доходил вовсе — несущая
// правка держалась только на чтении глазами. Настоящую модель не зовём:
// перехватываем input.tasks и смотрим, что реально в нём оказалось.
const parseSpy = vi.hoisted(() => ({
  lastTasks: null as null | { title: string; horizon: string }[],
}));
vi.mock('./parse', () => ({
  parseCommand: async (
    _client: unknown,
    input: { tasks: { title: string; horizon: string }[] },
  ) => {
    parseSpy.lastTasks = input.tasks;
    return { operations: [], needsTime: [], reply: 'ZZ-ok' };
  },
}));

// web-push реально стучится к push-серверам браузеров. В проверке
// планировщика важно не что ответит провайдер, а КОМУ ушла отправка —
// подменяем модуль целиком и записываем endpoint и тело каждого вызова.
// failWith позволяет отдельным тестам заставить конкретный endpoint
// «отказать» с нужным статусом — так проверяется путь очистки мёртвой
// подписки, не поднимая настоящий сервис push-уведомлений.
const pushed = vi.hoisted(() => ({
  calls: [] as { endpoint: string; payload: string }[],
  failWith: new Map<string, number>(),
}));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (
      subscription: { endpoint: string },
      payload: string,
    ) => {
      pushed.calls.push({ endpoint: subscription.endpoint, payload });
      const statusCode = pushed.failWith.get(subscription.endpoint);
      if (statusCode !== undefined) {
        const error = new Error('ZZ-имитация сбоя доставки') as Error & { statusCode?: number };
        error.statusCode = statusCode;
        throw error;
      }
    },
  },
}));

// Подмена нужна ровно одному тесту — проверке, что роут читает часовой пояс
// именно текущего владельца, а не соседнего. Через реальное время это не
// проверить надёжно: разница поясов должна быть огромной, чтобы гарантированно
// увести дату мимо окна loadRange, а такая разница считается от момента
// запуска и плавает. Подмена частичная (importOriginal) — normalizeTimezone
// и selectDue остаются настоящими, подменяется только nowInZone, и то лишь
// для зон, явно занесённых в zoneOverrides; 'UTC' и остальные идут как есть.
const zoneOverrides = vi.hoisted(() => ({
  map: new Map<string, { today: string; nowMinute: number }>(),
}));
vi.mock('./notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notify')>();
  return {
    ...actual,
    nowInZone: (timezone: string, at?: Date) => {
      const override = zoneOverrides.map.get(timezone);
      return override ?? actual.nowInZone(timezone, at);
    },
  };
});

// Роуты импортируются после vi.mock намеренно: подмена должна быть объявлена
// раньше, чем модуль роута потянет за собой настоящий require-user.
import { PATCH as taskPatch, DELETE as taskDelete } from '@/app/api/task/route';
import { POST as clarifyPost } from '@/app/api/clarify/route';
import { POST as commandPost } from '@/app/api/command/route';
import { POST as undoPost } from '@/app/api/undo/route';
import { POST as pushPost, DELETE as pushDelete } from '@/app/api/push/route';
import { POST as notifyPost } from '@/app/api/notify/route';
import { GET as checklistGet } from '@/app/api/checklist/route';

// Тестовые пользователи заводятся в отдельной тестовой базе (TEST_DATABASE_URL,
// см. vitest.setup.ts) — таблица "user" здесь не боевая, а поднятая
// scripts/test-db.sh заново на каждый прогон миграций.
// Домен .invalid зарезервирован стандартом и не может принадлежать человеку.
const A = 'zz-owner-a@example.invalid';
const B = 'zz-owner-b@example.invalid';
// Адрес B в "user" — в смешанном регистре, а его id (заводится в beforeAll)
// разведён с самим адресом. Иначе тест не отличил бы верное соединение
// getNotifiableUsers (join allowed_emails a on a.email = lower(u.email))
// от испорченного: в бою id Better Auth — случайный токен, а не адрес, и
// без lower() адрес с заглавной не совпал бы с закреплённым нижним
// регистром allowed_emails. При id = email = один и тот же нижнерегистровый
// текст (как было раньше) обе порчи остаются незамеченными — ровно тот же
// класс дефекта, что нашёлся и был исправлен в lib/proxy-gate.test.ts
// (коммит d2eb873).
const B_MIXED_CASE_EMAIL = 'zz-owner-B@example.invalid';
// Третий нужен ровно для одного случая: человек, у которого строки настроек
// нет вовсе. У A и B она к тому моменту уже есть, а путь «телефон прислал
// пояс раньше, чем настройки хоть раз сохранили» — это первая команда
// любого нового человека, и без C он не проверялся бы ничем.
const C = 'zz-owner-c@example.invalid';
// Диапазон 2030 года — как в lib/apply.test.ts, чтобы не пересечься с живыми.
// Оба понедельника: правило с weekdays [1] попадает ровно на них.
const DATE = '2030-03-04';
const NEXT = '2030-03-11';
// Ещё два понедельника той же серии — для материализации вхождений. На NEXT
// у обоих правил стоит исключение, поэтому брать его для этих проверок нельзя.
const THIRD = '2030-03-18';
const FOURTH = '2030-03-25';
// Отдельная дата под откат удаления: соседние проверки считают задачи
// на FOURTH поимённо, и восстановленная строка сбивала бы им счёт.
const FIFTH = '2030-04-01';

// Как в lib/db.test.ts и lib/apply.test.ts: без строки подключения файл
// пропускается, а не падает на первом же запросе. Полный прогон становится
// возможен в задаче 6, и к нему это должно быть уже верно.
const run = process.env.DATABASE_URL ? describe : describe.skip;

let idA = '';
let idB = '';
let idC = '';
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
  // Журнал чистится здесь, а не только в afterAll: у command_log.user_id
  // ссылка на "user" с on delete restrict, и оставшаяся от оборванного
  // прогона запись не дала бы удалить пользователя уже в beforeAll.
  await sql`delete from command_log where user_id in (${idA}, ${idB}, ${idC})`;
  await sql`delete from recurrence_exceptions where recurrence_id in (
    select id from recurrences where user_id in (${idA}, ${idB}, ${idC})
  )`;
  await sql`delete from tasks where user_id in (${idA}, ${idB}, ${idC})`;
  await sql`delete from recurrences where user_id in (${idA}, ${idB}, ${idC})`;
  await sql`delete from user_settings where user_id in (${idA}, ${idB}, ${idC})`;
  // Каскад на push_subscriptions.user_id снял бы эти строки и сам при
  // удалении "user" ниже, но чистим явно — как и остальные таблицы здесь,
  // чтобы порядок был виден и не зависел от свойств внешнего ключа.
  await sql`delete from push_subscriptions where user_id in (${idA}, ${idB}, ${idC})`;
  await sql`delete from week_snapshots where user_id in (${idA}, ${idB}, ${idC})`;
  // По id, а не по адресу: у B в "user" адрес в смешанном регистре и не
  // совпадает с константой B, которой чистка ниже (allowed_emails) и так
  // пользуется по адресу законно — там регистр закреплён ограничением.
  // Чистка по email in (A, B, C) молча перестала бы находить B, и следующий
  // прогон споткнулся бы на on conflict (id) do nothing при повторной вставке.
  await sql`delete from "user" where id in (${idA}, ${idB}, ${idC})`;

  // А теперь — ничьи строки, по названию, а не по владельцу. Так убирается
  // ровно тот мусор, который оставляет регресс владельца, пойманный этими же
  // тестами: потерянная колонка в insert заводит строку с user_id is null,
  // и чистка по `user_id in (A, B, C)` её не видит. Пользователи при этом
  // удаляются успешно — ничья строка внешним ключом их не держит, и мусор
  // остаётся в базе незамеченным.
  //
  // Цена оставленной строки — не косметика. Фаза 3 миграции делает
  // `update tasks set user_id = (select id from "user") where user_id is null`
  // и молча припишет забытую ZZ-строку в расписание живого человека.
  // Предохранитель «ровно одна строка в user» тут не спасёт: он к этому
  // моменту уже отработал.
  await sql`delete from tasks where user_id is null and title like 'ZZ-%'`;
  await sql`delete from recurrence_exceptions where recurrence_id in (
    select id from recurrences where user_id is null and title like 'ZZ-%'
  )`;
  await sql`delete from recurrences where user_id is null and title like 'ZZ-%'`;
  await sql`delete from command_log where user_id is null and text like 'ZZ-%'`;
  await sql`delete from push_subscriptions where user_id is null and endpoint like 'https://zz.invalid/%'`;
}

// Один внешний блок на чтение и на запись: пользователи, задачи и правила
// заводятся один раз, и sql.end() тоже один — вынеси запись отдельным
// describe верхнего уровня, и соединение закрылось бы до её первого запроса.
run('изоляция по владельцу', () => {
  beforeAll(async () => {
    idA = A;
    // Непрозрачный id, а не B: см. комментарий у объявления
    // B_MIXED_CASE_EMAIL выше — id обязан не совпадать текстуально
    // с адресом, иначе join по u.id «случайно» находил бы ту же строку,
    // что и верный join по адресу.
    idB = 'zz-owner-b-id';
    idC = C;

    // ПРЕДОХРАНИТЕЛЬ НА ВЕСЬ ФАЙЛ, и стоит он здесь не случайно.
    //
    // Обрезка журнала исполняется ВНУТРИ applyOperations, то есть при каждом
    // его вызове, а вызовов в этом файле больше десятка. Проверка «обрезка
    // журнала» стоит последней — если регресс фильтра владельца попадёт
    // в настоящий код, живой журнал сотрёт первый же ранний вызов, задолго
    // до неё. Поэтому периметр — весь файл, до первого applyOperations,
    // а не одна проверка в конце.
    //
    // Условие ровно одно: чужих записей в журнале быть не должно вовсе.
    // Порога по числу или возрасту недостаточно — потеря внешнего фильтра
    // при целом внутреннем превращает обрезку в «удалить всё, кроме своих
    // полусотни свежих», безразлично к тому и другому.
    //
    // Падает громко и намеренно: молча пропущенная защитная сетка хуже
    // красного прогона. Увидевший это должен сразу понять, что делать.
    const [foreign] = await sql`
      select count(*)::int c from command_log
      where user_id is distinct from ${idA}
        and user_id is distinct from ${idB}
        and user_id is distinct from ${idC}
    `;
    expect(
      foreign.c,
      `В command_log ${foreign.c} чужих записей — DATABASE_URL смотрит в боевую базу. `
      + 'Тесты владельца на ней не запускаются: applyOperations исполняет обрезку '
      + 'журнала при каждом вызове, и регресс фильтра владельца стёр бы эту историю '
      + 'отмены раньше, чем любая проверка успела бы сработать. Лечение: завести '
      + 'отдельную базу под тесты и указать её в TEST_DATABASE_URL. Это не '
      + 'недоделанная работа — это сработавший предохранитель.',
    ).toBe(0);

    // Чистка ДО, а не только после: жёсткий обрыв прогона оставит лишних
    // в "user", и это не косметика — предохранитель «ровно одна строка»
    // в фазах 2 и 3 миграции откажется работать.
    await clean();

    // C заводится только в "user": ни задач, ни правил, ни настроек —
    // в этом весь смысл, он остаётся человеком без строки в user_settings.
    //
    // У B — id и адрес разведены, и адрес вдобавок в смешанном регистре
    // (см. B_MIXED_CASE_EMAIL). У A и C id по-прежнему равен адресу — портить
    // сразу всех не нужно, достаточно одного, чтобы обе порчи из Important 1
    // финального ревью красили тест.
    for (const [id, email] of [[idA, A], [idB, B_MIXED_CASE_EMAIL], [idC, C]] as const) {
      await sql`
        insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${id}, ${id}, ${email}, false, now(), now())
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

    // Роут уточнения теперь требует ключ владельца. Ключ ненастоящий: разбор
    // подменён vi.mock, до Anthropic дело не доходит.
    for (const id of [idA, idB, idC]) {
      await saveUserKey(id, encryptApiKey(id, 'sk-ant-zz-ключ-для-теста-владельцев'));
    }

    // Планировщик теперь шлёт только тем, кто в белом списке. До этой правки
    // тест жил в мире, где он шлёт кому угодно, — мир изменился.
    // Адреса уже в нижнем регистре, а в allowed_emails он закреплён
    // ограничением check (email = lower(email)).
    for (const email of [A, B, C]) {
      await sql`
        insert into allowed_emails (email) values (${email}) on conflict (email) do nothing
      `;
    }
  });

  afterAll(async () => {
    await sql`delete from allowed_emails where email in (${A}, ${B}, ${C})`;
    // Явно и до удаления пользователей — не потому что внешний ключ иначе
    // не даст: user_api_keys.user_id объявлен on delete cascade (миграция
    // 0005) и снялся бы сам. Явная строка здесь для порядка, а не потому,
    // что каскад его требует.
    await sql`delete from user_api_keys where user_id in (${idA}, ${idB}, ${idC})`;
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

  it('hasKey в неделе отражает ключ владельца, а не соседа', async () => {
    // Восстановление — в finally: упади любой expect, idA остался бы без
    // ключа до конца прогона файла, и последующие тесты упали бы вторично,
    // маскируя первопричину каскадом.
    try {
      // Ключи всем трём владельцам завели в конце beforeAll (Task 7).
      expect((await loadWeek(idA, DATE)).hasKey).toBe(true);

      await clearUserKey(idA);
      expect((await loadWeek(idA, DATE)).hasKey).toBe(false);
      // Сосед своего ключа не терял — иначе hasKey читал бы не того владельца.
      expect((await loadWeek(idB, DATE)).hasKey).toBe(true);
    } finally {
      await saveUserKey(idA, encryptApiKey(idA, 'sk-ant-zz-ключ-для-теста-владельцев'));
    }
  });

  it('getUserKey не читает чужую строку, saveUserKey не затирает чужую', async () => {
    // Восстановление — в finally, как в соседнем тесте про hasKey.
    try {
      await saveUserKey(idA, encryptApiKey(idA, 'sk-ant-zz-ключ-A'));
      await saveUserKey(idB, encryptApiKey(idB, 'sk-ant-zz-ключ-B'));

      const rowA = await getUserKey(idA);
      const rowB = await getUserKey(idB);

      // getUserKey(idA) обязан расшифровываться ключом A: читай он строку
      // соседа, AAD-проверка decryptApiKey(idA, ...) на шифротексте B
      // провалилась бы и вернула null, а не совпадение с ключом B.
      expect(rowA?.sealed && decryptApiKey(idA, rowA.sealed)).toBe('sk-ant-zz-ключ-A');
      expect(rowB?.sealed && decryptApiKey(idB, rowB.sealed)).toBe('sk-ant-zz-ключ-B');

      // saveUserKey(idA, ...) не затёрло строку B — она всё ещё ключ B.
      expect(rowB?.sealed && decryptApiKey(idB, rowB.sealed)).not.toBe('sk-ant-zz-ключ-A');
    } finally {
      await saveUserKey(idA, encryptApiKey(idA, 'sk-ant-zz-ключ-для-теста-владельцев'));
      await saveUserKey(idB, encryptApiKey(idB, 'sk-ant-zz-ключ-для-теста-владельцев'));
    }
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

    // Равно — но не то же самое. DEFAULT_SETTINGS одна на весь процесс
    // сервера и общая на всех, у кого своей строки ещё нет; отданная по
    // ссылке, она превратила бы первую же мутацию у вызывающего в чужое
    // умолчание. Вложенное — тоже своё: categories это массив объектов.
    expect(forA).not.toBe(DEFAULT_SETTINGS);
    expect(forA.categories).not.toBe(DEFAULT_SETTINGS.categories);
    expect(forA.categories[0]).not.toBe(DEFAULT_SETTINGS.categories[0]);
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

  it('пояс сохраняется, когда строки настроек ещё нет', async () => {
    // Путь первой команды нового человека: телефон присылает пояс раньше,
    // чем настройки хоть раз сохраняли, — строку заводит сам saveTimezone.
    // У A и B строка к этому моменту уже есть, поэтому ветка вставки без
    // отдельного человека не проверялась бы вовсе.
    expect(await getTimezone(idC)).toBe(DEFAULT_TIMEZONE);
    await saveTimezone(idC, 'Pacific/Auckland');
    expect(await getTimezone(idC)).toBe('Pacific/Auckland');
    // Остальные колонки новой строки — умолчания, а не выдумка на месте.
    expect(await getSettings(idC)).toEqual(DEFAULT_SETTINGS);
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

  describe('горизонт: недельные и месячные задачи вне расписания', () => {
    // Понедельник, вокруг которого крутится весь блок, — та же DATE, что
    // объявлена выше в файле; отдельная константа с тем же значением была
    // бы третьей копией одной и той же даты.

    async function makeTask(userId: string, title: string, date: string, horizon: string) {
      const [row] = await sql`
        insert into tasks (title, date, all_day, horizon, user_id)
        values (${title}, ${date}, true, ${horizon}, ${userId})
        returning id
      `;
      return row.id as string;
    }

    it('недельная задача не попадает в сетку расписания', async () => {
      const id = await makeTask(idA, 'ZZ-кран', DATE, 'week');
      try {
        const week = await loadWeek(idA, DATE);
        // Якорь недельной задачи — тот самый понедельник, поэтому без фильтра
        // она встала бы в сетку первым же днём и выглядела бы как задача,
        // которую кто-то переставил на понедельник.
        expect(week.tasks.map((t) => t.title)).not.toContain('ZZ-кран');
      } finally {
        await sql`delete from tasks where id = ${id}`;
      }
    });

    it('месячная задача не попадает в сетку расписания', async () => {
      const id = await makeTask(idA, 'ZZ-отчёт', '2030-03-01', 'month');
      try {
        const week = await loadWeek(idA, '2030-03-01');
        expect(week.tasks.map((t) => t.title)).not.toContain('ZZ-отчёт');
      } finally {
        await sql`delete from tasks where id = ${id}`;
      }
    });

    it('недельная задача не попадает в выборку для напоминаний', async () => {
      // Отдельный тест, а не «то же самое другими словами»: планировщик
      // ходит в loadRange напрямую, минуя loadWeek. Один тест на общую
      // функцию доказал бы сам фильтр, но не то, что оба пути через него
      // проходят, — а именно это здесь и проверяется.
      const id = await makeTask(idA, 'ZZ-кран-напоминание', DATE, 'week');
      try {
        const tasks = await loadRange(idA, DATE, DATE);
        expect(tasks.map((t) => t.title)).not.toContain('ZZ-кран-напоминание');
      } finally {
        await sql`delete from tasks where id = ${id}`;
      }
    });

    it('дневная задача на том же дне по-прежнему видна', async () => {
      // Обратная сторона: фильтр не должен вырезать вообще всё. Без этого
      // теста реализация «отдавать пустой список» прошла бы три теста выше.
      const id = await makeTask(idA, 'ZZ-обычная', DATE, 'day');
      try {
        const week = await loadWeek(idA, DATE);
        expect(week.tasks.map((t) => t.title)).toContain('ZZ-обычная');
      } finally {
        await sql`delete from tasks where id = ${id}`;
      }
    });

    it('горизонт доезжает до объекта задачи', async () => {
      const id = await makeTask(idA, 'ZZ-горизонт', DATE, 'day');
      try {
        const week = await loadWeek(idA, DATE);
        const task = week.tasks.find((t) => t.title === 'ZZ-горизонт');
        expect(task?.horizon).toBe('day');
      } finally {
        await sql`delete from tasks where id = ${id}`;
      }
    });
  });

  describe('getChecklistTasks', () => {
    // DATE — та же дата, что использует и блок горизонтов выше;
    // переиспользуем константу файла вместо второй копии того же понедельника.

    async function makeTask(userId: string, title: string, date: string, horizon: string) {
      const [row] = await sql`
        insert into tasks (title, date, all_day, horizon, user_id)
        values (${title}, ${date}, true, ${horizon}, ${userId})
        returning id
      `;
      return row.id as string;
    }

    it('отдаёт задачи своего горизонта и не отдаёт чужого', async () => {
      const week = await makeTask(idA, 'ZZ-неделя', DATE, 'week');
      const month = await makeTask(idA, 'ZZ-месяц', '2030-03-01', 'month');
      // Дневная задача заведена на тот же DATE, что и недельная: месячная
      // отсекается ещё и датой (её якорь — 1 марта), а эта — только
      // горизонтом. Без неё фильтр `horizon` можно было бы выкинуть из
      // запроса незаметно — тест остался бы зелёным на одной дате.
      const day = await makeTask(idA, 'ZZ-день', DATE, 'day');
      try {
        const titles = (await getChecklistTasks(idA, 'week', DATE)).map((t) => t.title);
        expect(titles).toContain('ZZ-неделя');
        expect(titles).not.toContain('ZZ-месяц');
        expect(titles).not.toContain('ZZ-день');
      } finally {
        await sql`delete from tasks where id in (${week}, ${month}, ${day})`;
      }
    });

    it('чужие задачи не попадают', async () => {
      // Тот же рубеж, что и во всех остальных запросах после второго
      // подпроекта: без where по владельцу сосед увидел бы чужой чеклист.
      const mine = await makeTask(idA, 'ZZ-моё', DATE, 'week');
      const theirs = await makeTask(idB, 'ZZ-соседа', DATE, 'week');
      try {
        const titles = (await getChecklistTasks(idA, 'week', DATE)).map((t) => t.title);
        expect(titles).toContain('ZZ-моё');
        expect(titles).not.toContain('ZZ-соседа');
      } finally {
        await sql`delete from tasks where id in (${mine}, ${theirs})`;
      }
    });

    it('задача прошлой недели остаётся в своей неделе', async () => {
      // Решение спеки «не сделал — значит не сделал» держится только этим
      // тестом. Без него автоперенос можно было бы завести незаметно.
      const past = await makeTask(idA, 'ZZ-прошлая', '2030-02-25', 'week');
      try {
        const current = (await getChecklistTasks(idA, 'week', DATE)).map((t) => t.title);
        expect(current).not.toContain('ZZ-прошлая');

        const own = (await getChecklistTasks(idA, 'week', '2030-02-25')).map((t) => t.title);
        expect(own).toContain('ZZ-прошлая');
      } finally {
        await sql`delete from tasks where id = ${past}`;
      }
    });

    it('якорь приводится к началу периода', async () => {
      // Зовущий может передать любую дату внутри периода — например,
      // сегодняшнюю. Без приведения запрос искал бы задачи с date = четверг
      // и не нашёл бы ничего.
      const id = await makeTask(idA, 'ZZ-якорь', DATE, 'week');
      try {
        const titles = (await getChecklistTasks(idA, 'week', '2030-03-07')).map((t) => t.title);
        expect(titles).toContain('ZZ-якорь');
      } finally {
        await sql`delete from tasks where id = ${id}`;
      }
    });
  });

  /** Разовая задача A из beforeAll — опора для проверок «чужое не трогается». */
  async function taskOfA() {
    const [row] = await sql`
      select id, title, done from tasks where user_id = ${idA} and title = 'ZZ-задача A'
    `;
    return row;
  }

  function createOp(title: string, date: string) {
    return {
      type: 'create' as const,
      title,
      date,
      startMinute: null,
      durationMinutes: null,
      allDay: true,
      categoryId: null,
      recurrence: null,
      horizon: null,
    };
  }

  describe('изоляция записи', () => {
    it('правка по чужому идентификатору не задевает ни строки', async () => {
      const [mine] = await sql`
        select id from tasks where user_id = ${idB} and date = ${DATE}
      `;
      const changed = await sql`
        update tasks set title = 'ZZ-угнано' where id = ${mine.id} and user_id = ${idA}
      `;
      expect(changed.count).toBe(0);
      const [after] = await sql`select title from tasks where id = ${mine.id}`;
      expect(after.title).toBe('ZZ-задача B');
    });

    it('созданное одной пачкой достаётся только её владельцу', async () => {
      // Задача и правило разом: колонка владельца добавляется в обе вставки,
      // и потерянная в любой из них видна здесь, а не только на бою.
      const { batchId } = await applyOperations(idA, 'ZZ-создание A', [
        createOp('ZZ-новая A', FOURTH),
        {
          type: 'create',
          title: 'ZZ-новое правило A',
          date: null,
          startMinute: 480,
          durationMinutes: 60,
          allDay: false,
          categoryId: null,
          recurrence: { weekdays: [3], startsOn: FOURTH, endsOn: null },
          horizon: null,
        },
      ]);

      // Уборка — в finally: без него одно падение здесь превращается в три.
      // Правило из этой пачки остаётся в базе, и его подхватывают два более
      // поздних теста отката, считающие правила владельца A поимённо.
      try {
        expect((await getTasksBetween(idA, FOURTH, FOURTH)).map((t) => t.title))
          .toEqual(['ZZ-новая A']);
        expect(await getTasksBetween(idB, FOURTH, FOURTH)).toEqual([]);
        // Сравнение как множеств, а не по порядку. Порядок строк getRecurrences
        // не определён ничем: select без order by отдаёт их в физическом
        // порядке кучи, а clean() в beforeAll освобождает слоты, которые FSM
        // потом переиспользует, — вставленное позже правило может лечь раньше
        // вставленного раньше. Утверждение toEqual([...]) на точный порядок
        // проверяло не владельца, а везение: примерно раз в тридцать полных
        // прогонов оно краснело на ровном месте. Здесь важно, ЧТО досталось
        // владельцу, а не в каком порядке база решила это вернуть.
        expect((await getRecurrences(idA)).map((r) => r.title).sort())
          .toEqual(['ZZ-новое правило A', 'ZZ-правило A']);
        expect((await getRecurrences(idB)).map((r) => r.title)).toEqual(['ZZ-правило B']);
      } finally {
        await undoBatch(idA, batchId);
      }
    });

    it('откат видит только свои пачки', async () => {
      // У варианта create в типе Operation обязательны все восемь полей —
      // необязательных там нет, частичный объект не скомпилируется.
      // Задача и правило в одной пачке: откат разбирает их разными ветками
      // (снимок tasks и снимок recurrences), и уцелеть должны обе.
      const { batchId } = await applyOperations(idA, 'ZZ-пачка A', [
        {
          type: 'create',
          title: 'ZZ-из пачки A',
          date: DATE,
          startMinute: null,
          durationMinutes: null,
          allDay: true,
          categoryId: null,
          recurrence: null,
          horizon: null,
        },
        {
          type: 'create',
          title: 'ZZ-правило из пачки A',
          date: null,
          startMinute: 480,
          durationMinutes: 60,
          allDay: false,
          categoryId: null,
          recurrence: { weekdays: [3], startsOn: FOURTH, endsOn: null },
          horizon: null,
        },
      ]);
      // Чужой идентификатор пачки не должен откатываться под другим владельцем.
      const undoneByB = await undoBatch(idB, batchId);

      // Про строки спрашиваем раньше, чем про ответ, и это не косметика.
      // Откат, который отчитался «не моё», но успел пройтись по снимку, унёс бы
      // задачу и правило молча. Проверь сперва ответ — тест упал бы на «true
      // вместо false», и по такому сообщению не понять, пропало что-то или нет.
      expect((await getTasksBetween(idA, DATE, DATE)).map((t) => t.title))
        .toContain('ZZ-из пачки A');
      expect((await getRecurrences(idA)).map((r) => r.title))
        .toContain('ZZ-правило из пачки A');
      expect(undoneByB).toBe(false);

      expect(await undoBatch(idA, batchId)).toBe(true);
      expect((await getTasksBetween(idA, DATE, DATE)).map((t) => t.title))
        .not.toContain('ZZ-из пачки A');
      expect((await getRecurrences(idA)).map((r) => r.title))
        .not.toContain('ZZ-правило из пачки A');
    });

    it('откат удаления возвращает задачу владельцу, а не в никуда', async () => {
      // Единственный путь, где строка задачи заводится заново, а не правится:
      // откат удаления вставляет её из снимка. Владельца снимок не хранит —
      // забудь колонку в этой вставке, и задача вернётся ничьей: её не увидит
      // и тот, кто нажал «отменить», причём молча.
      await applyOperations(idA, 'ZZ-создать под удаление', [createOp('ZZ-вернётся', FIFTH)]);
      const [created] = await getTasksBetween(idA, FIFTH, FIFTH);
      const { batchId } = await applyOperations(idA, 'ZZ-удалить', [
        { type: 'delete', taskId: created.id },
      ]);
      expect(await getTasksBetween(idA, FIFTH, FIFTH)).toEqual([]);

      expect(await undoBatch(idA, batchId)).toBe(true);
      expect((await getTasksBetween(idA, FIFTH, FIFTH)).map((t) => t.id)).toEqual([created.id]);
      expect(await getTasksBetween(idB, FIFTH, FIFTH)).toEqual([]);
    });

    it('правка чужой задачи не проходит и отвечает как на несуществующую', async () => {
      const task = await taskOfA();
      await expect(
        applyOperations(idB, 'ZZ-угон правкой', [
          {
            type: 'update', taskId: task.id, title: 'ZZ-угнано', date: null,
            startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
            horizon: null,
          },
        ]),
      ).rejects.toThrow();
      expect((await taskOfA()).title).toBe('ZZ-задача A');
    });

    it('удаление чужой задачи не проходит', async () => {
      const task = await taskOfA();
      await expect(
        applyOperations(idB, 'ZZ-угон удалением', [{ type: 'delete', taskId: task.id }]),
      ).rejects.toThrow();
      expect(await taskOfA()).toBeDefined();
    });

    it('чужое вхождение серии не материализуется', async () => {
      // Самое дорогое из возможного: без владельца в выборке правила B создал бы
      // себе задачу от правила A и заодно поставил бы на неё исключение —
      // занятие пропало бы из календаря A само собой.
      await expect(
        applyOperations(idB, 'ZZ-угон серии', [
          {
            type: 'update', taskId: `occ:${ruleA}:${THIRD}`, title: 'ZZ-угнано', date: null,
            startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
            horizon: null,
          },
        ]),
      ).rejects.toThrow();
      const [exceptions] = await sql`
        select count(*)::int c from recurrence_exceptions
        where recurrence_id = ${ruleA} and date = ${THIRD}
      `;
      expect(exceptions.c).toBe(0);
      const [spawned] = await sql`
        select count(*)::int c from tasks where recurrence_id = ${ruleA}
      `;
      expect(spawned.c).toBe(0);
    });

    it('своё вхождение материализуется с владельцем', async () => {
      await applyOperations(idA, 'ZZ-перенос вхождения', [
        {
          type: 'update', taskId: `occ:${ruleA}:${THIRD}`, title: 'ZZ-своё вхождение',
          date: null, startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
          horizon: null,
        },
      ]);
      expect((await getTasksBetween(idA, THIRD, THIRD)).map((t) => t.title))
        .toEqual(['ZZ-своё вхождение']);
      // Без владельца в insert строка не принадлежала бы никому и пропала бы
      // из календаря самого A — а не только осталась бы невидимой для B.
      expect(await getTasksBetween(idB, THIRD, THIRD)).toEqual([]);
    });

    it('уже материализованное чужое вхождение не подхватывается', async () => {
      // Продолжение предыдущего: задача от правила A теперь существует, и поиск
      // «уже материализовано?» нашёл бы её и без фильтра по владельцу.
      await expect(
        applyOperations(idB, 'ZZ-угон материализованного', [
          {
            type: 'update', taskId: `occ:${ruleA}:${THIRD}`, title: 'ZZ-угнано', date: null,
            startMinute: null, durationMinutes: null, allDay: null, categoryId: null,
            horizon: null,
          },
        ]),
      ).rejects.toThrow();
      expect((await getTasksBetween(idA, THIRD, THIRD)).map((t) => t.title))
        .toEqual(['ZZ-своё вхождение']);
    });
  });

  describe('изоляция записи в роутах', () => {
    function request(url: string, method: string, body: unknown) {
      return new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('«выполнено» по чужой задаче ничего не меняет', async () => {
      const task = await taskOfA();
      expect(task.done).toBe(false);
      session.userId = idB;
      const response = await taskPatch(
        request('http://t/api/task', 'PATCH', { today: DATE, taskId: task.id, done: true }),
      );
      expect(response.status).toBe(200);
      expect((await taskOfA()).done).toBe(false);

      // Контроль на то, что путь живой — как в проверке уточнения ниже.
      // Без него регресс, превращающий роут в no-op ДЛЯ ВСЕХ (потерянный
      // update, отвалившийся разбор тела), оставил бы тест зелёным:
      // «чужое не изменилось» верно и тогда, когда не меняется вообще ничего.
      try {
        session.userId = idA;
        const mine = await taskPatch(
          request('http://t/api/task', 'PATCH', { today: DATE, taskId: task.id, done: true }),
        );
        expect(mine.status).toBe(200);
        expect((await taskOfA()).done).toBe(true);
      } finally {
        // Задача из beforeAll — общая опора нескольких проверок; возвращаем
        // её в исходное состояние, чтобы соседи не зависели от порядка.
        await sql`update tasks set done = false where id = ${task.id}`;
      }
    });

    it('правка серии по чужому правилу ничего не меняет', async () => {
      session.userId = idB;
      const response = await taskPatch(
        request('http://t/api/task', 'PATCH', {
          today: DATE, taskId: `occ:${ruleA}:${DATE}`, scope: 'series', title: 'ZZ-угнано',
        }),
      );
      expect(response.status).toBe(200);
      const [rule] = await sql`select title from recurrences where id = ${ruleA}`;
      expect(rule.title).toBe('ZZ-правило A');

      // Тот же контроль живого пути: правка своей серии обязана проходить.
      try {
        session.userId = idA;
        const mine = await taskPatch(
          request('http://t/api/task', 'PATCH', {
            today: DATE, taskId: `occ:${ruleA}:${DATE}`, scope: 'series', title: 'ZZ-правило A*',
          }),
        );
        expect(mine.status).toBe(200);
        const [renamed] = await sql`select title from recurrences where id = ${ruleA}`;
        expect(renamed.title).toBe('ZZ-правило A*');
      } finally {
        await sql`update recurrences set title = 'ZZ-правило A' where id = ${ruleA}`;
      }
    });

    it('удаление серии по чужому правилу ничего не удаляет', async () => {
      session.userId = idB;
      const response = await taskDelete(
        request('http://t/api/task', 'DELETE', {
          today: DATE, taskId: `occ:${ruleA}:${DATE}`, scope: 'series',
        }),
      );
      expect(response.status).toBe(200);
      const [rule] = await sql`select count(*)::int c from recurrences where id = ${ruleA}`;
      expect(rule.c).toBe(1);

      // Контроль живого пути. Удаляется одноразовое правило B, а не ruleA
      // и не ruleB: те — опора остальных проверок файла, а удаление серии
      // уносит каскадом и материализованные по ней задачи.
      const [temp] = await sql`
        insert into recurrences (title, weekdays, start_minute, duration_minutes, starts_on, user_id)
        values ('ZZ-правило B под удаление', ${[1]}, 600, 60, ${DATE}, ${idB}) returning id
      `;
      const mine = await taskDelete(
        request('http://t/api/task', 'DELETE', {
          today: DATE, taskId: `occ:${temp.id}:${DATE}`, scope: 'series',
        }),
      );
      expect(mine.status).toBe(200);
      const [gone] = await sql`select count(*)::int c from recurrences where id = ${temp.id}`;
      expect(gone.c).toBe(0);
    });

    it('уточнение по чужой задаче даже не доходит до разбора', async () => {
      const task = await taskOfA();
      clarify.calls = 0;

      session.userId = idB;
      const foreign = await clarifyPost(
        request('http://t/api/clarify', 'POST', {
          today: DATE, answers: [{ taskId: task.id, text: 'ZZ-в десять' }],
        }),
      );
      expect(await foreign.json()).toMatchObject({ failed: [] });
      // Сначала про саму задачу: у роута выборка и запись — два отдельных
      // запроса, и фильтр нужен обоим. Задача A заводилась на весь день,
      // времени у неё нет и появиться ему неоткуда. Спроси раньше про счётчик
      // вызовов — тест упал бы на нём и до чужого времени в строке не дошёл.
      const [untouched] = await sql`select start_minute from tasks where id = ${task.id}`;
      expect(untouched.start_minute).toBeNull();
      // Ноль вызовов — единственный признак, отличающий «не нашлось» от
      // «нашлось чужое, но правка не применилась»: ответ у них одинаковый.
      expect(clarify.calls).toBe(0);

      // Контроль на то, что подмена вообще работает и путь живой.
      session.userId = idA;
      await clarifyPost(
        request('http://t/api/clarify', 'POST', {
          today: DATE, answers: [{ taskId: task.id, text: 'ZZ-в десять' }],
        }),
      );
      expect(clarify.calls).toBe(1);
      const [after] = await sql`select start_minute from tasks where id = ${task.id}`;
      expect(after.start_minute).toBe(600);
    });

    it('ошибка Anthropic (со status) обрывает цикл уточнений, ошибка без status — нет', async () => {
      // Minor 3 финального ревью: catch раньше на любой бросок отвечал 502
      // и терял уже применённые ответы. Проверяем обе ветки на паре ответов,
      // где первый бросает, а второй должен либо не потрогаться (status
      // есть — ошибка Anthropic одна на все ответы, продолжать бессмысленно),
      // либо всё равно примениться (status нет — беда одного ответа).
      session.userId = idA;
      const [first, second] = await sql`
        insert into tasks (title, date, all_day, user_id)
        values ('ZZ-уточнение 1', ${DATE}, true, ${idA}), ('ZZ-уточнение 2', ${DATE}, true, ${idA})
        returning id
      `;
      try {
        clarify.calls = 0;
        clarify.queue = [{ status: 401 }];
        const aborted = await clarifyPost(
          request('http://t/api/clarify', 'POST', {
            today: DATE,
            answers: [
              { taskId: first.id, text: 'ZZ-в десять' },
              { taskId: second.id, text: 'ZZ-в одиннадцать' },
            ],
          }),
        );
        expect(aborted.status).toBe(502);
        // Второй ответ даже не пробовался.
        expect(clarify.calls).toBe(1);
        const [untouched] = await sql`select start_minute from tasks where id = ${second.id}`;
        expect(untouched.start_minute).toBeNull();

        clarify.calls = 0;
        clarify.queue = [{}];
        const continued = await clarifyPost(
          request('http://t/api/clarify', 'POST', {
            today: DATE,
            answers: [
              { taskId: first.id, text: 'ZZ-в десять' },
              { taskId: second.id, text: 'ZZ-в одиннадцать' },
            ],
          }),
        );
        expect(continued.status).toBe(200);
        expect(await continued.json()).toMatchObject({ failed: [first.id] });
        // Оба ответа пробовались: первый упал без status и попал в failed,
        // второй как ни в чём не бывало применился.
        expect(clarify.calls).toBe(2);
        const [applied] = await sql`select start_minute from tasks where id = ${second.id}`;
        expect(applied.start_minute).toBe(600);
      } finally {
        clarify.queue = [];
        await sql`delete from tasks where id in (${first.id}, ${second.id})`;
      }
    });

    it('уточнение переводит горизонт задачи в дневной', async () => {
      // Замечание 3 финального ревью: до правки update в этом роуте не
      // трогал horizon вовсе. Через интерфейс дыра недостижима — needsTime
      // сверяется со списком из дневного loadRange, и недельная задача
      // туда не попадает, — но taskId приходит из тела запроса и проверяется
      // только на форму и на владельца. Запрос, собранный руками против
      // собственной недельной задачи, завёл бы ровно ту осиротевшую строку,
      // которую запрещает инвариант: horizon='week' с конкретными датой
      // и временем — такая задача не нашлась бы ни сеткой (там
      // horizon='day'), ни чеклистом (там date обязана быть якорем периода).
      session.userId = idA;
      const [task] = await sql`
        insert into tasks (title, date, all_day, horizon, user_id)
        values ('ZZ-уточнение-горизонт', ${DATE}, true, 'week', ${idA})
        returning id
      `;
      try {
        const response = await clarifyPost(
          request('http://t/api/clarify', 'POST', {
            today: DATE, answers: [{ taskId: task.id, text: 'ZZ-в десять' }],
          }),
        );
        expect(response.status).toBe(200);
        const [after] = await sql`select horizon, start_minute from tasks where id = ${task.id}`;
        // Уточнённая задача получила конкретный день и час — то есть по
        // определению стала дневной, чем бы ни был горизонт до уточнения.
        expect(after.horizon).toBe('day');
        expect(after.start_minute).toBe(600);
      } finally {
        await sql`delete from tasks where id = ${task.id}`;
      }
    });

    it('без ключа роут команды отказывает до обращения к модели', async () => {
      session.userId = idA;
      await clearUserKey(idA);
      // Восстановление — в finally: упади любой expect, idA остался бы без
      // ключа до конца прогона файла, и последующие тесты упали бы вторично,
      // маскируя первопричину каскадом.
      try {
        const response = await commandPost(
          new Request('http://localhost/api/command', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'ZZ-купить хлеб', today: DATE, timezone: 'Europe/Kyiv' }),
          }),
        );
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe('no_key');
      } finally {
        await saveUserKey(idA, encryptApiKey(idA, 'sk-ant-zz-ключ-для-теста-владельцев'));
      }
    });

    it('контекст роута объединяет расписание и чеклисты', async () => {
      // Замечание ревью задачи 7: контекст собирается из loadRange и двух
      // getChecklistTasks, но этого никто не проверял автоматически. Заводим
      // недельную задачу и смотрим, что реально дошло до parseCommand —
      // и дневная задача из расписания, и недельная из чеклиста, а не только
      // то, что видно глазами в коде роута.
      session.userId = idA;
      const { batchId } = await applyOperations(idA, 'ZZ-контекст роута', [
        { ...createOp('ZZ-недельная задача A', DATE), horizon: 'week' as const },
      ]);
      try {
        const response = await commandPost(
          new Request('http://localhost/api/command', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'ZZ-убери кран', today: DATE, timezone: 'Europe/Kyiv' }),
          }),
        );
        expect(response.status).toBe(200);
        const titles = parseSpy.lastTasks?.map((t) => t.title) ?? [];
        expect(titles).toContain('ZZ-задача A');           // из loadRange
        expect(titles).toContain('ZZ-недельная задача A'); // из getChecklistTasks
      } finally {
        await undoBatch(idA, batchId);
      }
    });

    it('свежая чужая пачка не мешает отменить свою', async () => {
      // Роут отменяет только самую свежую пачку. Считать «самую свежую»
      // по всему журналу значит: пока другой отдаёт команды, отмена
      // не работает ни у кого, кроме него.
      const { batchId: batchA } = await applyOperations(idA, 'ZZ-своя пачка', [
        createOp('ZZ-своя', FOURTH),
      ]);
      const { batchId: batchB } = await applyOperations(idB, 'ZZ-чужая пачка', [
        createOp('ZZ-чужая', FOURTH),
      ]);

      session.userId = idA;
      const mine = await undoPost(
        request('http://t/api/undo', 'POST', { batchId: batchA, today: FOURTH }),
      );
      expect(await mine.json()).toMatchObject({ undone: true });

      session.userId = idB;
      const theirs = await undoPost(
        request('http://t/api/undo', 'POST', { batchId: batchB, today: FOURTH }),
      );
      expect(await theirs.json()).toMatchObject({ undone: true });
      expect(await getTasksBetween(idA, FOURTH, FOURTH)).toEqual([]);
      expect(await getTasksBetween(idB, FOURTH, FOURTH)).toEqual([]);
    });

    it('чужую пачку откатить нельзя', async () => {
      const { batchId } = await applyOperations(idA, 'ZZ-пачка под откат', [
        createOp('ZZ-не отдам', FOURTH),
      ]);
      session.userId = idB;
      const response = await undoPost(
        request('http://t/api/undo', 'POST', { batchId, today: FOURTH }),
      );
      expect(await response.json()).toMatchObject({ undone: false });
      expect((await getTasksBetween(idA, FOURTH, FOURTH)).map((t) => t.title))
        .toEqual(['ZZ-не отдам']);
    });
  });

  describe('изоляция чтения в роуте чеклиста', () => {
    // Мелочь финального ревью: единственный роут без своего теста уровня
    // роута — у остальных они есть в блоке «изоляция записи в роутах» выше.
    it('чужие задачи не отдаются', async () => {
      const [mine] = await sql`
        insert into tasks (title, date, all_day, horizon, user_id)
        values ('ZZ-чеклист-моё', ${DATE}, true, 'week', ${idA}) returning id
      `;
      const [theirs] = await sql`
        insert into tasks (title, date, all_day, horizon, user_id)
        values ('ZZ-чеклист-чужое', ${DATE}, true, 'week', ${idB}) returning id
      `;
      try {
        session.userId = idA;
        const response = await checklistGet(new Request(`http://t/api/checklist?date=${DATE}`));
        expect(response.status).toBe(200);
        const body = await response.json();
        const weekTitles = (body.week as { title: string }[]).map((t) => t.title);
        expect(weekTitles).toContain('ZZ-чеклист-моё');
        expect(weekTitles).not.toContain('ZZ-чеклист-чужое');
      } finally {
        await sql`delete from tasks where id in (${mine.id}, ${theirs.id})`;
      }
    });

    it('битая дата даёт 400', async () => {
      session.userId = idA;
      const response = await checklistGet(new Request('http://t/api/checklist?date=не-дата'));
      expect(response.status).toBe(400);
    });
  });

  describe('изоляция подписок на уведомления', () => {
    it('подписка одного не видна другому', async () => {
      const endpointA = 'https://zz.invalid/push/a';
      const endpointB = 'https://zz.invalid/push/b';
      // Уборка — в finally по всему блоку (пункт 2 разбора ревью): падение
      // на промежуточном expect не должно оставлять строку следующим тестам.
      try {
        await addSubscription(idA, { endpoint: endpointA, p256dh: 'pA', auth: 'aA' });
        await addSubscription(idB, { endpoint: endpointB, p256dh: 'pB', auth: 'aB' });
        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).toEqual([endpointA]);
        expect((await getSubscriptions(idB)).map((s) => s.endpoint)).toEqual([endpointB]);
      } finally {
        await removeSubscription(idA, endpointA);
        await removeSubscription(idB, endpointB);
      }
    });

    it('подписка с уже известного устройства переходит новому владельцу', async () => {
      // on conflict (endpoint) do update: один и тот же браузер мог раньше
      // принадлежать другому человеку. Владелец обязан смениться, а не
      // остаться прежним и не задвоиться.
      const endpoint = 'https://zz.invalid/push/shared';
      try {
        await addSubscription(idA, { endpoint, p256dh: 'p1', auth: 'a1' });
        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).toContain(endpoint);

        await addSubscription(idC, { endpoint, p256dh: 'p1', auth: 'a1' });
        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).not.toContain(endpoint);
        expect((await getSubscriptions(idC)).map((s) => s.endpoint)).toContain(endpoint);
      } finally {
        // За обоими: неизвестно, успел ли перейти владелец к моменту сбоя.
        await removeSubscription(idA, endpoint);
        await removeSubscription(idC, endpoint);
      }
    });

    it('чужие ключи не дают присвоить себе чужой endpoint', async () => {
      // Отличие от теста выше: там A и C предъявляют ОДНИ И ТЕ ЖЕ ключи —
      // легитимная смена хозяина браузера. Здесь B шлёт СВОИ ключи для
      // endpoint устройства A: endpoint не секрет, и одного его недостаточно,
      // чтобы присвоить чужую подписку. Владелец обязан остаться прежним,
      // а p256dh/auth — ключами исходного устройства: смени их на ключи B,
      // и планировщик станет шифровать задачи B под ключи A, а телефон A
      // расшифрует и покажет их как свои — ровно та утечка, что нашло ревью.
      const endpoint = 'https://zz.invalid/push/stolen';
      await addSubscription(idA, { endpoint, p256dh: 'owner-p', auth: 'owner-a' });

      // Уборка — в finally: если мутация вернёт баг и владелец сменится,
      // строка останется за B, и removeSubscription(idA, ...) её не тронет —
      // чистим за обоими, иначе утечка теста переживёт сам тест и собьёт
      // соседние (см. неудачную доставку ниже, где так и случилось при
      // мутационной проверке).
      try {
        await addSubscription(idB, { endpoint, p256dh: 'attacker-p', auth: 'attacker-a' });

        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).toContain(endpoint);
        expect((await getSubscriptions(idB)).map((s) => s.endpoint)).not.toContain(endpoint);
        const rowA = (await getSubscriptions(idA)).find((s) => s.endpoint === endpoint);
        expect(rowA).toMatchObject({ p256dh: 'owner-p', auth: 'owner-a' });
      } finally {
        await removeSubscription(idA, endpoint);
        await removeSubscription(idB, endpoint);
      }
    });

    it('совпавший p256dh не спасает при чужом auth', async () => {
      // Пин одной половины условия where по отдельности: и p256dh, и auth
      // должны совпасть оба, иначе будущий рефакторинг может тихо оставить
      // только одну проверку — а её одной достаточно, чтобы дыра вернулась.
      // B здесь узнал настоящий p256dh устройства A (в теле POST /api/push
      // он идёт открытым текстом — см. комментарий к addSubscription), но
      // auth у него свой.
      const endpoint = 'https://zz.invalid/push/half-p256dh';
      await addSubscription(idA, { endpoint, p256dh: 'shared-p', auth: 'owner-a' });

      try {
        await addSubscription(idB, { endpoint, p256dh: 'shared-p', auth: 'attacker-a' });

        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).toContain(endpoint);
        expect((await getSubscriptions(idB)).map((s) => s.endpoint)).not.toContain(endpoint);
      } finally {
        await removeSubscription(idA, endpoint);
        await removeSubscription(idB, endpoint);
      }
    });

    it('совпавший auth не спасает при чужом p256dh', async () => {
      // Симметричный пин второй половины условия.
      const endpoint = 'https://zz.invalid/push/half-auth';
      await addSubscription(idA, { endpoint, p256dh: 'owner-p', auth: 'shared-a' });

      try {
        await addSubscription(idB, { endpoint, p256dh: 'attacker-p', auth: 'shared-a' });

        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).toContain(endpoint);
        expect((await getSubscriptions(idB)).map((s) => s.endpoint)).not.toContain(endpoint);
      } finally {
        await removeSubscription(idA, endpoint);
        await removeSubscription(idB, endpoint);
      }
    });

    it('снять чужую подписку по известному endpoint не удаётся', async () => {
      // Пункт 4 брифа: единственное место в задаче, где потеря владельца в
      // условии даёт видимый вред прямо сегодня — endpoint не секрет.
      // Собственное удаление здесь — часть проверяемого поведения, а не
      // только уборка, поэтому оно и его expect остаются в try; finally —
      // страховка на случай падения до него (повторный вызов идемпотентен).
      const endpoint = 'https://zz.invalid/push/guard';
      try {
        await addSubscription(idA, { endpoint, p256dh: 'p2', auth: 'a2' });

        await removeSubscription(idB, endpoint);
        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).toContain(endpoint);

        await removeSubscription(idA, endpoint);
        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).not.toContain(endpoint);
      } finally {
        await removeSubscription(idA, endpoint);
      }
    });

    it('список для рассылки берётся из подписок, а не из "user"', async () => {
      // C заведён только в "user" (как и отвергнутые белым списком попытки
      // входа) и ни разу не подписывался — рассылать ему нечего, и его не
      // должно быть в списке, даже несмотря на строку в "user".
      const endpoint = 'https://zz.invalid/push/list';
      try {
        await addSubscription(idA, { endpoint, p256dh: 'p3', auth: 'a3' });

        const owners = await getNotifiableUsers();
        expect(owners).toContain(idA);
        expect(owners).not.toContain(idC);
      } finally {
        await removeSubscription(idA, endpoint);
      }
    });

    it('отозванный владелец исчезает из выборки, а сосед остаётся', async () => {
      const endpointA = 'https://zz.invalid/push/revoke-a';
      const endpointB = 'https://zz.invalid/push/revoke-b';
      try {
        await addSubscription(idA, { endpoint: endpointA, p256dh: 'p9', auth: 'a9' });
        await addSubscription(idB, { endpoint: endpointB, p256dh: 'p8', auth: 'a8' });

        expect(await getNotifiableUsers()).toEqual(expect.arrayContaining([idA, idB]));

        // Отзыв: адрес убирается из белого списка.
        await sql`delete from allowed_emails where email = ${B}`;

        const after = await getNotifiableUsers();
        expect(after).not.toContain(idB);
        // Сосед не задет — фильтр по адресу, а не «выключить уведомления всем».
        expect(after).toContain(idA);

        // Отзыв — не удаление: подписка отозванного осталась на месте,
        // и вернув адрес в список, он снова начнёт получать напоминания,
        // ничего не включая заново.
        const rows = await sql`select 1 from push_subscriptions where user_id = ${idB}`;
        expect(rows.length).toBe(1);
      } finally {
        await sql`
          insert into allowed_emails (email) values (${B}) on conflict (email) do nothing
        `;
        await removeSubscription(idA, endpointA);
        await removeSubscription(idB, endpointB);
      }
    });
  });

  describe('изоляция подписок в роуте push', () => {
    function pushRequest(method: string, body: unknown) {
      return new Request('http://t/api/push', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('POST сохраняет владельца из сессии', async () => {
      // Подписка B заводится первой и нарочно не убирается до проверки:
      // toEqual с ровно одним элементом красит тест и при неподключённом
      // requireUser (тогда владелец не пишется вовсе), и при потерянном
      // фильтре в getSubscriptions (тогда вернулись бы обе строки).
      const endpointA = 'https://zz.invalid/push/route-a';
      const endpointB = 'https://zz.invalid/push/route-b';
      try {
        session.userId = idB;
        await pushPost(pushRequest('POST', {
          endpoint: endpointB, keys: { p256dh: 'rpb', auth: 'rab' },
        }));

        session.userId = idA;
        const response = await pushPost(pushRequest('POST', {
          endpoint: endpointA, keys: { p256dh: 'rp', auth: 'ra' },
        }));
        expect(response.status).toBe(200);
        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).toEqual([endpointA]);
      } finally {
        await removeSubscription(idA, endpointA);
        await removeSubscription(idB, endpointB);
      }
    });

    it('DELETE не снимает чужую подписку', async () => {
      // Собственное удаление и его expect — часть проверяемого поведения,
      // остаются в try; finally — страховка на случай падения до него.
      const endpoint = 'https://zz.invalid/push/route-guard';
      try {
        session.userId = idA;
        await pushPost(pushRequest('POST', { endpoint, keys: { p256dh: 'rp2', auth: 'ra2' } }));

        session.userId = idB;
        await pushDelete(pushRequest('DELETE', { endpoint }));
        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).toContain(endpoint);

        session.userId = idA;
        await pushDelete(pushRequest('DELETE', { endpoint }));
        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).not.toContain(endpoint);
      } finally {
        await removeSubscription(idA, endpoint);
      }
    });
  });

  describe('изоляция в планировщике уведомлений', () => {
    async function insertDueTask(userId: string, title: string, date: string, startMinute: number) {
      const [row] = await sql`
        insert into tasks (title, date, start_minute, duration_minutes, all_day, user_id)
        values (${title}, ${date}, ${startMinute}, 30, false, ${userId})
        returning id
      `;
      return row.id as string;
    }

    /** Дата и минута через offset минут от «сейчас» в UTC, с переходом на завтра. */
    function inMinutes(today: string, nowMinute: number, offset: number) {
      let date = today;
      let startMinute = nowMinute + offset;
      if (startMinute >= 1440) {
        startMinute -= 1440;
        date = addDays(today, 1);
      }
      return { date, startMinute };
    }

    it('главный тест: у каждого владельца свои задачи и свои подписки — только своё и уходит', async () => {
      // Ровно то, ради чего писалась задача 5: два владельца со своими
      // задачами и своими подписками. Если цикл в роуте начнёт слать всем
      // подряд, здесь появится либо лишний вызов на чужом endpoint, либо
      // чужой заголовок в своём.
      await saveTimezone(idA, 'UTC');
      await saveTimezone(idB, 'UTC');
      // Пороги нарочно разные и в разные стороны: у A узкий (5 минут),
      // у B широкий (90). Перепутанные при чтении настройки владельца не
      // просто сдвинут окно, а уберут задачу из него — симметричный порог
      // такую подмену не заметил бы.
      await saveSettings(idA, { ...DEFAULT_SETTINGS, notifyBeforeMinutes: 5 });
      await saveSettings(idB, { ...DEFAULT_SETTINGS, notifyBeforeMinutes: 90 });

      const { today, nowMinute } = nowInZone('UTC');
      const posA = inMinutes(today, nowMinute, 3);
      const posB = inMinutes(today, nowMinute, 80);

      const taskA = await insertDueTask(idA, 'ZZ-уведомление A', posA.date, posA.startMinute);
      const taskB = await insertDueTask(idB, 'ZZ-уведомление B', posB.date, posB.startMinute);

      const endpointA = 'https://zz.invalid/push/notify-a';
      const endpointB = 'https://zz.invalid/push/notify-b';
      await addSubscription(idA, { endpoint: endpointA, p256dh: 'pna', auth: 'ana' });
      await addSubscription(idB, { endpoint: endpointB, p256dh: 'pnb', auth: 'anb' });

      // Уборка — в finally, а не последними строками тела: падение на
      // промежуточном expect иначе оставляет задачи, подписки и отметки
      // об отправке следующим тестам (см. п. 6 разбора мутаций — так уже
      // случалось и разгребалось руками).
      try {
        pushed.calls = [];
        const response = await notifyPost(new Request('http://t/api/notify', {
          method: 'POST',
          headers: { 'x-notify-secret': process.env.NOTIFY_SECRET! },
        }));
        expect(response.status).toBe(200);

        const forA = pushed.calls.filter((c) => c.endpoint === endpointA);
        const forB = pushed.calls.filter((c) => c.endpoint === endpointB);
        expect(forA).toHaveLength(1);
        expect(forB).toHaveLength(1);
        expect(JSON.parse(forA[0].payload).title).toBe('ZZ-уведомление A');
        expect(JSON.parse(forB[0].payload).title).toBe('ZZ-уведомление B');
      } finally {
        await removeSubscription(idA, endpointA);
        await removeSubscription(idB, endpointB);
        await sql`delete from tasks where id in (${taskA}, ${taskB})`;
        await sql`delete from notifications_sent where key in (${taskA}, ${taskB})`;
      }
    });

    it('неудачная доставка не помечает задачу отправленной и не трогает чужую подписку', async () => {
      await saveTimezone(idA, 'UTC');
      await saveTimezone(idB, 'UTC');
      await saveSettings(idA, { ...DEFAULT_SETTINGS, notifyBeforeMinutes: 60 });
      await saveSettings(idB, { ...DEFAULT_SETTINGS, notifyBeforeMinutes: 60 });

      const { today, nowMinute } = nowInZone('UTC');
      const pos = inMinutes(today, nowMinute, 10);

      const taskA = await insertDueTask(idA, 'ZZ-успех A', pos.date, pos.startMinute);
      const taskB = await insertDueTask(idB, 'ZZ-провал B', pos.date, pos.startMinute);

      const endpointA = 'https://zz.invalid/push/fail-a';
      const endpointB = 'https://zz.invalid/push/fail-b';
      await addSubscription(idA, { endpoint: endpointA, p256dh: 'pfa', auth: 'afa' });
      await addSubscription(idB, { endpoint: endpointB, p256dh: 'pfb', auth: 'afb' });

      // Уборка — в finally: падение на промежуточном expect не должно
      // оставлять задачи, подписку и отметку об отправке следующим тестам.
      try {
        // B «недоступен» — 410 Gone, как отозванная браузером подписка.
        pushed.calls = [];
        pushed.failWith.set(endpointB, 410);

        const response = await notifyPost(new Request('http://t/api/notify', {
          method: 'POST',
          headers: { 'x-notify-secret': process.env.NOTIFY_SECRET! },
        }));
        expect(response.status).toBe(200);

        // Пункт 5 брифа, записанное решение проекта: неудачная доставка не
        // ставит отметку — напоминание не потеряно и придёт на следующем
        // запуске. Не «чинить».
        const [sentA] = await sql`select 1 from notifications_sent where key = ${taskA}`;
        const [sentB] = await sql`select 1 from notifications_sent where key = ${taskB}`;
        expect(sentA).toBeDefined();
        expect(sentB).toBeUndefined();

        // 410 снимает ровно ту подписку, что отказала, — не соседнюю.
        expect((await getSubscriptions(idA)).map((s) => s.endpoint)).toContain(endpointA);
        expect((await getSubscriptions(idB)).map((s) => s.endpoint)).not.toContain(endpointB);
      } finally {
        pushed.failWith.delete(endpointB);
        await removeSubscription(idA, endpointA);
        // B, если пережила мутацию removeSubscription, тоже не должна утечь.
        await removeSubscription(idB, endpointB);
        await sql`delete from tasks where id in (${taskA}, ${taskB})`;
        await sql`delete from notifications_sent where key in (${taskA}, ${taskB})`;
      }
    });

    it('часовой пояс читается для текущего владельца, а не для соседнего', async () => {
      // Придуманные зоны, разнесённые на месяц в zoneOverrides, а не реальные
      // часовые пояса: перепутанный getTimezone(userId) увёл бы дату мимо
      // диапазона loadRange предсказуемо, а не в зависимости от момента
      // прогона.
      const ZONE_A = 'zz-zone-a';
      const ZONE_B = 'zz-zone-b';
      zoneOverrides.map.set(ZONE_A, { today: '2030-06-01', nowMinute: 600 });
      zoneOverrides.map.set(ZONE_B, { today: '2030-07-01', nowMinute: 600 });

      await saveTimezone(idA, ZONE_A);
      await saveTimezone(idB, ZONE_B);
      await saveSettings(idA, { ...DEFAULT_SETTINGS, notifyBeforeMinutes: 60 });
      await saveSettings(idB, { ...DEFAULT_SETTINGS, notifyBeforeMinutes: 60 });

      const taskA = await insertDueTask(idA, 'ZZ-пояс A', '2030-06-01', 605);
      const taskB = await insertDueTask(idB, 'ZZ-пояс B', '2030-07-01', 605);

      const endpointA = 'https://zz.invalid/push/zone-a';
      const endpointB = 'https://zz.invalid/push/zone-b';
      await addSubscription(idA, { endpoint: endpointA, p256dh: 'pza', auth: 'aza' });
      await addSubscription(idB, { endpoint: endpointB, p256dh: 'pzb', auth: 'azb' });

      // Уборка — в finally по той же причине, что и в двух тестах выше.
      try {
        pushed.calls = [];
        const response = await notifyPost(new Request('http://t/api/notify', {
          method: 'POST',
          headers: { 'x-notify-secret': process.env.NOTIFY_SECRET! },
        }));
        expect(response.status).toBe(200);

        const forA = pushed.calls.filter((c) => c.endpoint === endpointA);
        const forB = pushed.calls.filter((c) => c.endpoint === endpointB);
        expect(forA).toHaveLength(1);
        expect(forB).toHaveLength(1);
        expect(JSON.parse(forA[0].payload).title).toBe('ZZ-пояс A');
        expect(JSON.parse(forB[0].payload).title).toBe('ZZ-пояс B');
      } finally {
        zoneOverrides.map.delete(ZONE_A);
        zoneOverrides.map.delete(ZONE_B);
        await removeSubscription(idA, endpointA);
        await removeSubscription(idB, endpointB);
        await sql`delete from tasks where id in (${taskA}, ${taskB})`;
        await sql`delete from notifications_sent where key in (${taskA}, ${taskB})`;
      }
    });

    it('сбой у одного владельца не оставляет без уведомлений остальных', async () => {
      // Записанное решение роута: try/catch стоит ВНУТРИ тела цикла по
      // владельцам, а не снаружи него, — падение на одном не должно уносить
      // весь прогон. До сих пор это свойство не проверялось ничем: тест
      // «неудачная доставка» бьёт по внутреннему try/catch вокруг
      // sendNotification, а внешний не исполнялся ни разу.
      //
      // Ломаем не доставку, а обработку владельца целиком, и до неё:
      // мусорный пояс кладётся сырым SQL мимо saveTimezone (тот пояс не
      // проверяет — normalizeTimezone зовётся выше по стеку), и nowInZone
      // бросает RangeError в самом начале итерации, ещё до отправки.
      await saveTimezone(idA, 'UTC');
      await saveTimezone(idB, 'UTC');
      await saveSettings(idA, { ...DEFAULT_SETTINGS, notifyBeforeMinutes: 60 });
      await saveSettings(idB, { ...DEFAULT_SETTINGS, notifyBeforeMinutes: 60 });

      const { today, nowMinute } = nowInZone('UTC');
      const pos = inMinutes(today, nowMinute, 10);

      const taskA = await insertDueTask(idA, 'ZZ-сбой A', pos.date, pos.startMinute);
      const taskB = await insertDueTask(idB, 'ZZ-сбой B', pos.date, pos.startMinute);

      const endpointA = 'https://zz.invalid/push/broken-a';
      const endpointB = 'https://zz.invalid/push/broken-b';
      await addSubscription(idA, { endpoint: endpointA, p256dh: 'pba', auth: 'aba' });
      await addSubscription(idB, { endpoint: endpointB, p256dh: 'pbb', auth: 'abb' });

      // Кого ломать — не выбор, а вычисление. Порядок владельцев в роуте
      // задаёт getNotifiableUsers (select distinct, порядок строк
      // не определён), и сломать надо того, кто в ЭТОМ прогоне идёт первым:
      // сломай второго — и первый успел бы получить своё ещё до исключения,
      // а тогда тест остался бы зелёным и с try/catch снаружи цикла, то есть
      // не проверял бы ничего.
      const order = (await getNotifiableUsers())
        .filter((id) => id === idA || id === idB);
      const endpointOf: Record<string, string> = { [idA]: endpointA, [idB]: endpointB };
      const titleOf: Record<string, string> = { [idA]: 'ZZ-сбой A', [idB]: 'ZZ-сбой B' };

      // Уборка — в finally, как и в трёх тестах выше. Проверки про order —
      // тоже внутри try, хотя и стоят первыми: снаружи их падение утекло бы
      // подписками, задачами и настройками в следующие тесты.
      try {
        expect(order).toEqual(expect.arrayContaining([idA, idB]));
        expect(order).toHaveLength(2);
        const [broken, intact] = order;

        await sql`
          update user_settings set timezone = 'ZZ-not-a-timezone' where user_id = ${broken}
        `;

        pushed.calls = [];
        const response = await notifyPost(new Request('http://t/api/notify', {
          method: 'POST',
          headers: { 'x-notify-secret': process.env.NOTIFY_SECRET! },
        }));
        // Прогон в целом удался: сбой одного владельца — не пятисотка.
        expect(response.status).toBe(200);

        // У сломанного не ушло ничего — иначе исключение случилось не там,
        // где задумано, и тест проверял бы не то.
        expect(pushed.calls.filter((c) => c.endpoint === endpointOf[broken])).toHaveLength(0);

        // А второй получил своё, хотя первый упал. Это и есть проверяемое
        // свойство: перенеси try/catch наружу цикла — здесь станет ноль.
        const forIntact = pushed.calls.filter((c) => c.endpoint === endpointOf[intact]);
        expect(forIntact).toHaveLength(1);
        expect(JSON.parse(forIntact[0].payload).title).toBe(titleOf[intact]);
      } finally {
        // Пояс возвращается обоим, а не только сломанному: кого именно
        // ломали, известно внутри try, а сюда попадают и падения до этого
        // места. Лишний вызов ничего не стоит — saveTimezone не пишет, когда
        // пояс уже тот же самый.
        await saveTimezone(idA, 'UTC');
        await saveTimezone(idB, 'UTC');
        await removeSubscription(idA, endpointA);
        await removeSubscription(idB, endpointB);
        await sql`delete from tasks where id in (${taskA}, ${taskB})`;
        await sql`delete from notifications_sent where key in (${taskA}, ${taskB})`;
      }
    });
  });

  // Отдельным блоком и последним: тест засевает журнал десятками строк
  // и вычищает его у A и B, поэтому идти он должен после всех остальных.
  //
  // ⚠️ ЧИТАТЕЛЮ: этот тест сам ничего из живого журнала не удаляет, но зовёт
  // applyOperations, а тот исполняет боевой `delete from command_log`. Если
  // фильтр владельца в обрезке когда-нибудь отвалится, тест обнаружит это
  // ПОСЛЕ того, как удаление уже прошло по живой базе. Ровно так 19.08
  // и пропали 28 записей истории отмены владельца расписания —
  // восстанавливать пришлось из снятого заранее дампа.
  //
  // Защищает от этого не проверка внутри теста, а предохранитель в beforeAll
  // всего файла: обрезка идёт при КАЖДОМ вызове applyOperations, и первый
  // такой вызов случается задолго до сюда. Здесь дублировать его незачем.
  describe('обрезка журнала', () => {
    it('оставляет по пятьдесят записей каждому, а не пятьдесят на всех', async () => {
      const [before] = await sql`
        select count(*)::int c from command_log
        where user_id is distinct from ${idA} and user_id is distinct from ${idB}
      `;

      await sql`delete from command_log where user_id in (${idA}, ${idB})`;
      // Засеваем напрямую: пятьдесят вызовов applyOperations — это пятьдесят
      // транзакций к боевой базе. created_at в далёком прошлом не для красоты:
      // сломай фильтр, и под глобальную обрезку первыми пойдут именно эти
      // строки, а живой журнал владельца расписания останется целым.
      await sql`
        insert into command_log (text, operations, snapshot, created_at, user_id)
        select 'ZZ-журнал A', '[]'::jsonb,
               '{"tasks":[],"recurrences":[],"exceptions":[]}'::jsonb,
               timestamptz '2020-01-01 00:00:00+00' + (n * interval '1 minute'), ${idA}
        from generate_series(1, 51) as n
      `;
      await sql`
        insert into command_log (text, operations, snapshot, created_at, user_id)
        values ('ZZ-журнал B', '[]'::jsonb,
                '{"tasks":[],"recurrences":[],"exceptions":[]}'::jsonb,
                timestamptz '2019-01-01 00:00:00+00', ${idB})
      `;

      const { batchId } = await applyOperations(idA, 'ZZ-обрезка', [
        createOp('ZZ-после обрезки', FOURTH),
      ]);

      const [mine] = await sql`select count(*)::int c from command_log where user_id = ${idA}`;
      expect(mine.c).toBe(50);
      // Самая старая запись во всём журнале — и всё равно не тронута:
      // чужая история отмены не вытесняется чужой активностью.
      const [theirs] = await sql`select count(*)::int c from command_log where user_id = ${idB}`;
      expect(theirs.c).toBe(1);
      // Свежая пачка обязана уцелеть — иначе отменять было бы нечего.
      const [kept] = await sql`select count(*)::int c from command_log where id = ${batchId}`;
      expect(kept.c).toBe(1);

      const [after] = await sql`
        select count(*)::int c from command_log
        where user_id is distinct from ${idA} and user_id is distinct from ${idB}
      `;
      expect(after.c).toBe(before.c);
    });
  });

  describe('снимки недель', () => {
    const WEEK = '2030-03-04';   // понедельник

    afterEach(async () => {
      await sql`delete from week_snapshots where user_id in (${idA}, ${idB})`;
    });

    it('сохраняет и читает снимок', async () => {
      await saveWeekSnapshot(idA, WEEK, [{ id: 'zz-1', title: 'ZZ-Кран' }]);
      const snapshot = await getWeekSnapshot(idA, WEEK);
      expect(snapshot?.planned).toEqual([{ id: 'zz-1', title: 'ZZ-Кран' }]);
      expect(snapshot?.reportedAt).toBeNull();
    });

    it('чужой снимок не читается', async () => {
      // Тот же рубеж, что и во всех остальных запросах после второго
      // подпроекта: без where по владельцу сосед увидел бы чужой отчёт.
      await saveWeekSnapshot(idB, WEEK, [{ id: 'zz-2', title: 'ZZ-Соседа' }]);
      expect(await getWeekSnapshot(idA, WEEK)).toBeNull();
    });

    it('повторное сохранение снимок не плодит и не затирает', async () => {
      // Планировщик стучится раз в минуту: второй вызов в тот же понедельник
      // обязан быть безобидным, иначе снимок «намерения» будет переписываться
      // весь день и перестанет быть намерением.
      await saveWeekSnapshot(idA, WEEK, [{ id: 'zz-1', title: 'ZZ-Первый' }]);
      await saveWeekSnapshot(idA, WEEK, [{ id: 'zz-9', title: 'ZZ-Второй' }]);
      const rows = await sql`select planned from week_snapshots where user_id = ${idA}`;
      expect(rows.length).toBe(1);
      expect(rows[0].planned).toEqual([{ id: 'zz-1', title: 'ZZ-Первый' }]);
    });

    it('отчёт сохраняется и проставляет отметку отправки', async () => {
      await saveWeekSnapshot(idA, WEEK, []);
      await saveReport(idA, WEEK, {
        done: [{ id: 'zz-1', title: 'ZZ-Кран' }],
        notDone: [], postponed: [], removed: [], extra: [], monthLeft: [],
      });
      const snapshot = await getWeekSnapshot(idA, WEEK);
      expect(snapshot?.report?.done).toEqual([{ id: 'zz-1', title: 'ZZ-Кран' }]);
      expect(snapshot?.reportedAt).not.toBeNull();
    });

    it('последний отчёт отдаётся с указанием недели', async () => {
      await saveWeekSnapshot(idA, '2030-02-25', []);
      await saveReport(idA, '2030-02-25', {
        done: [], notDone: [], postponed: [], removed: [], extra: [], monthLeft: [],
      });
      await saveWeekSnapshot(idA, WEEK, []);   // свежая неделя, отчёта ещё нет
      const latest = await getLatestReport(idA);
      // Свежая неделя без отчёта не должна перебивать прошлую с отчётом:
      // иначе экран пустел бы каждый понедельник до момента отправки.
      expect(latest?.weekStart).toBe('2030-02-25');
    });

    it('нет отчётов — нет и последнего', async () => {
      await saveWeekSnapshot(idA, WEEK, []);
      expect(await getLatestReport(idA)).toBeNull();
    });
  });
});
