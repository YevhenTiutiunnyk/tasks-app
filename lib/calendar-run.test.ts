import { expect, test } from 'vitest';
import { CalendarAccessLost, CalendarGone, SyncTokenExpired, type CalendarClient, type ListEventsParams } from './google-api';
import {
  copyWindow, needsFullSync, syncCalendar, syncManyUsers, syncUser, syncWindow, type CalendarDeps,
} from './calendar-run';
import type { CalendarRow } from './db';
import type { CalendarEvent } from './types';

const TODAY = '2026-09-08';

function calendar(patch: Partial<CalendarRow> = {}): CalendarRow {
  return {
    calendarId: 'primary', summary: 'ZZ', selected: true, syncToken: 'tok-1',
    windowStart: '2026-08-08', windowEnd: '2026-12-08',
    syncedAt: '2026-09-08T09:00:00.000Z', brokenAt: null, ...patch,
  };
}

/**
 * `order` и `calls` — не для одного теста, а общий журнал: несколько находок
 * ревью («сохранили токен раньше времени», «переставили очистку и загрузку»,
 * «pageToken потерялся по дороге») были бы неотличимы от правильного
 * поведения, если бы поддельные зависимости помнили только итоговые суммы.
 * `deleteEvents` вдобавок раньше игнорировал calendarId в записи — адресность
 * удаления в чужой календарь была бы попросту нечем поймать.
 */
function deps(client: Partial<CalendarClient>, calendars: CalendarRow[] = [calendar()]) {
  const state = {
    upserted: [] as CalendarEvent[],
    deleted: [] as string[],
    replaced: [] as { calendarId: string; events: CalendarEvent[] }[],
    saved: [] as Parameters<CalendarDeps['saveSyncState']>[2][],
    calls: [] as { calendarId: string; params: ListEventsParams }[],
    order: [] as string[],
  };
  const listEvents = client.listEvents ?? (async () => ({ events: [], nextPageToken: null, nextSyncToken: null }));
  const full: CalendarDeps = {
    getCalendars: async () => calendars,
    saveSyncState: async (_u, _c, s) => { state.saved.push(s); state.order.push('saveSyncState'); },
    upsertEvents: async (_u, events) => { state.upserted.push(...events); state.order.push('upsertEvents'); },
    deleteEvents: async (_u, calendarId, ids) => {
      state.deleted.push(...ids.map((id) => `${calendarId}:${id}`));
      state.order.push('deleteEvents');
    },
    replaceCalendarEvents: async (_u, calendarId, events) => {
      state.replaced.push({ calendarId, events });
      state.order.push('replaceCalendarEvents');
    },
    clientFor: async () => ({
      listCalendars: async () => [],
      listEvents: async (calendarId, params) => {
        state.calls.push({ calendarId, params });
        state.order.push('listEvents');
        return listEvents(calendarId, params);
      },
      // Запись в Google — не дело синхронизации чужих календарей: она только
      // читает. Заглушки бросают, а не молчат, чтобы случайный вызов отсюда
      // был виден сразу, а не выглядел удачной записью в пустоту.
      createCalendar: async () => { throw new Error('синхронизация не пишет в Google'); },
      deleteCalendar: async () => { throw new Error('синхронизация не пишет в Google'); },
      insertEvent: async () => { throw new Error('синхронизация не пишет в Google'); },
      patchEvent: async () => { throw new Error('синхронизация не пишет в Google'); },
      deleteEvent: async () => { throw new Error('синхронизация не пишет в Google'); },
    }),
    ownerEmail: async () => 'zz-owner@example.invalid',
  };
  return { deps: full, state };
}

test('окно — месяц назад и три вперёд', () => {
  const window = syncWindow(TODAY);
  expect(window.from).toBe('2026-08-08T00:00:00.000Z');
  expect(window.to).toBe('2026-12-08T00:00:00.000Z');
});

test('без токена нужна полная загрузка, со свежим окном — нет', () => {
  expect(needsFullSync(calendar({ syncToken: null }), TODAY)).toBe(true);
  expect(needsFullSync(calendar(), TODAY)).toBe(false);
  // Окно уехало: конец ближе, чем через два месяца.
  expect(needsFullSync(calendar({ windowEnd: '2026-10-01' }), TODAY)).toBe(true);
});

