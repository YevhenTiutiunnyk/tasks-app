import { afterAll, describe, expect, it } from 'vitest';
import { sql } from './db';
import { getUserEmailById, isEmailAllowed } from './allowed-emails';

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
});
