import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from './db';
import { getUserEmailById, isEmailAllowed, revokeSessions } from './allowed-emails';

// Адреса на .invalid — домен зарезервирован стандартом и не может
// принадлежать настоящему человеку. Префикс zz- чтобы отличать от живых.
const ALLOWED = 'zz-allowed@example.invalid';
const STRANGER = 'zz-stranger@example.invalid';

// Как в lib/db.test.ts, lib/apply.test.ts и lib/ownership.test.ts: без
// строки подключения файл пропускается, а не падает на первом же запросе.
// Без этого гейта `npx vitest run` без окружения (документированный в
// README режим — только тесты чистых функций) валил четыре теста здесь.
//
// Гейт оборачивает файл целиком, одним внешним run, а не каждый describe
// по отдельности: afterAll ниже сам обращается к sql (delete и sql.end()),
// и если бы он остался вне гейта, то выполнялся бы и без строки подключения —
// именно та ошибка, от которой этот гейт защищает.
const run = process.env.DATABASE_URL ? describe : describe.skip;

run('allowed-emails', () => {
  afterAll(async () => {
    // Только свои строки, по точному адресу. В этой таблице лежит боевой
    // белый список: delete без условий закрыл бы вход владельцу.
    await sql`delete from allowed_emails where email in (${ALLOWED}, ${STRANGER})`;
    await sql.end();
  });

  describe('isEmailAllowed', () => {
    it('пускает адрес из списка', async () => {
      await sql`insert into allowed_emails (email) values (${ALLOWED}) on conflict do nothing`;
      expect(await isEmailAllowed(ALLOWED)).toBe(true);
    });

    it('не пускает адрес не из списка', async () => {
      expect(await isEmailAllowed(STRANGER)).toBe(false);
    });

    it('не зависит от регистра пришедшего адреса', async () => {
      await sql`insert into allowed_emails (email) values (${ALLOWED}) on conflict do nothing`;
      expect(await isEmailAllowed('ZZ-Allowed@Example.Invalid')).toBe(true);
    });

    it('не пускает пустую строку', async () => {
      expect(await isEmailAllowed('')).toBe(false);
    });
  });

  describe('getUserEmailById', () => {
    it('отдаёт null на неизвестный идентификатор', async () => {
      expect(await getUserEmailById('zz-no-such-user')).toBeNull();
    });
  });

  describe('revokeSessions', () => {
    const OWNER = 'zz-revoke-owner@example.invalid';
    const NEIGHBOUR = 'zz-revoke-neighbour@example.invalid';

    // Сессии Better Auth: колонки в camelCase, поэтому кавычки обязательны.
    async function makeSession(userId: string, token: string) {
      await sql`
        insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
        values (${token}, now() + interval '30 days', ${token}, now(), now(), ${userId})
      `;
    }

    async function countSessions(userId: string) {
      const rows = await sql`select 1 from session where "userId" = ${userId}`;
      return rows.length;
    }

    beforeAll(async () => {
      for (const id of [OWNER, NEIGHBOUR]) {
        await sql`
          insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
          values (${id}, ${id}, ${id}, false, now(), now())
          on conflict (id) do nothing
        `;
      }
    });

    afterAll(async () => {
      // Адресно и до удаления пользователей — явно, а не в расчёте на
      // каскад: session."userId" объявлен on delete cascade (миграция 0003)
      // и снял бы эти строки сам. Явное удаление здесь не потому, что без
      // него внешний ключ не даст удалить пользователей, — порядок ради
      // наглядности.
      await sql`delete from session where "userId" in (${OWNER}, ${NEIGHBOUR})`;
      await sql`delete from "user" where id in (${OWNER}, ${NEIGHBOUR})`;
    });

    it('снимает все сессии владельца и не трогает чужие', async () => {
      // Две сессии у одного человека — это два устройства. Отзыв обязан
      // накрыть оба: он по адресу, а не по браузеру.
      await makeSession(OWNER, 'zz-token-owner-1');
      await makeSession(OWNER, 'zz-token-owner-2');
      await makeSession(NEIGHBOUR, 'zz-token-neighbour');

      expect(await revokeSessions(OWNER)).toBe(2);

      expect(await countSessions(OWNER)).toBe(0);
      // Главное утверждение теста: удаление адресное. Без where по userId
      // здесь остался бы ноль, и тест бы это поймал.
      expect(await countSessions(NEIGHBOUR)).toBe(1);
    });

    it('на владельце без сессий возвращает 0 и не падает', async () => {
      expect(await revokeSessions('zz-revoke-никого@example.invalid')).toBe(0);
    });
  });
});