test('страницы дочитываются до конца, pageToken передаётся дальше, токен сохраняется одной записью после обхода', async () => {
  const pages = [
    { events: [{ id: 'a', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-1', start: { dateTime: '2026-09-09T10:00:00Z' }, end: { dateTime: '2026-09-09T11:00:00Z' } }], nextPageToken: 'p2', nextSyncToken: null },
    { events: [{ id: 'b', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-2', start: { dateTime: '2026-09-09T12:00:00Z' }, end: { dateTime: '2026-09-09T13:00:00Z' } }], nextPageToken: null, nextSyncToken: 'tok-2' },
  ];
  let call = 0;
  const { deps: d, state } = deps({ listEvents: async () => pages[call++] });
  await syncCalendar(d, 'zz-user', calendar(), TODAY);
  expect(state.upserted.map((event) => event.eventId)).toEqual(['a', 'b']);
  // Мутация «сохранить токен внутри цикла страниц» дала бы 2 записи вместо 1.
  expect(state.saved.length).toBe(1);
  expect(state.saved.at(-1)!.syncToken).toBe('tok-2');
  // Мутация «pageToken не передаётся дальше» дала бы [undefined, undefined].
  expect(state.calls.map((c) => c.params.pageToken)).toEqual([undefined, 'p2']);
});

test('отменённое и отклонённое удаляются из своего календаря', async () => {
  const { deps: d, state } = deps({
    listEvents: async () => ({
      events: [
        { id: 'gone', status: 'cancelled', updated: '2026-09-08T10:00:00.000Z' },
        { id: 'free', transparency: 'transparent', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-др', start: { date: '2026-09-09' }, end: { date: '2026-09-10' } },
      ],
      nextPageToken: null, nextSyncToken: 'tok-2',
    }),
  });
  await syncCalendar(d, 'zz-user', calendar(), TODAY);
  // Адрес входит в саму запись — мутация «удаление ушло в чужой calendarId»
  // была бы неотличима от правильного поведения, если бы мок его не помнил.
  expect(state.deleted.sort()).toEqual(['primary:free', 'primary:gone']);
  expect(state.upserted).toEqual([]);
});

test('инкрементальная синхронизация не запускает полную перезагрузку, когда токен и окно свежие', async () => {
  const { deps: d, state } = deps({
    listEvents: async () => ({ events: [], nextPageToken: null, nextSyncToken: 'tok-2' }),
  });
  await syncCalendar(d, 'zz-user', calendar(), TODAY);
  // Мутация «run(needsFullSync(...)) → run(true)» перевела бы запрос на
  // timeMin/timeMax и увела бы запись в replaceCalendarEvents.
  expect(state.calls[0].params.syncToken).toBe('tok-1');
  expect(state.calls[0].params.timeMin).toBeUndefined();
  expect(state.replaced).toEqual([]);
  expect(state.saved.at(-1)!.windowStart).toBeUndefined();
});

test('полная перезагрузка сначала докачивает все страницы и лишь потом заменяет копию одной операцией', async () => {
  const pages = [
    { events: [{ id: 'a', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-1', start: { dateTime: '2026-09-09T10:00:00Z' }, end: { dateTime: '2026-09-09T11:00:00Z' } }], nextPageToken: 'p2', nextSyncToken: null },
    { events: [{ id: 'b', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-2', start: { dateTime: '2026-09-09T12:00:00Z' }, end: { dateTime: '2026-09-09T13:00:00Z' } }], nextPageToken: null, nextSyncToken: 'tok-full' },
  ];
  let call = 0;
  const { deps: d, state } = deps({ listEvents: async () => pages[call++] });
  await syncCalendar(d, 'zz-user', calendar({ syncToken: null }), TODAY);
  // Порядок — сама суть исправления: обе страницы читаются ДО единственной
  // замены. Старая перестановка «очистить, потом качать» дала бы
  // replaceCalendarEvents (или clearCalendarEvents) первым элементом.
  expect(state.order).toEqual(['listEvents', 'listEvents', 'replaceCalendarEvents', 'saveSyncState']);
  expect(state.replaced.length).toBe(1);
  expect(state.replaced[0].calendarId).toBe('primary');
  expect(state.replaced[0].events.map((event) => event.eventId).sort()).toEqual(['a', 'b']);
  expect(state.upserted).toEqual([]);
  expect(state.saved.at(-1)!.windowStart).toBe('2026-08-08');
  expect(state.saved.at(-1)!.windowEnd).toBe('2026-12-08');
});

test('протухший токен приводит к полной перезагрузке, а не к остановке', async () => {
  let first = true;
  const { deps: d, state } = deps({
    listEvents: async (_id, params) => {
      if (first && params.syncToken) { first = false; throw new SyncTokenExpired(); }
      return { events: [], nextPageToken: null, nextSyncToken: 'tok-new' };
    },
  });
  await syncCalendar(d, 'zz-user', calendar(), TODAY);
  expect(state.replaced.length).toBe(1);
  expect(state.saved.at(-1)!.syncToken).toBe('tok-new');
});

test('протухший токен посреди постраничного обхода тоже уходит в полную перезагрузку', async () => {
  let call = 0;
  const { deps: d, state } = deps({
    listEvents: async () => {
      call += 1;
      if (call === 1) {
        return {
          events: [{ id: 'a', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-1', start: { dateTime: '2026-09-09T10:00:00Z' }, end: { dateTime: '2026-09-09T11:00:00Z' } }],
          nextPageToken: 'p2', nextSyncToken: null,
        };
      }
      if (call === 2) throw new SyncTokenExpired();
      return {
        events: [{ id: 'z', updated: '2026-09-08T10:00:00.000Z', summary: 'ZZ-full', start: { dateTime: '2026-09-09T14:00:00Z' }, end: { dateTime: '2026-09-09T15:00:00Z' } }],
        nextPageToken: null, nextSyncToken: 'tok-full',
      };
    },
  });
  await syncCalendar(d, 'zz-user', calendar(), TODAY);
  // Первая (успевшая) страница инкрементального обхода уже попала в копию —
  // это ожидаемо и безвредно: полная перезагрузка ниже заменит копию целиком.
  expect(state.upserted.map((event) => event.eventId)).toEqual(['a']);
  expect(state.replaced.length).toBe(1);
  expect(state.replaced[0].events.map((event) => event.eventId)).toEqual(['z']);
  expect(state.saved.at(-1)!.syncToken).toBe('tok-full');
});

test('потеря доступа помечает связь сломанной', async () => {
  const { deps: d, state } = deps({ listEvents: async () => { throw new CalendarAccessLost(); } });
  await expect(syncCalendar(d, 'zz-user', calendar(), TODAY)).rejects.toBeInstanceOf(CalendarAccessLost);
  expect(state.saved.at(-1)!.brokenAt).not.toBeNull();
});

test('отказ второй попытки после протухшего токена тоже помечает связь сломанной', async () => {
  let attempt = 0;
  const { deps: d, state } = deps({
    listEvents: async () => {
      attempt += 1;
      if (attempt === 1) throw new SyncTokenExpired();
      throw new CalendarAccessLost();
    },
  });
  // Раньше run(true) вызывался внутри того же catch, и его собственный отказ
  // улетал бы наружу мимо обработки — brokenAt не выставлялся бы никогда.
  await expect(syncCalendar(d, 'zz-user', calendar(), TODAY)).rejects.toBeInstanceOf(CalendarAccessLost);
  expect(state.saved.at(-1)!.brokenAt).not.toBeNull();
});

test('C2: доступ теряется уже при получении клиента — до всякого обхода страниц', async () => {
  // getCalendarClient (deps.clientFor) бросает CalendarAccessLost ровно
  // тогда, когда человек отозвал доступ в настройках своего аккаунта
  // Google. Раньше clientFor/ownerEmail вызывались ДО try — этот отказ
  // улетал бы мимо обработчика ниже, пометка не появлялась бы вовсе,
  // а планировщик ходил бы в Google каждую минуту вечно (находка C2
  // финального ревью).
  const state: { saved: Parameters<CalendarDeps['saveSyncState']>[2][] } = { saved: [] };
  const brokenClientDeps: CalendarDeps = {
    getCalendars: async () => [calendar()],
    saveSyncState: async (_u, _c, s) => { state.saved.push(s); },
    upsertEvents: async () => {},
    deleteEvents: async () => {},
    replaceCalendarEvents: async () => {},
    clientFor: async () => { throw new CalendarAccessLost(); },
    ownerEmail: async () => 'zz-owner@example.invalid',
  };
  await expect(syncCalendar(brokenClientDeps, 'zz-user', calendar(), TODAY))
    .rejects.toBeInstanceOf(CalendarAccessLost);
  expect(state.saved.at(-1)!.brokenAt).not.toBeNull();
});

test('успешная синхронизация снимает отметку сломанной связи', async () => {
  const { deps: d, state } = deps({
    listEvents: async () => ({ events: [], nextPageToken: null, nextSyncToken: 'tok-2' }),
  });
  await syncCalendar(d, 'zz-user', calendar({ brokenAt: '2026-09-01T00:00:00.000Z' }), TODAY);
  expect(state.saved.at(-1)!.brokenAt).toBeNull();
});

test('застрявший pageToken обрывает обход отказом, а не тихим успехом (инкрементальная ветка)', async () => {
  let calls = 0;
  const { deps: d, state } = deps({
    listEvents: async () => {
      calls += 1;
      return { events: [], nextPageToken: 'stuck', nextSyncToken: 'tok-stuck' };
    },
  });
  // Раньше повтор токена обрывал цикл через break и код доходил до обычного
  // успешного пути: инкрементальная ветка сохранила бы 'tok-stuck', как будто
  // всё дочитано, и по-настоящему недочитанные изменения потерялись бы
  // навсегда. Прерванный обход обязан кончаться отказом, а не успехом.
  await expect(syncCalendar(d, 'zz-user', calendar(), TODAY)).rejects.toThrow();
  // Первый ответ ещё продвигает обход (prev был undefined), второй его
  // повторяет — обрыв обязан случиться именно на нём.
  expect(calls).toBe(2);
  // Токен не тронут (это не «доступ потерян», а свой предохранитель), но
  // кулдаун обязан взвестись — иначе застрявший календарь дёргался бы на
  // каждом минутном тике планировщика (находка I3 финального ревью).
  expect(state.saved).toEqual([{ syncToken: 'tok-1' }]);
});

test('застрявший pageToken при полной перезагрузке не стирает старую копию', async () => {
  let calls = 0;
  const { deps: d, state } = deps({
    listEvents: async () => {
      calls += 1;
      return { events: [], nextPageToken: 'stuck', nextSyncToken: null };
    },
  });
  // Тот же обрыв, но в ветке полной перезагрузки: раньше break доводил бы код
  // до replaceCalendarEvents с тем немногим, что успели набрать (пустым
  // списком в этом сценарии), — и стирал бы копию целиком. Именно этот путь
  // воспроизвёл ревьюер: та же пустая неделя, что чинили в Critical, только
  // через другую дверь.
  await expect(syncCalendar(d, 'zz-user', calendar({ syncToken: null }), TODAY)).rejects.toThrow();
  expect(calls).toBe(2);
  expect(state.replaced).toEqual([]);
  // Кулдаун взводится и здесь — тот же предохранитель, что и у инкрементальной
  // ветки. Токен у этого календаря изначально null, и таким остаётся.
  expect(state.saved).toEqual([{ syncToken: null }]);
});

test('транзиентный сбой (не 401/403 и не 410) не помечает связь сломанной, но взводит кулдаун', async () => {
  // «Погода, а не беда»: 500 у Google, обрыв сети — sync_token трогать
  // нельзя, пробуем тем же токеном в следующий раз. Но раньше в этом случае
  // saveSyncState не вызывался вовсе, и synced_at не обновлялся: отказавший
  // календарь дёргался планировщиком на каждом минутном тике вместо одного
  // раза в SYNC_INTERVAL_MS — измерено ревьюером: три обращения за три
  // минуты вместо одного (находка I3 финального ревью).
  const { deps: d, state } = deps({
    listEvents: async () => { throw new Error('Google ответил 500'); },
  });
  await expect(syncCalendar(d, 'zz-user', calendar(), TODAY)).rejects.toThrow('Google ответил 500');
  expect(state.saved).toEqual([{ syncToken: 'tok-1' }]);
});

test('обход останавливается по потолку страниц, даже если pageToken каждый раз новый', async () => {
  let calls = 0;
  const { deps: d } = deps({
    listEvents: async () => {
      calls += 1;
      return { events: [], nextPageToken: `p${calls}`, nextSyncToken: null };
    },
  });
  await expect(syncCalendar(d, 'zz-user', calendar(), TODAY)).rejects.toThrow();
  expect(calls).toBe(100);
});

test('syncUser пропускает невыбранные, сломанные и свежие календари', async () => {
  const now = new Date('2026-09-08T09:03:00.000Z');
  const { deps: d } = deps({}, [
    calendar({ calendarId: 'a', selected: false }),
    calendar({ calendarId: 'b', brokenAt: '2026-09-08T08:00:00.000Z' }),
    calendar({ calendarId: 'c', syncedAt: '2026-09-08T09:01:00.000Z' }), // 2 минуты назад
  ]);
  expect(await syncUser(d, 'zz-user', TODAY, now)).toEqual({ synced: 0, failed: 0 });
});

test('syncUser синхронизирует нужные календари и не останавливается на сбое одного из них', async () => {
  const now = new Date('2026-09-08T09:10:00.000Z'); // 10 минут — уже пора всем троим
  const seen: string[] = [];
  const { deps: d } = deps(
    {
      listEvents: async (calendarId) => {
        seen.push(calendarId);
        if (calendarId === 'bad') throw new CalendarAccessLost();
        return { events: [], nextPageToken: null, nextSyncToken: 'tok-x' };
      },
    },
    [calendar({ calendarId: 'a' }), calendar({ calendarId: 'bad' }), calendar({ calendarId: 'c' })],
  );
  const result = await syncUser(d, 'zz-user', TODAY, now);
  expect(result).toEqual({ synced: 2, failed: 1 });
  // Сбой на 'bad' не должен был остановить обход раньше 'c'.
  expect(seen).toEqual(['a', 'bad', 'c']);
});

test('copyWindow: null, когда ни один выбранный календарь не знает своего окна', () => {
  // Не подключено вовсе — пустой список.
  expect(copyWindow([])).toBeNull();
  // Подключено, но выбранный календарь ещё не прошёл первую синхронизацию.
  expect(copyWindow([calendar({ windowStart: null, windowEnd: null })])).toBeNull();
  // Календарь с известным окном есть, но он не выбран — не в счёт.
  expect(copyWindow([calendar({ selected: false })])).toBeNull();
});

test('copyWindow: пересечение окон нескольких выбранных календарей', () => {
  const a = calendar({ calendarId: 'a', windowStart: '2026-08-08', windowEnd: '2026-12-08' });
  const b = calendar({ calendarId: 'b', windowStart: '2026-09-01', windowEnd: '2026-11-01' });
  // Невыбранный календарь с более широким окном не должен расширить пересечение.
  const c = calendar({ calendarId: 'c', selected: false, windowStart: '2026-01-01', windowEnd: '2027-01-01' });
  expect(copyWindow([a, b, c])).toEqual({ start: '2026-09-01', end: '2026-11-01' });
});

test('syncManyUsers останавливается по бюджету времени, а не по счётчику владельцев', async () => {
  const now = new Date('2026-09-08T09:10:00.000Z');
  // Поддельный секундомер: каждый настоящий поход за событиями «стоит»
  // 5 секунд. Часы — не Date.now(), а управляемый счётчик: тест не должен
  // гоняться с настоящим временем.
  let clock = 1_000_000;
  const { deps: d, state } = deps({
    listEvents: async () => {
      clock += 5000;
      return { events: [], nextPageToken: null, nextSyncToken: 'tok-x' };
    },
  });
  const users = [
    { userId: 'u1', today: TODAY },
    { userId: 'u2', today: TODAY },
    { userId: 'u3', today: TODAY },
  ];
  // Бюджет 8с: первый укладывается (0с), второй тоже успевает начаться
  // (5с ещё меньше 8с), а после него набегает 10с — третий бюджет уже
  // не застаёт и не должен даже начинаться.
  const result = await syncManyUsers(d, users, now, 8000, () => clock);
  expect(result).toEqual({ synced: 2, failed: 0, skipped: 1 });
  expect(state.calls.length).toBe(2);
});

// Ветка 404 → CalendarGone добавлена в общую call ради записи, но через ту же
// call ходят и чтения. Раньше 404 при чтении был обычной Error и уводил
// в кулдаун; так обязано остаться: пометка «связь сломана» выключает
// календарь до ручного похода в настройки, а исчезнувший календарь — это
// не потеря доступа.
test('исчезнувший календарь (CalendarGone) не помечает связь сломанной', async () => {
  const { deps: d, state } = deps({ listEvents: async () => { throw new CalendarGone(); } });
  await expect(syncCalendar(d, 'zz-user', calendar(), TODAY)).rejects.toBeInstanceOf(CalendarGone);
  expect(state.saved.at(-1)!.brokenAt).toBeUndefined();
});
