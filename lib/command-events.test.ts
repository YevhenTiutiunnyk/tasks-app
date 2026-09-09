import { afterEach, expect, test, vi } from 'vitest';

// Проверяем ровно то, из-за чего был баг: сбой чтения календаря не должен
// отклонять промис наружу. Раньше getTimezone/getEventsBetween сидели прямо
// в Promise.all роута вместе с обязательными для разбора фразы данными —
// исключение из них вылетало бы раньше try/catch вокруг parseCommand,
// и клиент получал бы голый 500 вместо разобранной фразы (ревью задачи 11,
// Important-1). Подменяем './db' целиком, чтобы не поднимать реальную базу.

const db = vi.hoisted(() => ({
  getTimezone: vi.fn(),
  getEventsBetween: vi.fn(),
}));
vi.mock('./db', () => db);

const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  vi.clearAllMocks();
});

test('сбой чтения встреч не отклоняет промис — возвращает пустой список', async () => {
  const { loadEventsForCommand } = await import('./command-events');
  db.getTimezone.mockRejectedValue(new Error('ZZ-нет связи с базой'));
  db.getEventsBetween.mockResolvedValue([]);

  await expect(loadEventsForCommand('user-1', '2026-09-01', '2026-09-30')).resolves.toEqual([]);
});

test('сбой чтения событий (а не пояса) тоже гасится и не роняет вызов', async () => {
  const { loadEventsForCommand } = await import('./command-events');
  db.getTimezone.mockResolvedValue('Europe/Kyiv');
  db.getEventsBetween.mockRejectedValue(new Error('ZZ-истёк токен Google'));

  await expect(loadEventsForCommand('user-1', '2026-09-01', '2026-09-30')).resolves.toEqual([]);
});

test('в лог при сбое попадает только стадия — без объекта ошибки, id или адресов', async () => {
  const { loadEventsForCommand } = await import('./command-events');
  db.getTimezone.mockRejectedValue(new Error('ZZ-секретный-адрес@example.com'));
  db.getEventsBetween.mockResolvedValue([]);

  await loadEventsForCommand('user-1', '2026-09-01', '2026-09-30');

  expect(errorSpy).toHaveBeenCalledTimes(1);
  const loggedArgs = errorSpy.mock.calls[0];
  expect(loggedArgs).toHaveLength(1);
  expect(loggedArgs[0]).not.toMatch(/ZZ-|user-1|example\.com/);
});

test('без сбоя отдаёт события как обычно', async () => {
  const { loadEventsForCommand } = await import('./command-events');
  db.getTimezone.mockResolvedValue('Europe/Kyiv');
  db.getEventsBetween.mockResolvedValue([
    {
      calendarId: 'primary', eventId: 'e1', title: 'ZZ-созвон',
      startsAt: '2026-09-09T09:00:00.000Z', endsAt: '2026-09-09T10:00:00.000Z',
      allDay: false, mine: true, organizerEmail: null, googleUpdatedAt: '2026-09-01T00:00:00.000Z',
    },
  ]);

  const events = await loadEventsForCommand('user-1', '2026-09-08', '2026-09-10');
  expect(events).toHaveLength(1);
  expect(events[0].title).toBe('ZZ-созвон');
});
