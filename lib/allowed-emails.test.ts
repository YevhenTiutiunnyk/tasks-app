import { afterAll, describe, expect, it } from 'vitest';
import { sql } from './db';
import { getUserEmailById, isEmailAllowed } from './allowed-emails';

// Адреса на .invalid — домен зарезервирован стандартом и не может
// принадлежать настоящему человеку. Префикс zz- чтобы отличать от живых.
const ALLOWED = 'zz-allowed@example.invalid';
const STRANGER = 'zz-stranger@example.invalid';

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
